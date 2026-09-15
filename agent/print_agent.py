#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""AntiPrint 本机打印代理（Windows）。

职责：常驻轮询服务端 → 原子领取打印任务 → 下载文件 → 调用 SumatraPDF
（或系统默认关联程序）静默打印 → 回报结果。

用法示例：
    python print_agent.py               常驻运行（默认）
    python print_agent.py --once        只跑一轮：心跳 → 领取 → 打印并回报，然后退出
    python print_agent.py --dry-run     只记录将要执行的打印命令，不真的打印
    python print_agent.py --printers    列出本机打印机名后退出
    python print_agent.py --selftest    自检：读配置 + 连通服务端 + 枚举打印机，退出码 0/1

注意事项（本项目已知坑）：
    1. 用 pythonw.exe 常驻运行时 sys.stdout / sys.stderr 为 None，日志必须判空后再加
       StreamHandler，否则启动即崩。
    2. 唯一的真实打印机出纸不可逆，因此必须单实例运行（agent.lock），避免重复打印。
    3. 打印子进程必须带 CREATE_NO_WINDOW，否则会反复闪黑窗。
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path

import requests

try:
    import msvcrt
except ImportError:  # 非 Windows 平台（仅便于在开发机上做语法/逻辑检查）
    msvcrt = None


# ---------------------------------------------------------------- 常量

VERSION = "1.0.0"

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG_PATH = BASE_DIR / "config.json"
LOG_DIR = BASE_DIR / "log"
LOG_FILE = LOG_DIR / "agent.log"
TMP_DIR = BASE_DIR / "tmp"
LOCK_FILE = BASE_DIR / "agent.lock"

LOG_MAX_BYTES = 1024 * 1024  # 1MB
LOG_BACKUP_COUNT = 3

# Windows 专有：子进程不弹控制台窗口；非 Windows 传 0
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

# SumatraPDF 不在 PATH 里，按这几处常见位置探测（每台机器路径不同，见 find_sumatra）
SUMATRA_SEARCH_DIRS = (
    r"C:\Program Files\SumatraPDF",
    r"C:\Program Files (x86)\SumatraPDF",
)

HEARTBEAT_INTERVAL = 30  # 心跳间隔（秒），轮询周期内按时间戳判断
PRINT_TIMEOUT = 90  # 单个文件打印超时（秒）
HTTP_TIMEOUT = 20  # 单次 HTTP 请求超时（秒）
MAX_RETRIES = 3  # 网络异常最多重试 3 次
RETRY_DELAYS = (1, 2, 4)  # 指数退避（秒）
PRINTER_CMD_TIMEOUT = 30  # 打印机枚举超时（秒）
ERROR_TEXT_LIMIT = 300  # 回报给服务端的错误摘要上限（字）

DEFAULT_CONFIG = {
    "server": "http://127.0.0.1:8301",
    "agent_token": "",
    "name": "print-agent-1",
    "launcher": "sumatra",
    "printer_name": "default",
    "copies": 1,
    "dry_run": False,
    "poll_interval": 5,
    "sumatra_path": "",  # 留空 = 自动查找（见 find_sumatra）
}

LOG = logging.getLogger("antiprint.agent")


# ---------------------------------------------------------------- 日志 / 小工具


def setup_logging(console: bool = True) -> None:
    """日志写 agent/log/agent.log（1MB × 3 轮转），同时输出到控制台。"""
    if LOG.handlers:
        return
    LOG.setLevel(logging.INFO)
    LOG.propagate = False
    formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", "%Y-%m-%d %H:%M:%S")

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    file_handler = RotatingFileHandler(
        str(LOG_FILE), maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUP_COUNT, encoding="utf-8"
    )
    file_handler.setFormatter(formatter)
    LOG.addHandler(file_handler)

    # pythonw 下 sys.stdout / sys.stderr 为 None，必须先判空
    stream = sys.stderr if sys.stderr is not None else sys.stdout
    if console and stream is not None:
        stream_handler = logging.StreamHandler(stream)
        stream_handler.setFormatter(formatter)
        LOG.addHandler(stream_handler)

    logging.getLogger("urllib3").setLevel(logging.WARNING)


