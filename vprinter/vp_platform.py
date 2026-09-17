# vp_platform.py — 与操作系统打交道的那点事：单实例锁、自启动、打开目录、打印机队列查询
#
# 三个平台（Windows / macOS / Linux）都在这里分支，其它模块不直接判断平台。
# 约定：Windows 的 PowerShell 调用一律带 CREATE_NO_WINDOW（index 项目踩过：不加会反复闪黑窗）。

from __future__ import annotations

import os
import platform
import shlex
import subprocess
import sys
import time
from pathlib import Path

from vp_config import LOG

AUTOSTART_NAME = "AntiPrintVPrinter"
MAC_LABEL = "com.antiprint.vprinter"
LINUX_DESKTOP = "antiprint-vprinter.desktop"
WIN_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
POWERSHELL_TIMEOUT = 20
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
PRINTER_CACHE_SECONDS = 5.0     # 打印机列表的缓存时长（注册表读取很快，主要避免一次启动里重复读）
_printer_cache: tuple[float, list] = (0.0, [])

# 打包成 exe（PyInstaller）后：sys.executable 是 exe 自己、__file__ 在临时解包目录里，
# 所以「程序在哪个目录」「怎么再拉起一个自己」都要走下面这两个判断。
IS_FROZEN = bool(getattr(sys, "frozen", False))
APP_SCRIPT = Path(__file__).resolve().parent / "virtual_printer.py"


def system_name() -> str:
    return {"nt": "windows", "darwin": "macos", "posix": "linux"}.get(os.name, "linux")


def platform_label() -> str:
    return f"{platform.system()} {platform.release()}"


def app_dir() -> Path:
    """程序所在目录：exe 形态 = exe 所在文件夹（安装脚本、README 就在旁边）；源码形态 = 本目录"""
    if IS_FROZEN:
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


# ---------------------------------------------------------------- 单实例锁

class SingleInstance:
    """同一台机器上只跑一个守护进程：两个进程同时抢同一个落盘文件会让任务提交两次。

    实现要点（2026-09-16 踩过，别改回去）：
      * `msvcrt.locking(fd, LK_NBLCK, 1)` 锁的是**当前文件位置**那一字节 —— 用文本流 "a+"
        打开时位置会跑到文件尾，探测方就会锁到另一个字节（把「在跑」误判成「没在跑」），
        接着往文件里写还会撞上对方锁住的第 0 字节抛 PermissionError。
        所以这里用 `os.open` + 显式 `lseek(0)`，并且**只锁不写**（空文件就够表达「已被占用」）。
      * 整个加锁过程都包在 try 里：拿不到锁、路径不可写等一律当「没拿到」，不往外抛异常。
    """

    def __init__(self, path: Path):
        self.path = path
        self.fd: int | None = None

    def acquire(self) -> bool:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(self.path, os.O_CREAT | os.O_RDWR)
        except OSError as exc:
            LOG.warning("打不开单实例锁文件：%s", exc)
            return False
        try:
            os.lseek(fd, 0, os.SEEK_SET)          # 必须显式回到第 0 字节，别依赖文件位置
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            return False
        self.fd = fd
        return True

    def release(self) -> None:
        if self.fd is None:
            return
        try:
            os.close(self.fd)                     # 关掉句柄就等于解锁
        except OSError:
            pass
        self.fd = None


def daemon_running() -> bool:
    """守护进程是否在跑：能拿到单实例锁就说明没在跑（配置界面/自检用）"""
    from vp_config import LOCK_FILE

    probe = SingleInstance(LOCK_FILE)
    if probe.acquire():
        probe.release()
        return False
    return True


# ---------------------------------------------------------------- 打开目录 / 文件

def open_path(path: Path) -> bool:
    """用系统默认方式打开目录或文件（配置界面、托盘菜单用）"""
    target = str(path)
    try:
        if os.name == "nt":
            os.startfile(target)      # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", target])
        else:
            subprocess.Popen(["xdg-open", target])
        return True
    except OSError as exc:
        LOG.warning("打开 %s 失败：%s", target, exc)
        return False


