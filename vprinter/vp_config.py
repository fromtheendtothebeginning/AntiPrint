# vp_config.py — 虚拟打印机的配置读写、目录约定与日志
#
# 配置与数据都放在用户目录下（Windows: %USERPROFILE%\.antiprint-vprinter），
# 不写进程序目录，避免「程序装在哪」影响运行（分发包可能放在只读位置）。
# 环境变量 ANTIPRINT_VPRINTER_HOME 可整体改根目录（测试用）。

from __future__ import annotations

import json
import logging
import os
import sys
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path

VERSION = "1.0.0"
APP_NAME = "AntiPrint"

LOG = logging.getLogger("antiprint.vprinter")

PORTABLE_DIR_NAME = "AntiPrintVPrinter-data"    # 绿色模式：数据目录就放在 exe 旁边，用这个固定名字


def _portable_dir() -> Path | None:
    """绿色模式：程序（exe）旁边建 AntiPrintVPrinter-data 放配置与日志 ——
    拷走整个文件夹就把账号、日志、待提交文件一起带走，删掉文件夹就等于卸载干净。
    只在打包成 exe 时启用（源码运行时数据仍写在用户目录，免得往仓库里塞东西）；
    程序目录不可写（比如放在 C:\\Program Files）时返回 None，调用方回落到用户目录。"""
    if not getattr(sys, "frozen", False):
        return None
    candidate = Path(sys.executable).resolve().parent / PORTABLE_DIR_NAME
    try:
        candidate.mkdir(parents=True, exist_ok=True)
        probe = candidate / ".write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return candidate
    except OSError:
        return None


_env_home = os.environ.get("ANTIPRINT_VPRINTER_HOME")
PORTABLE_DIR = None if _env_home else _portable_dir()
CONFIG_DIR = (
    Path(_env_home).expanduser() if _env_home
    else (PORTABLE_DIR or (Path.home() / ".antiprint-vprinter"))
)
# 数据放哪儿（配置界面/自检里显示，用户一眼能看出是不是绿色模式）
DATA_MODE = "绿色模式（程序旁边）" if PORTABLE_DIR else "用户目录"
CONFIG_PATH = CONFIG_DIR / "config.json"
LOG_DIR = CONFIG_DIR / "log"
LOG_FILE = LOG_DIR / "vprinter.log"
INBOX_DIR = CONFIG_DIR / "inbox"        # 已接手、等待提交的文件
SENT_DIR = CONFIG_DIR / "sent"          # 提交成功的文件（留档，便于排查）
FAILED_DIR = CONFIG_DIR / "failed"      # 提交失败的文件（改好配置后可重试）
RECENT_FILE = CONFIG_DIR / "recent.json"  # 最近几次提交结果（配置界面上显示）


def _lock_file() -> Path:
    """单实例锁：**放在数据目录里**（2026-09-16 按用户要求「程序产生的东西都放 exe 旁边」）。

    早先放 `%LOCALAPPDATA%` 是为了防「同一台机器两份副本同时盯着同一个落盘文件、把同一份打印
    提交两次」；现在落盘文件跟着副本走（`spool/` 在当前副本的数据目录里），这个前提没有了 ——
    只有当前这份副本盯自己的 spool。跨副本的错配改由「队列端口与本目录不一致就提示」兜住
    （见 `spool_mismatch()` / 配置界面与自检的提示）。"""
    return CONFIG_DIR / "vprinter.lock"


LOCK_FILE = _lock_file()  # 单实例锁

# 打印数据的落盘目录：**就在数据目录里**（`exe旁边\AntiPrintVPrinter-data\spool\`，2026-09-16 按用户要求改）——
# 打印队列本身是 Windows 的系统对象（注册表 + 假脱机服务），没法放进文件夹，但驱动写出来的 PDF 可以：
# 队列的端口指向这个文件，于是「程序产生的东西」全在程序自己那一份目录里，拷走文件夹就全带走了。
SPOOL_DIR = CONFIG_DIR / "spool"