def emit(message: str, level: int = logging.INFO) -> None:
    """写日志；有控制台时同时打印（pythonw 下 stdout 为 None，不能直接 print）。"""
    LOG.log(level, message)
    if sys.stdout is not None:
        try:
            print(message)
        except Exception:  # 控制台编码异常不应影响代理运行
            pass


def decode_output(data: bytes) -> str:
    """子进程输出解码：优先 UTF-8，其次 GBK，最后按替换字符兜底。"""
    if not data:
        return ""
    for encoding in ("utf-8", "gbk"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def truncate(text: str, limit: int = ERROR_TEXT_LIMIT) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit] + "…（已截断）"


# ---------------------------------------------------------------- 单实例锁


def acquire_single_instance_lock():
    """尝试独占 agent.lock；已被占用时返回 None（避免两个代理同时打印导致重复出纸）。"""
    if msvcrt is None:
        LOG.warning("非 Windows 平台，跳过单实例锁（仅开发调试场景可用）")
        return None
    try:
        handle = open(LOCK_FILE, "a+", encoding="utf-8")
    except OSError as exc:
        emit("无法打开单实例锁文件 %s：%s" % (LOCK_FILE, exc), logging.ERROR)
        return None
    try:
        handle.seek(0)
        if not handle.read(1):  # msvcrt.locking 需要文件里至少有 1 个字节
            handle.write("0")
            handle.flush()
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        handle.close()
        return None
    try:
        handle.seek(0)
        handle.write("pid=%d\n" % os.getpid())
        handle.flush()
    except OSError:
        pass
    return handle


def release_single_instance_lock(handle) -> None:
    if handle is None:
        return
    try:
        handle.seek(0)
        if msvcrt is not None:
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    except OSError:
        pass
    finally:
        try:
            handle.close()
        except OSError:
            pass


# ---------------------------------------------------------------- 打印机枚举


def list_printers() -> list[str]:
    """用 PowerShell Get-Printer 枚举本机打印机名（不依赖 pywin32）。失败返回空列表。"""
    if os.name != "nt":
        LOG.warning("非 Windows 平台，无法枚举打印机")
        return []
    command = [
        "powershell",
        "-NoProfile",
        "-Command",
        "Get-Printer | Select-Object -ExpandProperty Name",
    ]
    try:
        proc = subprocess.run(
            command,
            capture_output=True,
            timeout=PRINTER_CMD_TIMEOUT,
            creationflags=CREATE_NO_WINDOW,
        )
    except subprocess.TimeoutExpired:
        LOG.warning("枚举打印机超时（超过 %d 秒）", PRINTER_CMD_TIMEOUT)
        return []
    except OSError as exc:
        LOG.warning("枚举打印机失败（无法启动 powershell）：%s", exc)
        return []

    if proc.returncode != 0:
        LOG.warning(
            "枚举打印机失败（退出码 %s）：%s",
            proc.returncode,
            truncate(decode_output(proc.stderr)),
        )
        return []

    printers: list[str] = []
    for line in decode_output(proc.stdout).splitlines():
        name = line.strip()
        if name and name not in printers:
            printers.append(name)
    if not printers:
        LOG.warning("未枚举到任何打印机（检查打印机是否已安装/在线）")
    return printers


def find_sumatra(configured: str = "") -> str:
    """查找 SumatraPDF：配置路径 → %LOCALAPPDATA%\\SumatraPDF → Program Files → PATH。

    返回完整路径；找不到返回空串（调用方给出中文提示）。分发包要装到别人的电脑上，
    所以不能写死某一台机器的路径。
    """
    candidates = [str(configured or "").strip()]
    local_appdata = os.environ.get("LOCALAPPDATA")
    if local_appdata:
        candidates.append(str(Path(local_appdata) / "SumatraPDF" / "SumatraPDF.exe"))
    candidates += [str(Path(folder) / "SumatraPDF.exe") for folder in SUMATRA_SEARCH_DIRS]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    return shutil.which("SumatraPDF") or shutil.which("SumatraPDF.exe") or ""


# ---------------------------------------------------------------- 配置


class ConfigError(Exception):
    """配置读取/校验失败。"""


class PrintError(Exception):
    """打印阶段的可回报错误。"""