# ---------------------------------------------------------------- 找出/停掉别的实例

_OTHER_INSTANCES_SCRIPT = (
    "Get-CimInstance Win32_Process | Where-Object {"
    " $_.Name -eq 'AntiPrintVPrinter.exe' -or"
    " ($_.Name -like 'python*' -and $_.CommandLine -like '*virtual_printer*')"
    "} | ForEach-Object { \"$($_.ProcessId)`t$($_.ExecutablePath)\" }"
)


def other_instances() -> list[dict]:
    """本程序**其它实例**（不含自己与自己的父进程：单文件 exe 父子同名，自己的父进程
    就是自己的解包器，杀掉会把当前这次启动一起带走）。

    返回 [{"pid": int, "path": str}]，path 用来分辨「同一份程序又点了一次」和
    「另一份副本（多半是旧版本）还在跑」—— 前者只要把界面开出来，后者才需要问要不要接管。
    """
    if os.name != "nt":
        from vp_config import LOCK_FILE

        probe = SingleInstance(LOCK_FILE)
        return [] if probe.acquire() else [{"pid": -1, "path": ""}]   # 非 Windows 只回报「有人在跑」
    code, out = _powershell(
        f"$mine = @({os.getpid()},{os.getppid()})\n"
        f"{_OTHER_INSTANCES_SCRIPT} | Where-Object {{ $mine -notcontains $_.Split(\"`t\")[0] }}"
    )
    if code != 0 or not out:
        return []
    found: list[dict] = []
    for line in out.splitlines():
        pid_text, _, path = line.strip().partition("\t")
        if pid_text.isdigit():
            found.append({"pid": int(pid_text), "path": path.strip()})
    return found


def other_instance_pids() -> list[int]:
    return [item["pid"] for item in other_instances()]


def stop_other_instances() -> int:
    """停掉其它实例（升级时由用户点了「是」才会走到这儿）。返回停掉的进程数"""
    pids = other_instance_pids()
    if not pids:
        return 0
    if os.name == "nt":
        _powershell(
            "Get-CimInstance Win32_Process | Where-Object {"
            f" $_.ProcessId -in @({','.join(str(p) for p in pids)})"
            "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
        )
        return len(pids)
    return 0


# ---------------------------------------------------------------- 配置界面窗口

# 配置界面是**另一个进程**（关窗口不影响后台服务，macOS 上也不跟托盘抢主线程），
# 所以「退出」时必须主动去关它 —— 否则托盘图标没了、后台服务停了，窗口还留在屏幕上。
# 判定一律看命令行里的 --settings：守护进程的命令行里没有它，
# 这样既能找到「本进程开的窗口」，也能找到「再点一次 exe 时那个短命进程开的窗口」，还不会误杀守护。
# 配置界面窗口 / 后台服务，都只认**本程序这一形态**的进程：
#   exe 形态（PyInstaller 单文件）= AntiPrintVPrinter.exe；源码形态 = python* 跑 virtual_printer.py。
# 这样源码里跑用例/调试时不会把用户正在用的分发包实例一起停掉（2026-09-17 踩过：测试连带杀了生产实例）。
def _self_form_match() -> str:
    """本程序「这一形态」的进程名匹配串：exe 形态 = AntiPrintVPrinter.exe，源码形态 = python* 跑 virtual_printer.py"""
    if IS_FROZEN:
        return " $_.Name -eq 'AntiPrintVPrinter.exe'"
    return " ($_.Name -like 'python*' -and $_.CommandLine -like '*virtual_printer*')"


def _mine_match(extra: str) -> str:
    """「本程序这一形态 + 额外条件」的 PowerShell 过滤串。

    形态按 IS_FROZEN 现算（不是模块常量）——这样用例可以把 IS_FROZEN 设成 True 来验分发包那一套。
    用哪条规则见上面 `_self_form_match()` 的说明。"""
    return f" ({_self_form_match()}) -and {extra}\n"


