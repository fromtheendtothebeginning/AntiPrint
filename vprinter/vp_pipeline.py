# vp_pipeline.py — 核心流水线：收件 → 转成 PDF → 提交到网站 → 归档
#
# 数据来源有两处（见 vp_config.watch_targets）：
#   Windows：驱动把 PDF 写在固定文件里（spool 端口），这里按「修改时间 + 大小」稳定后复制走；
#   macOS/Linux：CUPS 后端把打印数据写进收件目录（job-*.pdf/.ps + 同名 .json 元数据），直接取走。
# 取走后的文件一律先进 inbox/，处理完再进 sent/ 或 failed/，出问题一眼能看到是卡在哪一段。

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from vp_api import ApiError, Client
from vp_config import (
    CONFIG_DIR,
    FAILED_DIR,
    INBOX_DIR,
    LOG,
    SENT_DIR,
    VERSION,
    push_recent,
    watch_targets,
)

STABLE_SECONDS = 1.5      # 文件不再变化这么久才算写完（Windows 驱动是边写边落的）
POLL_INTERVAL = 1.0       # 扫描间隔（秒）
MIN_AGE_SECONDS = 0.4     # 文件刚出现时再等等，避免读到半个文件
MAX_ATTEMPTS = 3          # 网络类失败的重试次数
RETRY_DELAYS = (1, 2, 4)  # 指数退避（秒）
CONVERT_TIMEOUT = 120     # PS/其它格式转 PDF 的超时（秒）
SPOOL_STATE_FILE = CONFIG_DIR / "spool_state.json"

PDF_NAME_RE = re.compile(r"[\\/:*?\"<>|\r\n\t]+")
MAX_NAME_LEN = 80


class ConvertError(Exception):
    """拿到的打印数据既不是 PDF，也没能转成 PDF"""


@dataclass
class Result:
    ok: bool
    path: Path
    message: str
    job_id: int = 0
    charge: str = ""
    balance: str = ""


# ---------------------------------------------------------------- PDF 小工具