def load_config(path: str) -> dict:
    """读取 config.json 并与默认值合并；文件不存在时给出中文提示。"""
    config_path = Path(path).expanduser()
    if not config_path.is_file():
        raise ConfigError(
            "未找到配置文件 %s，请先复制 config.example.json 为 config.json 并填写令牌" % config_path
        )
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise ConfigError("配置文件 %s 解析失败：%s" % (config_path, exc)) from exc
    if not isinstance(raw, dict):
        raise ConfigError("配置文件 %s 格式错误：顶层必须是 JSON 对象" % config_path)

    cfg = dict(DEFAULT_CONFIG)
    cfg.update({k: v for k, v in raw.items() if v is not None})

    cfg["server"] = str(cfg.get("server") or "").strip().rstrip("/")
    if not cfg["server"]:
        raise ConfigError("配置缺少 server（服务端地址，例如 http://127.0.0.1:8301）")
    cfg["agent_token"] = str(cfg.get("agent_token") or "").strip()
    if not cfg["agent_token"]:
        raise ConfigError("配置缺少 agent_token，请在服务端管理页复制令牌后填入 %s" % config_path)
    if not str(cfg.get("name") or "").strip():
        cfg["name"] = socket.gethostname() or "print-agent-1"
    try:
        cfg["poll_interval"] = max(1, int(cfg.get("poll_interval") or 5))
    except (TypeError, ValueError):
        cfg["poll_interval"] = 5
    return cfg


# ---------------------------------------------------------------- 代理主体


def truthy(value) -> bool:
    """把服务端下发的开关值（可能是 '0'/'1'/'true'/'false' 字符串）解析成布尔。

    注意：不能用 bool('0')——Python 里非空字符串恒为真，会把「关闭」误判成「开启」。
    """
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in ("1", "true", "yes", "on")