def _kill_script(match: str) -> str:
    """按匹配串列出进程 → 连同子进程一起停 → 输出停掉的个数"""
    return (
        "$targets = @(Get-CimInstance Win32_Process | Where-Object {\n"
        f"{match}"
        "} | Select-Object -ExpandProperty ProcessId)\n"
        "$killed = 0\n"
        "foreach ($t in $targets) {\n"
        "  Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq $t -or $_.ParentProcessId -eq $t } |\n"
        "  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed++ }\n"
        "}\n"
        "Write-Output $killed\n"
    )


def _list_script(match: str) -> str:
    return (
        "$targets = @(Get-CimInstance Win32_Process | Where-Object {\n"
        f"{match}"
        "} | Select-Object -ExpandProperty ProcessId)\n"
        "Write-Output ($targets -join ' ')\n"
    )


def _settings_match() -> str:
    """配置界面窗口：本形态 + 命令行里有 --settings（守护进程没有它）"""
    return _mine_match("$_.CommandLine -like '*--settings*'")

# 守护进程 = 本程序这一形态里**不带 --settings** 的那些（配置界面窗口与它带的父/子进程都带 --settings）。
# 交互式的 --install-printer / --uninstall-printer（提权再跑一遍自己）也排除掉，
# 免得用户正点到一半被自己的「退出程序」打断。
def _daemon_match() -> str:
    """后台服务：本形态 + 命令行里没有 --settings（也没有交互式的装/卸队列参数）"""
    return _mine_match(
        "$_.CommandLine -notlike '*--settings*' -and"
        " $_.CommandLine -notlike '*--install-printer*' -and"
        " $_.CommandLine -notlike '*--uninstall-printer*'"
    )


def daemon_pids() -> list[int]:
    """后台服务（守护进程 + 托盘）的进程号；配置界面窗口不在里面"""
    if os.name != "nt":
        return []
    code, out = _powershell(_list_script(_daemon_match()))
    return [int(x) for x in out.split() if x.strip().isdigit()] if code == 0 else []


def stop_daemon() -> int:
    """停掉后台服务（含单文件 exe 的父/子两个进程）。返回停掉的进程数

    由配置界面的「退出程序」调用（托盘菜单里的「退出」走的是进程内那条路）。"""
    if os.name == "nt":
        code, out = _powershell(_kill_script(_daemon_match()))
        if code != 0:
            return 0
        return int(out.strip()) if out.strip().isdigit() else 0
    import signal

    pids: list[int] = []
    try:
        proc = subprocess.run(["pgrep", "-f", "virtual_printer"], capture_output=True, text=True, timeout=10)
        pids = [int(x) for x in proc.stdout.split() if x.isdigit() and int(x) != os.getpid()]
    except (OSError, subprocess.SubprocessError):
        return 0
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            continue
    return len(pids)


def settings_window_pids() -> list[int]:
    """当前开着的配置界面窗口进程（不含守护进程自己）"""
    if os.name != "nt":
        return []
    code, out = _powershell(_list_script(_settings_match()))
    return [int(x) for x in out.split() if x.strip().isdigit()] if code == 0 else []


def spawn_settings_window() -> subprocess.Popen:
    """另起一个进程开配置界面（关窗口不影响后台服务；macOS 上也不跟托盘抢主线程）"""
    return subprocess.Popen(launch_argv("--settings"), creationflags=CREATE_NO_WINDOW)


def close_settings_windows() -> int:
    """关掉所有配置界面窗口（含单文件 exe 的父/子两个进程）。返回停掉的进程数"""
    if os.name == "nt":
        code, out = _powershell(_kill_script(_settings_match()))
        if code != 0:
            return 0
        return int(out.strip()) if out.strip().isdigit() else 0
    import signal

    pids: list[int] = []
    try:
        proc = subprocess.run(["pgrep", "-f", "--settings"], capture_output=True, text=True, timeout=10)
        pids = [int(x) for x in proc.stdout.split() if x.isdigit() and int(x) != os.getpid()]
    except (OSError, subprocess.SubprocessError):
        return 0
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            continue
    return len(pids)