# 老版本把落盘文件放在 %ProgramData%\AntiPrint\spool（机器级），装新队列时顺手清掉它的端口和残留文件
LEGACY_SPOOL_DIR = Path(os.environ.get("ProgramData") or r"C:\ProgramData") / "AntiPrint" / "spool"

# macOS / Linux：CUPS 后端把打印数据落在这里（由 setup-cups.sh 创建；也可以用它的 --local-spool 放进程序目录）
CUPS_SPOOL_DIR = Path(os.environ.get("ANTIPRINT_VPRINTER_CUPS_SPOOL") or "/var/spool/antiprint")

# ── 打印机队列名 ──
# 驼峰品牌名 + 版本号（如 AntiPrint-1.0.0）：打印对话框里一眼能看出装的是哪一版；
# 用连字符不用空格 —— CUPS 的队列名不允许空格，Windows 侧也跟着统一。
# 换版本时它会自动跟着 VERSION 变，老名字列在 LEGACY_PRINTER_NAMES 里，装新队列时顺手清掉。
DEFAULT_PRINTER_BASE = "AntiPrint"
DEFAULT_PRINTER_NAME = f"{DEFAULT_PRINTER_BASE}-{VERSION}"
LEGACY_PRINTER_NAMES = ("ANTIPRINT",)          # 1.0.0 之前用的全大写名字

DEFAULT_SERVER = "https://print.anticraft.top"   # AntiPrint 线上站点（首次使用默认连它）

# 点配置界面窗口的 × 时干什么（配置界面「运行状态」页里可改，也可以在弹窗里勾「记住我的选择」）
CLOSE_ASK = "ask"          # 每次询问（出厂默认）
CLOSE_WINDOW = "window"    # 只关这个窗口，后台服务继续跑（托盘图标还在）
CLOSE_QUIT = "quit"        # 连后台服务一起退出
CLOSE_ACTIONS = (CLOSE_ASK, CLOSE_WINDOW, CLOSE_QUIT)

LOG_MAX_BYTES = 1024 * 1024
LOG_BACKUP_COUNT = 3

DEFAULT_CONFIG = {
    "server": DEFAULT_SERVER,
    "auth_mode": "local",          # local = 本站账号 / anticraft = anticraft 账号
    "username": "",
    "password": "",                # 明文存本机配置文件（0600），见 README 说明
    "delivery_mode": "",           # 空 = 用网站上的默认配送方式
    "address": "",                 # 空 = 用网站上的默认地址
    "note": "虚拟打印机提交",
    "copies": 1,
    "printer_name": DEFAULT_PRINTER_NAME,
    "watch_dirs": [],              # 空 = 平台默认（Windows 看落盘文件 / mac、Linux 看 CUPS 收件目录）
    "paused": False,               # 暂停监听（托盘菜单可切换）
    "autostart": False,            # 界面上的勾选状态，真实状态以系统为准
    "queue_warned": False,         # 「队列还没装」的引导只弹一次
    "shortcut_asked": False,       # 「要不要放个桌面快捷方式」只问一次
    "notify_popup": True,          # 提交结果是否弹提示气泡（默认弹；不想要就在配置界面/托盘菜单里取消勾选）
    "close_action": CLOSE_ASK,     # 点配置界面窗口的 × 时：每次询问 / 只关界面 / 退出程序
    "token": "",                   # 缓存的登录令牌（24 小时有效）
    "token_at": 0.0,
    "token_user": "",
}


def truthy(value) -> bool:
    """按项目约定解析开关值：服务端 settings 存的是 '0'/'1' 字符串，
    bool('0') 恒为 True，所以一律走这里（print_agent.py 踩过的坑）。"""
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in ("1", "true", "yes", "on", "y", "t")


def ensure_dirs() -> None:
    for path in (CONFIG_DIR, LOG_DIR, INBOX_DIR, SENT_DIR, FAILED_DIR, SPOOL_DIR):
        path.mkdir(parents=True, exist_ok=True)