class PrintAgent:
    """轮询、领取、下载、打印、回报。单线程顺序执行。"""

    def __init__(self, cfg: dict, dry_run: bool = False):
        self.cfg = cfg
        self.server = cfg["server"]
        self.force_dry_run = bool(dry_run)  # 来自命令行，优先级最高
        self.printers: list[str] = []
        self.remote_config: dict = {}  # 服务端心跳下发的打印配置（断网时用本机 config.json 兜底）
        self.session = requests.Session()
        self.session.headers.update({"X-Agent-Token": cfg["agent_token"]})
        self._last_remote_repr = None
        # 是否已被管理员在管理页断开：只用于日志降噪（断开期间继续轮询，重连后自动恢复）
        self.blocked = False

    def _note_blocked(self, exc: Exception) -> bool:
        """服务端返回 403（管理员断开了代理连接）时记一条日志并返回 True；重复出现不再刷屏"""
        response = getattr(exc, "response", None)
        if response is None or response.status_code != 403:
            return False
        if not self.blocked:
            self.blocked = True
            LOG.warning(
                "已被管理员断开连接：%s（本机代理会继续轮询，管理员在「管理设置」重新连接后自动恢复）",
                truncate(response.text),
            )
        return True

    def _note_resumed(self) -> None:
        if self.blocked:
            self.blocked = False
            LOG.info("打印代理已恢复连接，继续领取任务")

    # ---------- HTTP ----------

    def _request(self, method: str, url: str, **kwargs):
        """带重试的请求：网络异常或 5xx 时最多重试 MAX_RETRIES 次，指数退避 1/2/4 秒。"""
        kwargs.setdefault("timeout", HTTP_TIMEOUT)
        last_error = None
        for attempt in range(MAX_RETRIES + 1):
            try:
                response = self.session.request(method, url, **kwargs)
            except requests.RequestException as exc:
                last_error = exc
            else:
                if response.status_code < 500:
                    return response
                last_error = requests.HTTPError("服务端返回 %s" % response.status_code, response=response)
            if attempt < MAX_RETRIES:
                delay = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]
                LOG.warning(
                    "请求异常（%s %s）：%s；%s 秒后重试（第 %d/%d 次）",
                    method,
                    url,
                    last_error,
                    delay,
                    attempt + 1,
                    MAX_RETRIES,
                )
                time.sleep(delay)
        raise last_error

    def _post_json(self, path: str, payload: dict) -> dict:
        response = self._request("POST", self.server + path, json=payload)
        if response.status_code >= 400:
            raise requests.HTTPError(
                "服务端返回 %s：%s" % (response.status_code, truncate(response.text)), response=response
            )
        try:
            return response.json()
        except ValueError as exc:
            raise requests.RequestException("服务端响应不是合法 JSON：%s" % truncate(response.text)) from exc

    def _device_payload(self) -> dict:
        return {
            "name": self.cfg["name"],
            "version": VERSION,
            "printers": self.printers,
            "launcher": self.effective("launcher"),
        }

    # ---------- 配置取值 ----------

    def effective(self, key: str):
        """服务端下发的配置优先，其次本机 config.json。"""
        value = self.remote_config.get(key)
        if value is None or value == "":
            value = self.cfg.get(key)
        return value

    def dry_run_now(self) -> bool:
        if self.force_dry_run:
            return True
        return truthy(self.effective("dry_run"))

    # ---------- 服务端接口 ----------

    def register(self) -> bool:
        try:
            data = self._post_json("/api/agent/register", self._device_payload())
        except Exception as exc:
            LOG.warning("注册失败：%s（代理仍会继续心跳）", exc)
            return False
        agent = data.get("agent") or {}
        LOG.info("注册成功：代理 #%s（%s）", agent.get("id"), agent.get("name") or self.cfg["name"])
        return True

    def heartbeat(self) -> bool:
        printers = list_printers()
        if printers:
            self.printers = printers
        try:
            data = self._post_json("/api/agent/heartbeat", self._device_payload())
        except Exception as exc:
            if not self._note_blocked(exc):
                LOG.warning("心跳失败：%s（下个周期重试）", exc)
            return False
        self._note_resumed()
        remote = data.get("config") or {}
        if isinstance(remote, dict):
            self.remote_config = remote
            shown = repr(sorted(remote.items()))
            if remote and shown != self._last_remote_repr:
                self._last_remote_repr = shown
                LOG.info(
                    "服务端配置：launcher=%s，printer_name=%s，copies=%s，dry_run=%s",
                    remote.get("launcher"),
                    remote.get("printer_name"),
                    remote.get("copies"),
                    remote.get("dry_run"),
                )
        return True

    def claim(self):
        try:
            data = self._post_json("/api/agent/claim", {})
        except requests.HTTPError as exc:
            # 被管理员断开时只记一次（否则每 5 秒一条异常堆栈刷屏）；其它错误照常提示
            if not self._note_blocked(exc):
                raise
            return None
        self._note_resumed()
        job = data.get("job")
        return job if isinstance(job, dict) and job.get("id") is not None else None

    def download_file(self, job_id, file_info: dict) -> Path:
        """下载任务文件到 agent/tmp/<job_id>/<filename>；同名文件直接覆盖。

        Office（Word/PPT）服务端下发的是转换后的 PDF，落盘名取 print_name（后缀 .pdf）——
        否则 SumatraPDF 会按 .docx/.pptx 后缀拒绝打印。
        """
        file_id = file_info.get("id")
        raw_name = str(file_info.get("print_name") or file_info.get("filename") or "").replace("\\", "/")
        filename = os.path.basename(raw_name) or "file_%s" % file_id
        dest_dir = TMP_DIR / str(job_id)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / filename

        url = "%s/api/agent/jobs/%s/files/%s" % (self.server, job_id, file_id)
        response = self._request("GET", url, stream=True)
        if response.status_code >= 400:
            raise requests.HTTPError(
                "下载文件失败，服务端返回 %s" % response.status_code, response=response
            )
        written = 0
        with open(dest, "wb") as fh:
            for chunk in response.iter_content(chunk_size=64 * 1024):
                if chunk:
                    fh.write(chunk)
                    written += len(chunk)
        LOG.info("已下载文件 %s（%d 字节）", dest, written)
        return dest

    def report(self, job_id, ok: bool, error: str | None = None) -> bool:
        """回报结果。

        注意：网络长期不通时重试 MAX_RETRIES 次后只能记日志放弃，
        任务会停留在「打印中」，需在管理页手动重试/重置——这是已知限制。
        """
        payload = {"ok": bool(ok), "error": None if ok else truncate(error or "未知错误")}
        try:
            data = self._post_json("/api/agent/jobs/%s/result" % job_id, payload)
        except Exception as exc:
            LOG.error("回报任务 #%s 结果失败：%s", job_id, exc)
            LOG.error(
                "已重试 %d 次仍无法回报：任务 #%s 可能停留在「打印中」，"
                "需在管理页手动重试或让管理员重置状态（代理侧无法挽回）",
                MAX_RETRIES,
                job_id,
            )
            return False
        LOG.info("已回报任务 #%s：%s（服务端状态：%s）", job_id, "成功" if ok else "失败", data.get("status"))
        return True

    # ---------- 打印 ----------

    @staticmethod
    def build_print_settings(copies: int, options: dict) -> str:
        """把任务里的打印设置拼成 SumatraPDF `-print-settings` 的参数串。

        顺序：份数 → 纸张 → 页面范围 → 每面页数 → 缩放。
        注：目标机型是黑白激光、无自动双面单元，因此不支持双面/彩色（2026-09-15 移除）。
        取值都是提交页白名单里的 SumatraPDF 原生 token（服务端已校验），这里只做拼装。
        """
        options = options or {}
        parts = []
        if int(copies or 1) > 1:
            parts.append("%dx" % int(copies))
        paper = str(options.get("paper") or "")
        if paper:
            parts.append("paper=%s" % paper)
        pages = str(options.get("pages") or "").strip()
        if pages:
            parts.append(pages)
        nup = str(options.get("nup") or "")
        if nup and nup != "1,1":
            parts.append(nup)
        scale = str(options.get("scale") or "")
        if scale:
            parts.append(scale)
        return ",".join(parts)

    def build_sumatra_command(
        self, file_path: Path, printer_name: str, copies: int, options: dict | None = None
    ) -> list[str]:
        """拼 SumatraPDF 静默打印命令（份数与打印设置统一走 -print-settings）。"""
        exe = find_sumatra(self.cfg.get("sumatra_path"))
        if not exe:
            raise PrintError(
                "未找到 SumatraPDF，请先安装（https://www.sumatrapdfreader.org/），"
                "或在 config.json 的 sumatra_path 里填写完整路径"
            )

        command = [exe]
        if printer_name and printer_name.strip().lower() != "default":
            command += ["-print-to", printer_name.strip()]
        else:
            command += ["-print-to-default"]
        command += ["-silent", "-exit-when-done"]
        settings = self.build_print_settings(copies, options or {})
        if settings:
            # 追加在文件路径之前，避免 SumatraPDF 把选项误当成文件名
            command += ["-print-settings", settings]
        command.append(str(file_path))
        return command

    def print_file(self, file_path: Path, copies: int, options: dict | None = None) -> tuple[bool, str | None]:
        """打印单个文件；返回 (是否成功, 中文错误信息)。"""
        launcher = str(self.effective("launcher") or "sumatra").strip().lower()
        printer_name = str(self.effective("printer_name") or "").strip()
        dry_run = self.dry_run_now()
        if launcher not in ("sumatra", "default"):
            LOG.warning("未知启动器 launcher=%s，回退为 sumatra", launcher)
            launcher = "sumatra"

        if launcher == "default":
            # 兜底方案：系统默认关联程序打印（os.startfile）。会弹出关联程序窗口、
            # 非静默，且无法拿到退出码，只在本机没装 SumatraPDF 时使用。
            if dry_run:
                LOG.info("[DRY-RUN] 将调用系统默认关联程序打印（os.startfile print）：%s", file_path)
                return True, None
            if not hasattr(os, "startfile"):
                return False, "当前平台不支持 os.startfile，无法用系统默认程序打印"
            try:
                os.startfile(str(file_path), "print")
            except OSError as exc:
                return False, "调用系统默认关联程序打印失败：%s" % exc
            LOG.info("已交给系统默认关联程序打印：%s（无法获取退出码）", file_path)
            return True, None

        try:
            command = self.build_sumatra_command(file_path, printer_name, copies, options)
        except PrintError as exc:
            LOG.error("%s", exc)
            return False, str(exc)

        settings_text = self.build_print_settings(copies, options or {})
        if settings_text:
            LOG.info("应用打印设置：%s", settings_text)
        LOG.info("打印命令：%s", subprocess.list2cmdline(command))
        if dry_run:
            LOG.info("[DRY-RUN] 未实际打印：%s", file_path)
            return True, None

        try:
            proc = subprocess.run(
                command,
                capture_output=True,
                timeout=PRINT_TIMEOUT,
                creationflags=CREATE_NO_WINDOW,
            )
        except subprocess.TimeoutExpired:
            LOG.error("打印超时（超过 %d 秒）：%s", PRINT_TIMEOUT, file_path)
            return False, "打印超时（超过 %d 秒）" % PRINT_TIMEOUT
        except OSError as exc:
            return False, "启动 SumatraPDF 失败：%s" % exc

        # 注意：退出码 0 并不等同于真的出纸（缺纸/离线队列可能仍返回 0），
        # 必要时用 Get-PrintJob 复核队列。
        if proc.returncode != 0:
            detail = decode_output(proc.stderr) or decode_output(proc.stdout)
            message = "SumatraPDF 退出码 %s：%s" % (proc.returncode, truncate(detail) or "无输出")
            LOG.error("%s", message)
            return False, message
        LOG.info("打印完成：%s", file_path)
        return True, None

    # ---------- 任务处理 ----------

    def process_job(self, job: dict) -> None:
        job_id = job.get("id")
        files = job.get("files") or []
        if not files:
            LOG.error("任务 #%s 没有可打印文件", job_id)
            self.report(job_id, False, "任务没有可打印文件")
            return

        options = job.get("print_options") or {}
        try:
            copies = int(job.get("copies") or options.get("copies") or self.effective("copies") or 1)
        except (TypeError, ValueError):
            copies = 1
        copies = max(1, copies)

        LOG.info("已领取任务 #%s（文件 %d 个）", job_id, len(files))
        LOG.info(
            "任务 #%s 详情：份数 %d，配送地址：%s，备注：%s",
            job_id,
            copies,
            job.get("address") or "未填写",
            job.get("note") or "无",
        )

        for index, file_info in enumerate(files, 1):
            filename = file_info.get("filename") or file_info.get("id")
            try:
                local_path = self.download_file(job_id, file_info)
            except Exception as exc:
                message = "下载文件 %s 失败：%s" % (filename, exc)
                LOG.error("%s", message)
                self.report(job_id, False, message)
                return

            # 每个文件可以有各自的打印设置：文件级 → 任务级 → 全局默认
            file_options = file_info.get("print_options") or options or {}
            try:
                file_copies = int(
                    file_options.get("copies") or file_info.get("copies") or copies or 1
                )
            except (TypeError, ValueError):
                file_copies = copies

            LOG.info("正在打印 %d/%d：%s（份数 %d）", index, len(files), filename, file_copies)
            ok, error = self.print_file(local_path, file_copies, file_options)
            if not ok:
                self.report(job_id, False, "%s：%s" % (filename, error))
                return

        self.report(job_id, True, None)

    # ---------- 运行模式 ----------

    def run_once(self) -> bool:
        """只跑一轮：心跳 → 领取 → 有任务则打印并回报。返回值表示这一轮是否正常完成。"""
        if not self.heartbeat():
            LOG.error("心跳失败，本轮中止（检查服务端地址与网络）")
            return False
        job = self.claim()
        if not job:
            LOG.info("本轮没有待打印任务")
            return True
        self.process_job(job)
        return True

    def run_forever(self) -> None:
        """常驻轮询：每 poll_interval 秒领取一次，heartbeat 每 30 秒一次。"""
        self.register()
        last_heartbeat = time.monotonic()
        self.heartbeat()
        interval = int(self.cfg.get("poll_interval") or 5)
        LOG.info("进入轮询循环（每 %d 秒领取一次任务）", interval)
        while True:
            try:
                if time.monotonic() - last_heartbeat >= HEARTBEAT_INTERVAL:
                    self.heartbeat()
                    last_heartbeat = time.monotonic()
                job = self.claim()
                if job:
                    self.process_job(job)
            except Exception as exc:  # 单轮异常不能拖垮常驻进程
                LOG.error("轮询出现异常：%s", exc, exc_info=True)
            time.sleep(interval)