# ---------------------------------------------------------------- 自启动

def python_launcher() -> str:
    """拉起自己要用哪个程序：打包成 exe 后就是 exe 本身；
    源码运行时 Windows 上优先 pythonw.exe（无控制台窗口）"""
    if IS_FROZEN:
        return sys.executable
    exe = Path(sys.executable)
    if os.name == "nt":
        windowless = exe.with_name("pythonw.exe")
        if windowless.exists():
            return str(windowless)
    return str(exe)


def launch_argv(*extra: str) -> list[str]:
    """启动本程序的完整命令行（配置窗口、按钮拉起都用它）：
    exe 形态 = 「exe --settings」，源码形态 = 「pythonw virtual_printer.py --settings」"""
    if IS_FROZEN:
        return [sys.executable, *extra]
    return [python_launcher(), str(APP_SCRIPT), *extra]


def start_command(script: Path | None = None, extra: str = "") -> str:
    if IS_FROZEN or script is None:
        return f'"{python_launcher()}"{extra}'
    return f'"{python_launcher()}" "{script}"{extra}'


def autostart_command() -> str:
    """开机自启命令：带 --silent —— 开机时**不要**弹配置界面（双击 exe 才弹，见 virtual_printer 的
    handle_already_running / first_run_guide）"""
    return start_command(Path(__file__).resolve().parent / "virtual_printer.py", extra=" --silent")

def autostart_enabled() -> bool:
    if os.name == "nt":
        try:
            import winreg

            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, WIN_RUN_KEY) as key:
                value, _ = winreg.QueryValueEx(key, AUTOSTART_NAME)
                return bool(value)
        except OSError:
            return False
    if sys.platform == "darwin":
        return _mac_plist_path().is_file()
    return _linux_desktop_path().is_file()


def set_autostart(enabled: bool) -> tuple[bool, str]:
    """开/关开机自启，返回（是否成功，说明文字）"""
    if os.name == "nt":
        return _set_autostart_windows(enabled)
    if sys.platform == "darwin":
        return _set_autostart_macos(enabled)
    return _set_autostart_linux(enabled)


def _set_autostart_windows(enabled: bool) -> tuple[bool, str]:
    import winreg

    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, WIN_RUN_KEY) as key:
            if enabled:
                winreg.SetValueEx(key, AUTOSTART_NAME, 0, winreg.REG_SZ, autostart_command())
                return True, "已加入开机自启动（当前用户）"
            try:
                winreg.DeleteValue(key, AUTOSTART_NAME)
            except FileNotFoundError:
                pass
            return True, "已取消开机自启动"
    except OSError as exc:
        LOG.warning("写注册表自启项失败：%s", exc)
        return False, f"写入注册表失败：{exc}（可能需要以管理员身份运行）"


def _mac_plist_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{MAC_LABEL}.plist"