def is_pdf(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return handle.read(5) == b"%PDF-"
    except OSError:
        return False


def sanitize_name(name: str) -> str:
    """打印任务名变成文件名：去掉路径与非法字符，长度收敛"""
    base = PDF_NAME_RE.sub("_", (name or "").strip()).strip(" ._")
    if not base:
        return ""
    return base[:MAX_NAME_LEN]


def pdf_title(path: Path) -> str:
    """尽力从 PDF 的 /Title 里取文档名（取不到返回空串）——让上传的文件名好看一点"""
    try:
        raw = path.read_bytes()[: 512 * 1024]
    except OSError:
        return ""
    index = raw.rfind(b"/Title")
    if index < 0:
        return ""
    chunk = raw[index: index + 400]
    hex_match = re.search(rb"<([0-9A-Fa-f\s]{4,})>", chunk)
    lit_match = re.search(rb"\((.{1,200}?)\)", chunk, re.S)
    try:
        if hex_match:
            text = bytes.fromhex(re.sub(rb"\s", b"", hex_match.group(1)).decode("ascii"))
        elif lit_match:
            text = lit_match.group(1).replace(b"\\(", b"(").replace(b"\\)", b")")
        else:
            return ""
    except ValueError:
        return ""
    if text.startswith(b"\xfe\xff"):
        return text[2:].decode("utf-16-be", "ignore").strip()
    if text.startswith(b"\xff\xfe"):
        return text[2:].decode("utf-16-le", "ignore").strip()
    return text.decode("utf-8", "ignore").strip()


def _converters() -> list[list[str]]:
    """PS/其它格式 → PDF 的转换器候选（有哪个用哪个；都没有就报错让用户装 Ghostscript）"""
    return [
        ["gs", "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pdfwrite"],
        ["ps2pdf"],
        ["/usr/sbin/cupsfilter", "-m", "application/pdf"],
        ["/System/Library/Printers/Libraries/convert", "-t", "pdf"],
    ]


def to_pdf(path: Path, workdir: Path) -> Path:
    """确保拿到的是 PDF：本身就是 PDF 直接返回，PostScript / 其它格式交给转换器"""
    if is_pdf(path):
        return path
    try:
        head = path.read_bytes()[:16]
    except OSError as exc:
        raise ConvertError(f"读取打印数据失败：{exc}") from exc
    workdir.mkdir(parents=True, exist_ok=True)
    out = workdir / (path.stem + ".pdf")
    errors: list[str] = []
    for template in _converters():
        tool = shutil.which(template[0]) or (template[0] if Path(template[0]).exists() else None)
        if not tool:
            continue
        # 按「去掉扩展名的小写名字」判分支：Windows 上 which 回来的是 ps2pdf.EXE，
        # 拿 name 跟 "ps2pdf" 比会落进最后那条 macOS convert 分支，命令行变成
        # `ps2pdf in.ps -o out.pdf` —— ps2pdf 把 -o 当输出文件名，于是**当前目录**里
        # 多出一个叫 `-o` 的文件、真正的输出反而没生成（2026-09-16 实测踩到）。
        tool_name = Path(tool).stem.lower()
        cmd = [tool] + template[1:]
        if tool_name == "gs":
            cmd += [f"-sOutputFile={out}", str(path)]
        elif tool_name == "ps2pdf":
            cmd += [str(path), str(out)]
        elif "cupsfilter" in tool_name:
            cmd += [str(path)]
        else:      # macOS convert 工具
            cmd += [str(path), "-o", str(out)]
        try:
            if "cupsfilter" in tool_name:
                # cupsfilter 把 PDF 写到标准输出
                with out.open("wb") as handle:
                    done = subprocess.run(
                        cmd, stdout=handle, stderr=subprocess.PIPE, timeout=CONVERT_TIMEOUT,
                        creationflags=_no_window(),
                    )
            else:
                done = subprocess.run(
                    cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=CONVERT_TIMEOUT,
                    creationflags=_no_window(),
                )
        except (OSError, subprocess.TimeoutExpired) as exc:
            errors.append(f"{tool_name}: {exc}")
            continue
        if done.returncode == 0 and out.exists() and is_pdf(out):
            LOG.info("已用 %s 把 %s 转成 PDF", tool_name, path.name)
            return out
        if done.returncode != 0:
            reason = f"退出码 {done.returncode} {(done.stderr or b'')[:120]!r}"
        elif not out.exists():
            reason = "没有生成文件（这个转换器可能只是个包装器，指向 gs 的路径没配好）"
        else:
            reason = "输出不是 PDF"
        errors.append(f"{tool_name}: {reason}")
    detail = "；".join(errors) or "本机没有可用的转换器（gs / ps2pdf / cupsfilter）"
    raise ConvertError(
        f"打印数据不是 PDF（前 4 字节 {head[:4]!r}）且转换失败：{detail}。"
        "请安装 Ghostscript，或改用「Microsoft Print to PDF」类型的打印队列。"
    )


def _no_window() -> int:
    return 0x08000000 if os.name == "nt" else 0     # 子进程不弹黑窗（index 踩过的坑）


def _paired_sidecar(data_file: Path) -> Path | None:
    """边车元数据文件：job-x.pdf → job-x.json（两种写法都认，手工放文件时也不会配对失败）"""
    candidates = (data_file.with_suffix(".json"), Path(str(data_file) + ".json"))
    return next((p for p in candidates if p.is_file()), None)


def _paired_data_file(sidecar: Path) -> Path:
    """边车对应的数据文件（清理孤立边车时用）：job-x.json → job-x.pdf；job-x.pdf.json → job-x.pdf"""
    direct = sidecar.with_suffix("")
    if direct.is_file():
        return direct
    for candidate in sorted(sidecar.parent.glob(f"{direct.name}.*")):
        if candidate.suffix != ".json":
            return candidate
    return direct


def _read_sidecar(path: Path) -> dict:
    """读 CUPS 后端写的边车文件：JSON 或 `键=值` 两种都认（后端是纯 sh，写 key=value 更省事）"""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    text = text.strip()
    if text.startswith("{"):
        try:
            data = json.loads(text)
            return data if isinstance(data, dict) else {}
        except ValueError:
            return {}
    meta: dict = {}
    for line in text.splitlines():
        key, sep, value = line.partition("=")
        if sep:
            meta[key.strip()] = value.strip()
    return meta


# ---------------------------------------------------------------- 流水线

def resolve_delivery(cfg: dict, profile: dict) -> tuple[str, str, str]:
    """决定这单的配送方式与地址：配置里填了就用，留空就用网站「我的配置」里的默认值。

    返回（配送方式, 地址, 错误说明）。错误说明非空时不要提交 —— 服务端对「配送单没地址」
    只会回一句 400，用户看不出该去哪儿改，所以这里提前把话说清楚。
    """
    mode = str(cfg.get("delivery_mode") or "").strip() or str(profile.get("default_delivery") or "")
    mode = mode if mode in ("配送", "取件") else "配送"
    address = str(cfg.get("address") or "").strip()
    if not address:
        address = str(profile.get("default_address") or "").strip()
    if mode == "配送" and not address:
        return mode, "", (
            "账号的配送方式是「配送」但没有地址：请在配置界面填配送地址，"
            "或到网站「我的配置」里设置默认配送地址，也可以把配送方式改成「取件」"
        )
    return mode, address, ""


class Pipeline:
    """一轮一轮地扫描来源目录；每轮把新文件取进 inbox 再提交。

    notify(kind, text, detail) 由上层（托盘/配置界面）传进来，用来弹提示。
    """

    def __init__(self, cfg: dict, notify=None):
        self.cfg = cfg
        self.client = Client(cfg)
        self.notify = notify or (lambda *args, **kwargs: None)
        self.paused = bool(cfg.get("paused"))
        self.submitted = 0
        self.last_result: Result | None = None
        self._pending: dict[str, tuple] = {}     # Windows 落盘文件的「等稳定」状态
        self._spool_state = self._load_spool_state()

    # -------------------------------------------------- 配置热更新

    def update_config(self, cfg: dict) -> None:
        """配置文件被改了就换掉（令牌等缓存字段沿用新的那份）"""
        self.cfg = cfg
        self.client.cfg = cfg
        self.paused = bool(cfg.get("paused"))

    # -------------------------------------------------- Windows 落盘文件

    def _load_spool_state(self) -> dict:
        try:
            data = json.loads(SPOOL_STATE_FILE.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _remember_spool(self, path: Path, stat: os.stat_result) -> None:
        """记住已经取走的那一版落盘文件，避免守护进程重启后重复提交"""
        self._spool_state = {"path": str(path), "mtime_ns": stat.st_mtime_ns, "size": stat.st_size}
        try:
            SPOOL_STATE_FILE.write_text(json.dumps(self._spool_state), encoding="utf-8")
        except OSError as exc:
            LOG.warning("写落盘状态失败：%s", exc)

    def _spool_fingerprint(self, path: Path) -> tuple | None:
        try:
            stat = path.stat()
        except OSError:
            return None
        if stat.st_size <= 0:
            return None
        return (stat.st_mtime_ns, stat.st_size, stat)

    def _collect_spool_file(self, target: Path) -> list[tuple[Path, dict]]:
        """Windows：驱动写的固定文件 → 稳定后复制进 inbox（不 move：文件归驱动所有，
        下一次打印它要重新写这个路径；也不能长留句柄，否则驱动写不进去）。"""
        if not target.is_file():
            return []
        fingerprint = self._spool_fingerprint(target)
        if fingerprint is None:
            return []
        mtime_ns, size, stat = fingerprint
        if self._spool_state.get("mtime_ns") == mtime_ns and self._spool_state.get("size") == size:
            return []      # 已经处理过（含上次运行处理的）
        slot = self._pending.get(str(target))
        if not slot or slot[0] != (mtime_ns, size):
            self._pending[str(target)] = ((mtime_ns, size), time.time())
            return []
        if time.time() - slot[1] < STABLE_SECONDS:
            return []      # 还在写，等下一轮
        dest = INBOX_DIR / f"win-{int(time.time())}-{size}.pdf"
        try:
            shutil.copy2(target, dest)
        except OSError as exc:
            LOG.warning("复制落盘文件失败（可能仍被驱动占用，稍后重试）：%s", exc)
            self._pending.pop(str(target), None)
            return []
        self._pending.pop(str(target), None)
        self._remember_spool(target, stat)
        from vp_platform import windows_job_name   # 延迟导入：非 Windows 平台没有这个函数

        title = windows_job_name(str(self.cfg.get("printer_name") or ""))
        LOG.info("取到落盘文件 %s（%s 字节，打印任务名：%s）", dest.name, size, title or "未知")
        return [(dest, {"title": title, "source": "windows"})]

    # -------------------------------------------------- CUPS 收件目录

    def _collect_dir(self, directory: Path) -> list[tuple[Path, dict]]:
        """macOS/Linux：CUPS 后端写出的 job-* 文件（原子重命名过，可直接取）"""
        results: list[tuple[Path, dict]] = []
        if directory.is_dir():
            for item in sorted(directory.glob("job-*")):
                if item.suffix == ".json":
                    # 边车只剩自己 → 数据文件已被处理过，清理掉；否则留着给下面的主循环配对
                    if not _paired_data_file(item).exists():
                        try:
                            item.unlink()
                        except OSError:
                            pass
                    continue
                try:
                    stat = item.stat()
                except OSError:
                    continue
                if time.time() - stat.st_mtime < MIN_AGE_SECONDS:
                    continue
                meta: dict = {"source": "cups"}
                sidecar = _paired_sidecar(item)
                if sidecar:
                    meta.update(_read_sidecar(sidecar))
                    try:
                        sidecar.unlink()
                    except OSError:
                        pass
                try:
                    if not os.access(directory, os.W_OK):
                        LOG.warning("收件目录不可写，跳过：%s", directory)
                        continue
                    shutil.move(str(item), str(INBOX_DIR / item.name))
                except OSError as exc:
                    LOG.warning("取走收件文件失败：%s（%s）", item, exc)
                    continue
                results.append((INBOX_DIR / item.name, meta))
        return results

    def collect(self) -> list[tuple[Path, dict]]:
        """取一批待处理文件进 inbox/：目录按 job-* 取，文件按「稳定后复制」取"""
        INBOX_DIR.mkdir(parents=True, exist_ok=True)
        results: list[tuple[Path, dict]] = []
        for target in watch_targets(self.cfg):
            if target.is_dir():
                results += self._collect_dir(target)
            elif target.is_file() or target.suffix:
                results += self._collect_spool_file(target)
        return results

    def pending(self) -> list[Path]:
        """inbox 里还没处理完的文件（含上次运行中断的）"""
        return sorted(INBOX_DIR.glob("*")) if INBOX_DIR.is_dir() else []

    # -------------------------------------------------- 提交

    def process(self, path: Path, meta: dict | None = None) -> Result:
        """把 inbox 里的一个文件提交到网站，然后归档到 sent/ 或 failed/"""
        meta = meta or {}
        cfg = self.cfg
        try:
            pdf = to_pdf(path, INBOX_DIR / "_work")
        except ConvertError as exc:
            return self._archive(path, False, str(exc), kind="格式不支持")
        if pdf != path:
            # 转换出的 PDF 顶替原件，否则原件会留在 inbox 里被反复提交
            converted = path.with_suffix(".pdf")
            try:
                shutil.move(str(pdf), str(converted))
                path.unlink()
            except OSError as exc:
                LOG.warning("替换原件失败：%s", exc)
                converted = pdf
            path = converted

        title = sanitize_name(str(meta.get("title") or "")) or sanitize_name(pdf_title(path))
        if title and Path(title).suffix.lower() in (".pdf", ".png", ".jpg", ".jpeg", ".docx", ".doc", ".pptx", ".ppt"):
            title = sanitize_name(Path(title).stem)      # CUPS 给的标题常带原扩展名
        if not title:
            stem = path.stem
            # win-* / job-* / sim-* 是内部生成的临时名，不是用户文档名
            title = "" if stem.startswith(("win-", "job-", "sim-")) else sanitize_name(stem)
        filename = f"{title}.pdf" if title else f"虚拟打印-{time.strftime('%Y%m%d-%H%M%S')}.pdf"
        note = str(cfg.get("note") or "").strip()
        try:
            # 打印对话框里选的份数优先（CUPS 后端会带过来），其次是配置里的份数
            copies = max(1, min(99, int(meta.get("copies") or cfg.get("copies") or 1)))
        except (TypeError, ValueError):
            copies = max(1, min(99, int(cfg.get("copies") or 1)))

        attempt = 0
        while True:
            attempt += 1
            try:
                token = self.client.token()
                mode, address, problem = resolve_delivery(cfg, self.client.profile_cached(token))
                if problem:
                    return self._archive(path, False, problem, kind="缺配送地址")
                # 提交 path（转换成功后它就是那个 PDF）：上面已经把转换产物从 _work/ 移到了
                # inbox/，再拿 to_pdf 返回的旧路径去打开会 FileNotFoundError（2026-09-16 踩到）
                data = self.client.submit_job(
                    path, token,
                    filename=filename,
                    delivery_mode=mode,
                    address=address,
                    note=note,
                    copies=copies,
                )
                job = data.get("job") or {}
                charge = str(data.get("charge") or "0.00")
                balance = str(data.get("balance") or "")
                message = (
                    f"已提交任务 #{job.get('id')}：{filename}"
                    f"（扣费 {charge} 元，余额 {balance} 元，等管理员审核）"
                )
                LOG.info(message)
                return self._archive(path, True, message, job_id=int(job.get("id") or 0),
                                     charge=charge, balance=balance)
            except ApiError as exc:
                if exc.status == 401 and attempt == 1:
                    LOG.info("令牌失效或密码错，重新登录后重试")
                    try:
                        self.client.token(force=True)
                    except ApiError as login_exc:
                        # 登录本身失败（密码错、被限速、连不上）也要归档成失败，不能把异常抛出去
                        kind = "登录被限速" if login_exc.status == 429 else "登录失败"
                        return self._archive(path, False, login_exc.message, kind=kind)
                    continue
                if exc.is_retryable and attempt <= MAX_ATTEMPTS:
                    delay = RETRY_DELAYS[min(attempt - 1, len(RETRY_DELAYS) - 1)]
                    LOG.warning("提交失败（第 %s 次）：%s，%s 秒后重试", attempt, exc.message, delay)
                    time.sleep(delay)
                    continue
                kind = "提交失败"
                if exc.code == "insufficient_balance":
                    kind = "余额不足"
                elif exc.status == 429:
                    kind = "登录被限速"
                return self._archive(path, False, exc.message, kind=kind)

    def _archive(self, path: Path, ok: bool, message: str, *, kind: str = "",
                 job_id: int = 0, charge: str = "", balance: str = "") -> Result:
        """把文件挪进 sent/ 或 failed/，记一条最近记录并通知界面"""
        target_dir = SENT_DIR if ok else FAILED_DIR
        target_dir.mkdir(parents=True, exist_ok=True)
        dest = target_dir / path.name
        counter = 1
        while dest.exists():
            dest = target_dir / f"{path.stem}_{counter}{path.suffix}"
            counter += 1
        try:
            shutil.move(str(path), str(dest))
        except OSError as exc:
            LOG.warning("归档失败：%s（%s）", path, exc)
        if ok:
            self.submitted += 1
        result = Result(ok=ok, path=dest, message=message, job_id=job_id, charge=charge, balance=balance)
        self.last_result = result
        push_recent({
            "ok": ok,
            "file": dest.name,
            "job_id": job_id,
            "charge": charge,
            "balance": balance,
            "message": message,
            "kind": kind,
        })
        self.notify("ok" if ok else "error", message if ok else f"{kind or '提交失败'}：{message}")
        return result

    # -------------------------------------------------- 循环

    def run_once(self) -> int:
        """跑一轮：先处理积压，再取新的。返回本轮处理条数"""
        count = 0
        for path in self.pending():
            if path.is_dir():
                continue
            self.process(path, {})
            count += 1
        for path, meta in self.collect():
            self.process(path, meta)
            count += 1
        return count

    def run_forever(self, stop, on_idle=None) -> None:
        LOG.info("虚拟打印机守护启动（v%s）：服务器 %s，监听 %s",
                 VERSION, self.client.server, [str(p) for p in watch_targets(self.cfg)])
        while not stop.is_set():
            try:
                if self.paused:
                    stop.wait(POLL_INTERVAL)
                    continue
                if not self.run_once() and on_idle:
                    on_idle()
            except Exception as exc:       # 单轮出错不能让守护退出
                LOG.exception("本轮处理异常：%s", exc)
            stop.wait(POLL_INTERVAL)
        LOG.info("虚拟打印机守护已停止")


def retry_failed() -> int:
    """把 failed/ 里的文件挪回 inbox/ 重试（补好余额、改对配置之后用）"""
    count = 0
    for item in sorted(FAILED_DIR.glob("*")) if FAILED_DIR.is_dir() else []:
        if item.is_dir():
            continue
        try:
            INBOX_DIR.mkdir(parents=True, exist_ok=True)
            shutil.move(str(item), str(INBOX_DIR / item.name))
            count += 1
        except OSError as exc:
            LOG.warning("移回失败文件出错：%s（%s）", item, exc)
    if count:
        LOG.info("已把 %s 个失败文件移回收件箱", count)
    return count


def simulate(source: Path, cfg: dict, notify=None) -> Result:
    """调试/验收用：把一份文件当成「刚从打印机出来的」走完整流水线"""
    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    dest = INBOX_DIR / f"sim-{int(time.time())}{source.suffix or '.pdf'}"
    shutil.copy2(source, dest)
    pipeline = Pipeline(cfg, notify=notify)
    return pipeline.process(dest, {"title": source.stem, "source": "simulate"})