# ---------------------------------------------------------------- 自检


def selftest(config_path: str) -> int:
    """自检：读配置 → 枚举打印机 → 注册/心跳 → 查 SumatraPDF。全部通过返回 0，否则 1。"""
    try:
        cfg = load_config(config_path)
    except ConfigError as exc:
        emit("自检失败：%s" % exc, logging.ERROR)
        return 1

    emit("自检 1/4 配置读取：OK（名称=%s，服务端=%s，启动器=%s，打印机=%s，份数=%s）"
         % (cfg["name"], cfg["server"], cfg.get("launcher"), cfg.get("printer_name"), cfg.get("copies")))

    printers = list_printers()
    if printers:
        emit("自检 2/4 打印机枚举：OK（共 %d 台：%s）" % (len(printers), "、".join(printers)))
    else:
        emit("自检 2/4 打印机枚举：警告，未枚举到打印机（代理仍可运行，但可能无法出纸）", logging.WARNING)

    agent = PrintAgent(cfg)
    agent.printers = printers
    agent.register()  # 失败只记警告，不影响自检结论
    if agent.heartbeat():
        emit("自检 3/4 服务端心跳：OK（%s/api/agent/heartbeat）" % cfg["server"])
    else:
        emit("自检 3/4 服务端心跳：失败（检查服务端是否启动、令牌是否正确）", logging.ERROR)
        return 1

    # 最后查 SumatraPDF：缺了就直接判失败，否则「自检通过」但一张纸也打不出来
    launcher = str(agent.effective("launcher") or "sumatra").strip().lower()
    sumatra = find_sumatra(cfg.get("sumatra_path"))
    if launcher == "default":
        emit("自检 4/4 SumatraPDF：跳过（启动器=系统默认关联程序，不需要 SumatraPDF）")
    elif sumatra:
        emit("自检 4/4 SumatraPDF：OK（%s）" % sumatra)
    else:
        emit("自检 4/4 SumatraPDF：未找到 —— 请先安装 SumatraPDF"
             "（https://www.sumatrapdfreader.org/），或在 config.json 的 sumatra_path 里填完整路径",
             logging.ERROR)
        return 1

    emit("自检通过。dry_run=%s" % cfg.get("dry_run"))
    return 0