def setup_logging(verbose: bool = False) -> None:
    """日志：轮转文件 + 控制台（pythonw 下 stdout/stderr 为 None，必须判空）"""
    ensure_dirs()
    if LOG.handlers:
        return
    LOG.setLevel(logging.DEBUG if verbose else logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
    try:
        file_handler = RotatingFileHandler(
            LOG_FILE, maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUP_COUNT, encoding="utf-8"
        )
        file_handler.setFormatter(fmt)
        LOG.addHandler(file_handler)
    except OSError:
        pass
    if sys.stderr is not None:
        console = logging.StreamHandler(sys.stderr)
        console.setFormatter(fmt)
        LOG.addHandler(console)


def load_config() -> dict:
    """读配置，缺的键用默认值补齐（旧配置文件升级后不会缺字段）"""
    cfg = dict(DEFAULT_CONFIG)
    try:
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            for key in DEFAULT_CONFIG:
                if key in raw:
                    cfg[key] = raw[key]
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as exc:
        LOG.warning("配置文件读取失败（按默认值继续）：%s", exc)
    cfg["server"] = str(cfg.get("server") or "").rstrip("/")
    # 老配置里存的是全大写队列名（ANTIPRINT）→ 跟着版本升级成新名字，
    # 否则用户永远停在旧名上（旧队列会在下次「安装」时被顺手清掉）
    if str(cfg.get("printer_name") or "").strip() in ("",) + LEGACY_PRINTER_NAMES:
        cfg["printer_name"] = DEFAULT_PRINTER_NAME
    try:
        cfg["copies"] = max(1, min(99, int(cfg.get("copies") or 1)))
    except (TypeError, ValueError):
        cfg["copies"] = 1
    if not isinstance(cfg.get("watch_dirs"), list):
        cfg["watch_dirs"] = []
    if str(cfg.get("close_action") or "").strip() not in CLOSE_ACTIONS:
        cfg["close_action"] = CLOSE_ASK      # 手改配置写错值时回到「每次询问」
    return cfg


def save_config(cfg: dict) -> None:
    """原子写配置；POSIX 下权限 0600（里面有账号密码）"""
    ensure_dirs()
    tmp = CONFIG_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, CONFIG_PATH)
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except OSError:
        pass    # Windows 上 chmod 只影响只读位，忽略


def config_mtime() -> float:
    try:
        return CONFIG_PATH.stat().st_mtime
    except OSError:
        return 0.0


def spool_file_for(printer_name: str = "") -> Path:
    """Windows 上驱动往这个固定文件里写 PDF（**名字跟着队列名走**：装了 AntiPrint-1.0.0，
    端口就是 `spool\\AntiPrint-1.0.0.pdf`，就在程序旁边的数据目录里）。
    环境变量 ANTIPRINT_VPRINTER_SPOOL 可整体覆盖（自检/测试用）。"""
    override = os.environ.get("ANTIPRINT_VPRINTER_SPOOL")
    if override:
        return Path(override)
    return SPOOL_DIR / f"{(printer_name or DEFAULT_PRINTER_NAME).strip()}.pdf"


WINDOWS_SPOOL_FILE = spool_file_for()      # 默认队列对应的那一份（保留这个名字给老调用方用）


def default_watch_dirs(printer_name: str = "") -> list[Path]:
    """平台默认的监听目标：Windows 盯落盘文件（见 vp_pipeline），
    macOS / Linux 直接看 CUPS 后端写出的收件目录。"""
    if os.name == "nt":
        return [spool_file_for(printer_name)]
    return [CUPS_SPOOL_DIR]


def watch_targets(cfg: dict) -> list[Path]:
    dirs = [Path(p).expanduser() for p in (cfg.get("watch_dirs") or []) if str(p).strip()]
    return dirs or default_watch_dirs(str(cfg.get("printer_name") or ""))


# ---------------------------------------------------------------- 最近提交记录

RECENT_LIMIT = 20


def load_recent() -> list[dict]:
    try:
        data = json.loads(RECENT_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def push_recent(entry: dict) -> None:
    """追加一条提交结果（最多留 20 条），供配置界面显示"""
    items = load_recent()
    items.insert(0, {"ts": time.time(), **entry})
    try:
        tmp = RECENT_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(items[:RECENT_LIMIT], ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, RECENT_FILE)
    except OSError as exc:
        LOG.warning("写最近记录失败：%s", exc)