def _set_autostart_macos(enabled: bool) -> tuple[bool, str]:
    plist = _mac_plist_path()
    if not enabled:
        try:
            if plist.exists():
                subprocess.run(["launchctl", "unload", "-w", str(plist)], capture_output=True, timeout=15)
                plist.unlink()
            return True, "已取消开机自启动"
        except (OSError, subprocess.TimeoutExpired) as exc:
            return False, f"关闭自启失败：{exc}"
    argv = launch_argv()
    args_xml = "\n".join(f"    <string>{part}</string>" for part in argv)
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
{args_xml}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict>
</plist>
"""
    try:
        plist.parent.mkdir(parents=True, exist_ok=True)
        plist.write_text(body, encoding="utf-8")
        subprocess.run(["launchctl", "load", "-w", str(plist)], capture_output=True, timeout=15)
        return True, "已加入登录自启（LaunchAgents）"
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"写入 LaunchAgent 失败：{exc}"


def _linux_desktop_path() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config")) / "autostart" / LINUX_DESKTOP


def _set_autostart_linux(enabled: bool) -> tuple[bool, str]:
    target = _linux_desktop_path()
    try:
        if not enabled:
            target.unlink(missing_ok=True)
            return True, "已取消开机自启动"
        exec_line = " ".join(shlex.quote(part) for part in launch_argv())
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            "[Desktop Entry]\n"
            "Type=Application\n"
            "Name=AntiPrint 虚拟打印机\n"
            "Comment=把虚拟打印机的输出提交到 AntiPrint 网站\n"
            f"Exec={exec_line}\n"
            "Terminal=false\n"
            "X-GNOME-Autostart-enabled=true\n",
            encoding="utf-8",
        )
        return True, "已加入开机自启动（~/.config/autostart）"
    except OSError as exc:
        return False, f"写入自启动项失败：{exc}"


# ---------------------------------------------------------------- 打印机队列查询

def _powershell(script: str) -> tuple[int, str]:
    """跑一段 PowerShell，返回（退出码，标准输出）。失败返回 (-1, 错误)"""
    try:
        done = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
            capture_output=True, timeout=POWERSHELL_TIMEOUT, creationflags=CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return -1, str(exc)
    return done.returncode, done.stdout.decode("utf-8", "ignore").strip()


def _registry_printers() -> list[dict]:
    """从注册表读本机打印机队列（名字 + 端口），毫秒级。

    为什么不继续用 `Get-Printer`：每次起一次 Windows PowerShell 要 1.5~2.5 秒，
    而启动路径上（守护进程看队列在不在、配置界面刷新状态、自检）要问好几次 ——
    2026-09-16 实测 `--status` 里 4.6 秒有 4 秒耗在这上面，用户直接反馈「打开软件好慢」。
    注册表里**没有驱动名**（能力参数在 DsDriver 子键，不是驱动名），所以 DriverName 留空，
    只用于显示；真要驱动名的地方（装机/自检提示）用 PowerShell 单独问一次。"""
    if os.name != "nt":
        return []
    import winreg

    base = r"SYSTEM\CurrentControlSet\Control\Print\Printers"
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, base) as root:
            names: list[str] = []
            index = 0
            while True:
                try:
                    names.append(winreg.EnumKey(root, index))
                except OSError:
                    break
                index += 1
    except OSError as exc:
        LOG.warning("读注册表里的打印机列表失败（改用 PowerShell）：%s", exc)
        return []
    printers: list[dict] = []
    for name in names:
        port = ""
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, f"{base}\\{name}") as key:
                try:
                    port = str(winreg.QueryValueEx(key, "Port")[0] or "")
                except FileNotFoundError:
                    port = ""
        except OSError:
            continue
        printers.append({"Name": name, "DriverName": "", "PortName": port})
    return printers


def _powershell_printers() -> list[dict]:
    """注册表读不到时的兜底（老系统/受限权限），慢但信息全（含驱动名）"""
    code, out = _powershell(
        "Get-Printer | Select-Object Name,DriverName,PortName | ConvertTo-Json -Compress"
    )
    if code != 0 or not out:
        return []
    import json

    try:
        data = json.loads(out)
    except ValueError:
        return []
    if isinstance(data, dict):
        data = [data]
    return [item for item in data if isinstance(item, dict)]


def windows_printers(max_age: float = PRINTER_CACHE_SECONDS, refresh: bool = False) -> list[dict]:
    """列出本机打印机队列（自检与配置界面显示用）。

    注册表优先（毫秒级），带几秒缓存 —— 一次启动里同一份数据会被问好几次，别重复读。
    刚装/卸完队列的调用方传 `refresh=True` 拿最新的。"""
    global _printer_cache
    stamp, cached = _printer_cache
    if not refresh and cached and (time.time() - stamp) < max_age:
        return cached
    printers = _registry_printers()
    if not printers:
        printers = _powershell_printers()
    _printer_cache = (time.time(), printers)
    return printers


def windows_job_name(printer: str) -> str:
    """取打印队列里最新的文档名（= 用户打印的文件名）。队列已清空时返回空串。

    这个走 PowerShell 没关系：只有「收到新落盘文件」时才问一次，不在启动路径上。"""
    name = (printer or "").strip()
    if not name:
        return ""
    script = (
        f"Get-PrintJob -PrinterName {name!r} -ErrorAction SilentlyContinue | "
        "Sort-Object SubmittedTime -Descending | Select-Object -First 1 -ExpandProperty DocumentName"
    )
    code, out = _powershell(script)
    return out.strip() if code == 0 and out else ""


def queue_exists(printer: str, refresh: bool = False) -> bool:
    """虚拟打印机队列是否已安装（Windows 走注册表，毫秒级）"""
    name = (printer or "").strip()
    if not name:
        return False
    if os.name == "nt":
        return any(str(item.get("Name") or "") == name for item in windows_printers(refresh=refresh))
    try:
        done = subprocess.run(
            ["lpstat", "-p", name], capture_output=True, timeout=POWERSHELL_TIMEOUT,
            creationflags=CREATE_NO_WINDOW,
        )
        return done.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def queue_detail(printer: str) -> str:
    """队列的端口（显示用；注册表里没有驱动名，就只报端口）。

    想确认「打到哪个文件/端口」时看它就够了；真要驱动名的地方（装机脚本、自检）另问 PowerShell。"""
    name = (printer or "").strip()
    for item in windows_printers():
        if str(item.get("Name") or "") == name:
            parts = [str(item.get(field) or "") for field in ("DriverName", "PortName")]
            return " / ".join(part for part in parts if part) or "（端口未登记）"
    return ""


def queue_port(printer: str) -> str:
    """队列的端口路径（注册表里读，毫秒级）"""
    name = (printer or "").strip()
    for item in windows_printers():
        if str(item.get("Name") or "") == name:
            return str(item.get("PortName") or "")
    return ""


def spool_mismatch(printer: str) -> str:
    """队列的落盘文件是不是指着**本程序目录**：不是就返回它实际指的地方（空串 = 一致或没装队列）。

    「把数据都放程序旁边」之后必须有的护栏：打印队列是系统对象、端口只能是一个**绝对路径**，
    换目录/换机器后端口还指着老地方的话，PDF 会静默写进那个老文件夹，程序这边看起来「打印没反应」。
    """
    if os.name != "nt":
        return ""
    from vp_config import spool_file_for

    actual = queue_port(printer)
    if not actual:
        return ""
    expected = spool_file_for(printer)
    try:
        if Path(actual).resolve() == expected.resolve():
            return ""
    except OSError:
        if os.path.normcase(str(actual)) == os.path.normcase(str(expected)):
            return ""
    return actual


# ---------------------------------------------------------------- 桌面快捷方式（可选）

SHORTCUT_NAME = "AntiPrint 虚拟打印机"


def desktop_dir() -> Path:
    """桌面目录（Windows 认注册表里的 Shell 文件夹，能正确处理 OneDrive 重定向过的桌面）。

    环境变量 ANTIPRINT_VPRINTER_DESKTOP 可指定（测试用，免得动用户真实桌面）。"""
    override = os.environ.get("ANTIPRINT_VPRINTER_DESKTOP")
    if override:
        return Path(override)
    if os.name == "nt":
        try:
            import winreg

            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
            ) as key:
                raw = str(winreg.QueryValueEx(key, "Desktop")[0] or "")
            if raw:
                return Path(os.path.expandvars(raw))
        except OSError:
            pass
        return Path(os.environ.get("USERPROFILE") or Path.home()) / "Desktop"
    if sys.platform == "darwin":
        return Path.home() / "Desktop"
    try:
        done = subprocess.run(["xdg-user-dir", "DESKTOP"], capture_output=True, timeout=5,
                              creationflags=CREATE_NO_WINDOW)
        text = done.stdout.decode("utf-8", "ignore").strip()
        if done.returncode == 0 and text and Path(text).is_dir():
            return Path(text)
    except (OSError, subprocess.TimeoutExpired):
        pass
    for name in ("Desktop", "桌面"):
        candidate = Path.home() / name
        if candidate.is_dir():
            return candidate
    return Path.home() / "Desktop"


def shortcut_path(desktop: Path | None = None) -> Path:
    """快捷方式文件放哪、叫什么（Windows 是 .lnk，macOS 是 .command，Linux 是 .desktop）"""
    directory = desktop or desktop_dir()
    if os.name == "nt":
        return directory / f"{SHORTCUT_NAME}.lnk"
    if sys.platform == "darwin":
        return directory / f"{SHORTCUT_NAME}.command"
    return directory / "antiprint-vprinter.desktop"


def shortcut_exists(desktop: Path | None = None) -> bool:
    try:
        return shortcut_path(desktop).exists()
    except OSError:
        return False


def _shortcut_icon() -> str:
    """快捷方式用的图标：exe 形态直接用 exe 自带的图标；源码形态现场生成一个 .ico"""
    if IS_FROZEN:
        return sys.executable
    try:
        from vp_config import CONFIG_DIR
        from vp_tray import load_logo

        cache = CONFIG_DIR / "cache"
        cache.mkdir(parents=True, exist_ok=True)
        icon = cache / "antiprint-logo.ico"
        load_logo(256).save(icon, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
        return str(icon)
    except Exception as exc:                     # 生成失败就让系统用默认图标
        LOG.warning("生成快捷方式图标失败：%s", exc)
        return ""


def create_desktop_shortcut(desktop: Path | None = None) -> tuple[bool, str]:
    """在桌面上放一个快捷方式（可选功能；已经存在就直接说一声）。

    对没装 Python 的用户，这是最省事的入口：不用每次去翻解压出来的文件夹。"""
    target = shortcut_path(desktop)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return False, f"找不到桌面目录（{target.parent}）：{exc}"

    if os.name == "nt":
        argv = launch_argv()
        exe, args = argv[0], " ".join(argv[1:])
        icon = _shortcut_icon()
        script = (
            "$ws = New-Object -ComObject WScript.Shell;"
            f"$lnk = $ws.CreateShortcut('{target}');"
            f"$lnk.TargetPath = '{exe}';"
            f"$lnk.Arguments = '{args}';"
            f"$lnk.WorkingDirectory = '{Path(exe).parent}';"
        )
        if icon:
            script += f"$lnk.IconLocation = '{icon},0';"
        script += "$lnk.Description = 'AntiPrint 虚拟打印机（打印即提交到网站）';$lnk.Save()"
        code, out = _powershell(script)
        if code == 0 and target.exists():
            return True, f"已在桌面创建快捷方式「{SHORTCUT_NAME}」，以后双击它就能打开界面。"
        return False, f"创建快捷方式失败：{out[:160] or '未知错误'}"

    command = " ".join(shlex.quote(part) for part in launch_argv())
    if sys.platform == "darwin":
        body = f"#!/bin/sh\nexec {command}\n"
        mode = 0o755
    else:
        body = ("[Desktop Entry]\nType=Application\nName=AntiPrint 虚拟打印机\n"
                "Comment=打印即转 PDF 提交到网站\n"
                f"Exec={command}\nTerminal=false\n")
        mode = 0o644
    try:
        target.write_text(body, encoding="utf-8")
        target.chmod(mode)
        return True, f"已在桌面创建启动项「{target.name}」，以后双击它就能打开界面。"
    except OSError as exc:
        return False, f"创建快捷方式失败：{exc}"