# ---------------------------------------------------------------- 入口


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="AntiPrint 本机打印代理：轮询服务端并静默打印任务",
    )
    parser.add_argument(
        "--config",
        default=str(DEFAULT_CONFIG_PATH),
        help="配置文件路径（默认：脚本同目录 config.json）",
    )
    parser.add_argument("--once", action="store_true", help="只跑一轮：心跳 → 领取 → 打印并回报，然后退出")
    parser.add_argument("--dry-run", action="store_true", help="只记录将要执行的打印命令，不真的打印")
    parser.add_argument("--printers", action="store_true", help="列出本机打印机名后退出")
    parser.add_argument("--selftest", action="store_true", help="自检：读配置 + 连通服务端 + 枚举打印机")
    parser.add_argument("--version", action="version", version="AntiPrint 打印代理 %s" % VERSION)
    return parser


def main(argv=None) -> int:
    setup_logging()
    args = build_parser().parse_args(argv)

    if args.printers:
        printers = list_printers()
        if printers:
            emit("本机打印机（%d 台）：" % len(printers))
            for name in printers:
                emit("  - %s" % name)
        else:
            emit("未枚举到打印机", logging.WARNING)
        return 0 if printers else 1

    if args.selftest:
        return selftest(args.config)

    try:
        cfg = load_config(args.config)
    except ConfigError as exc:
        emit("启动失败：%s" % exc, logging.ERROR)
        return 1

    lock = acquire_single_instance_lock()
    if msvcrt is not None and lock is None:
        emit("检测到已有打印代理在运行（%s 被占用），本次启动退出，避免重复出纸。" % LOCK_FILE, logging.ERROR)
        return 1

    agent = PrintAgent(cfg, dry_run=args.dry_run)
    try:
        LOG.info(
            "打印代理启动（名称=%s，版本=%s，服务端=%s，launcher=%s，printer_name=%s，copies=%s，dry_run=%s，"
            "配置文件=%s）",
            cfg["name"],
            VERSION,
            cfg["server"],
            agent.effective("launcher"),
            agent.effective("printer_name"),
            agent.effective("copies"),
            agent.dry_run_now(),
            args.config,
        )
        if args.once:
            return 0 if agent.run_once() else 1
        agent.run_forever()
    except KeyboardInterrupt:
        LOG.info("收到中断信号，代理退出")
    finally:
        release_single_instance_lock(lock)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        LOG.info("收到中断信号，代理退出")
        sys.exit(0)
    except Exception:
        LOG.exception("代理异常退出")
        sys.exit(1)
