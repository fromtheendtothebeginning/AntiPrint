# vp_printer.py — 虚拟打印机队列的安装 / 卸载 / 提权（Windows 为主，macOS/Linux 走 CUPS 脚本）
#
# 绿色版的核心：**双击 exe 就能用** —— 队列不在的时候，程序会自己弹一句「要不要安装」，
# 点「是」由程序发起 UAC 提权，用管理员身份把自己再跑一遍（`--install-printer`）把队列建好。
# 用户不需要找脚本、不需要自己开管理员 PowerShell（install/ 里的脚本留着给运维批量装）。
#
# 建队列用的还是系统自带的「Microsoft Print To PDF」驱动 + 一个指向固定文件的本地端口：
# 驱动直接把 PDF 写进那个文件、不弹保存对话框；落盘目录给 Users 改权限（spooler 以 SYSTEM 写、
# 程序以当前用户读）。

from __future__ import annotations

import ctypes
import os
import subprocess
import sys
from pathlib import Path

from vp_config import (
    DEFAULT_PRINTER_NAME,
    LEGACY_PRINTER_NAMES,
    LEGACY_SPOOL_DIR,
    LOG,
    SPOOL_DIR,
    spool_file_for,
)
from vp_platform import CREATE_NO_WINDOW, app_dir, launch_argv, queue_exists

IS_WINDOWS = os.name == "nt"
POWERSHELL_TIMEOUT = 120

# 建/删队列的 PowerShell（**纯 ASCII**：避免 PS 5.1 读参数时的编码问题；中文提示在 Python 侧拼）
# 参数从环境变量来，不走引号拼接，省得被名字里的空格/引号坑到。
INSTALL_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$name  = $env:AP_QUEUE
$spool = $env:AP_SPOOL
$port  = $env:AP_PORT
if (-not (Test-Path $spool)) { New-Item -ItemType Directory -Force -Path $spool | Out-Null }
# 落盘目录就在程序旁边（用户目录下），但真正往里写 PDF 的是**假脱机服务（SYSTEM 身份）**，
# 所以除了当前用户，还要给 SYSTEM 和 Users 写权限，否则打印会静默失败。
& icacls $spool /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null
if ($LASTEXITCODE -ne 0) { throw ("icacls failed for Users with " + $LASTEXITCODE) }
& icacls $spool /grant '*S-1-5-18:(OI)(CI)M' | Out-Null
if ($LASTEXITCODE -ne 0) { throw ("icacls failed for SYSTEM with " + $LASTEXITCODE) }
if (@(Get-PrinterPort | Select-Object -ExpandProperty Name) -notcontains $port) {
  Add-PrinterPort -Name $port | Out-Null
}
$driver = (Get-PrinterDriver | Where-Object { $_.Name -match 'Print To PDF' -and $_.PrinterEnvironment -eq 'Windows x64' } | Select-Object -First 1).Name
if (-not $driver) { $driver = (Get-PrinterDriver | Where-Object { $_.Name -match 'Print To PDF' } | Select-Object -First 1).Name }
if (-not $driver) { throw 'Microsoft Print To PDF driver not found' }
if (Get-Printer -Name $name -ErrorAction SilentlyContinue) {
  Set-Printer -Name $name -DriverName $driver -PortName $port
} else {
  Add-Printer -Name $name -DriverName $driver -PortName $port -Comment 'AntiPrint virtual printer (PDF -> website)'
}
$q = Get-Printer -Name $name
Write-Output ('OK ' + $q.DriverName + ' / ' + $q.PortName)
"""

UNINSTALL_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$name  = $env:AP_QUEUE
$spool = $env:AP_SPOOL
$port  = $env:AP_PORT
if (Get-Printer -Name $name -ErrorAction SilentlyContinue) { Remove-Printer -Name $name }
if (@(Get-PrinterPort | Select-Object -ExpandProperty Name) -contains $port) {
  # 端口可能正被占用（ERROR_BUSY 0x800700aa：队列里还有任务/打印机句柄没释放）——
  # 这种情况下**不要整段失败**：队列已经删掉了，留个端口不影响使用，重启后再清即可。
  try { Remove-PrinterPort -Name $port } catch { Write-Output ('PORT_BUSY ' + $_.Exception.Message) }
}
if ($env:AP_PURGE -eq '1' -and (Test-Path $spool)) { Remove-Item -Recurse -Force $spool }
Write-Output 'OK'
"""

# 清老队列名（只删自己的旧名字：队列 + 它用的端口 + 那个端口的落盘文件）
# AP_PORT_OVERRIDE 非空时只清「指定端口 + 那个文件」（用于清掉老落盘位置的残端口）
LEGACY_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$old   = $env:AP_OLD_QUEUE
$spool = $env:AP_SPOOL
$port  = if ($env:AP_PORT_OVERRIDE) { $env:AP_PORT_OVERRIDE } else { Join-Path $spool ($old + '.pdf') }
$touched = $false
if ($env:AP_PORT_OVERRIDE) {
  if (@(Get-PrinterPort | Select-Object -ExpandProperty Name) -contains $port) { Remove-PrinterPort -Name $port; $touched = $true }
  if (Test-Path $port) { Remove-Item -Force $port }
  Write-Output ($(if ($touched) { 'PORT_REMOVED' } else { 'NONE' }))
  exit 0
}
if (Get-Printer -Name $old -ErrorAction SilentlyContinue) { Remove-Printer -Name $old; $touched = $true }
if (@(Get-PrinterPort | Select-Object -ExpandProperty Name) -contains $port) { Remove-PrinterPort -Name $port; $touched = $true }
if (Test-Path $port) { Remove-Item -Force $port }
Write-Output ($(if ($touched) { 'REMOVED ' + $old } else { 'NONE' }))
"""


def spool_dir() -> Path:
    """队列端口指向的落盘目录：**程序旁边**（`exe旁边\\AntiPrintVPrinter-data\\spool`），
    换机器/换目录后重新点一次「一键安装打印机队列」即可把端口指过来。"""
    return SPOOL_DIR


def legacy_cleanup(name: str) -> list[str]:
    """清掉老版本留下的东西，只碰我们自己的：
      * 老队列名（如全大写的 ANTIPRINT）；
      * 老落盘位置：`%ProgramData%\\AntiPrint\\spool\\<当前队列名>.pdf`。
        2026-09-16 起落盘文件改到「程序旁边的数据目录」里，老端口留着没用（就是个没人指向的
        本机端口），顺手删掉，别在系统里留垃圾。
    返回被清掉的老队列名（给用户看的说明用）。"""
    if not IS_WINDOWS:
        return []
    removed: list[str] = []
    for old in LEGACY_PRINTER_NAMES:
        if not old or old == name:
            continue
        code, out, _ = _powershell(LEGACY_SCRIPT, {"AP_OLD_QUEUE": old, "AP_SPOOL": str(spool_dir())})
        if code == 0 and out.startswith("REMOVED"):
            removed.append(old)
            LOG.info("已清掉老版本的打印机队列：%s", old)
    legacy_port = LEGACY_SPOOL_DIR / f"{name}.pdf"
    code, out, _ = _powershell(LEGACY_SCRIPT, {"AP_OLD_QUEUE": "（只清端口）", "AP_SPOOL": str(LEGACY_SPOOL_DIR),
                                              "AP_PORT_OVERRIDE": str(legacy_port)})
    if "PORT_REMOVED" in out:
        LOG.info("已清掉老落盘位置的端口与残留文件：%s", legacy_port)
    return removed


def is_admin() -> bool:
    """当前进程是不是管理员身份（Windows 用 OpenProcessToken 判断）"""
    if not IS_WINDOWS:
        return os.geteuid() == 0 if hasattr(os, "geteuid") else False
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except (AttributeError, OSError):
        return False


def _powershell(script: str, extra_env: dict) -> tuple[int, str, str]:
    env = dict(os.environ, **extra_env)
    try:
        done = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
            capture_output=True, timeout=POWERSHELL_TIMEOUT, env=env, creationflags=CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return -1, "", str(exc)
    return (
        done.returncode,
        done.stdout.decode("utf-8", "ignore").strip(),
        done.stderr.decode("utf-8", "ignore").strip(),
    )


def _clean_error(stderr: str) -> str:
    """PowerShell 报错一长串，取最后一行有用的；顺手把常见的英文错误翻成人话"""
    lines = [line.strip() for line in (stderr or "").splitlines() if line.strip()]
    text = lines[-1] if lines else ""
    if "Access is denied" in text or "拒绝访问" in text:
        return "需要管理员权限（UAC 被拒绝或没提权）"
    return text[:200] or "未知错误"


def _manual_command(flag: str) -> str:
    """给用户抄的命令行（exe 形态就是「exe --install-printer」）"""
    return " ".join(f'"{part}"' for part in launch_argv(flag))


def install(printer: str, spool: Path | None = None) -> tuple[bool, str]:
    """建/修复队列（需要管理员身份）。返回（是否成功，给用户看的中文说明）"""
    name = (printer or "").strip() or DEFAULT_PRINTER_NAME
    if not IS_WINDOWS:
        script = app_dir() / "install" / "setup-cups.sh"
        return False, (f"macOS / Linux 请用 CUPS 安装脚本：sudo bash {script}\n"
                       "（它会把 CUPS 后端装好并建一台名叫 %s 的队列）" % name)
    if not is_admin():
        # 先拦一道：不然后面 PowerShell 会报一串 Access is denied，用户看不懂
        return False, ("需要管理员权限才能安装打印队列。\n"
                       "从程序里点「一键安装打印机队列」会自动弹出授权窗口；"
                       "也可以自己用「以管理员身份运行」的 PowerShell 执行：\n"
                       f"{_manual_command('--install-printer')}")
    # 幂等：已经装了也会重设一遍驱动/端口（端口被改坏时正好当「修复」用）
    directory = spool or spool_dir()
    port = Path(spool) / f"{name}.pdf" if spool is not None else spool_file_for(name)
    code, out, err = _powershell(INSTALL_SCRIPT, {
        "AP_QUEUE": name, "AP_SPOOL": str(directory), "AP_PORT": str(port),
    })
    if code != 0 or not out.startswith("OK"):
        detail = _clean_error(err) or out
        LOG.error("建队列失败：%s", detail)
        if "管理员" in detail:
            return False, f"安装失败：{detail}\n请点「是」以管理员身份重试。"
        return False, f"安装失败：{detail}"
    LOG.info("队列已就绪：%s（%s）", name, out[3:].strip())
    removed = legacy_cleanup(name)          # 顺手清掉老版本留下的队列名（如 ANTIPRINT）
    note = f"\n（顺手清掉了老版本的队列：{'、'.join(removed)}）" if removed else ""
    return True, (f"已经装好虚拟打印机「{name}」（驱动/端口：{out[3:].strip()}）{note}\n"
                  "现在可以在任意程序里 Ctrl+P 选它了。")


def uninstall(printer: str, purge: bool = True) -> tuple[bool, str]:
    """删除队列（需要管理员身份）；purge=True 时连落盘目录一起删"""
    name = (printer or "").strip() or DEFAULT_PRINTER_NAME
    if not IS_WINDOWS:
        script = app_dir() / "install" / "uninstall-cups.sh"
        return False, f"macOS / Linux 请用 CUPS 卸载脚本：sudo bash {script} [--purge]"
    if not is_admin():
        return False, ("需要管理员权限才能删除打印队列。\n"
                       "从程序里点「卸载队列」会自动弹出授权窗口；"
                       "也可以自己用「以管理员身份运行」的 PowerShell 执行：\n"
                       f"{_manual_command('--uninstall-printer')}")
    if not queue_exists(name):
        return True, f"队列 {name} 本来就没装（无需卸载）"
    directory = spool_dir()
    port = spool_file_for(name)
    code, out, err = _powershell(UNINSTALL_SCRIPT, {
        "AP_QUEUE": name, "AP_SPOOL": str(directory), "AP_PORT": str(port),
        "AP_PURGE": "1" if purge else "0",
    })
    port_busy = "PORT_BUSY" in out
    if "OK" in out:
        LOG.info("队列已删除：%s（落盘目录%s%s）", name, "一并删除" if purge else "保留",
                 "；端口被占用未删除" if port_busy else "")
        note = ("\n端口文件没能删掉（它正被占用，通常是队列里还有任务）——"
                "不影响使用，下次重启后再点一次「卸载队列」即可清掉。" if port_busy else "")
        return True, (f"已删除虚拟打印机「{name}」" + ("，落盘目录也清掉了。" if purge else "。") + note +
                      "\n程序本身没动：不想要了直接把这个文件夹删掉即可。")
    detail = _clean_error(err) or out
    LOG.error("删队列失败：%s", detail)
    return False, f"卸载失败：{detail}"


# ---------------------------------------------------------------- 提权

def elevate_command(extra_args: list[str]) -> tuple[str, str]:
    """把「再跑一遍自己」写成 (可执行文件, 参数字符串)，给 ShellExecute 的 runas 用"""
    argv = launch_argv(*extra_args)
    return argv[0], " ".join(f'"{part}"' for part in argv[1:])


def elevate_and_wait(extra_args: list[str], timeout_ms: int = 300000) -> tuple[bool, str]:
    """以管理员身份再跑一遍自己（会弹 UAC），等它结束。

    返回（是否成功启动并正常结束，说明）。用户点了「否」→ (False, "已取消")。
    **会阻塞**，请在后台线程里调用（别卡住托盘/界面）。
    """
    if not IS_WINDOWS:
        return False, "只有 Windows 需要提权安装；macOS/Linux 请用 install/ 下的 CUPS 脚本。"
    launcher, params = elevate_command(extra_args)
    if not Path(launcher).exists():
        return False, f"找不到可执行文件：{launcher}"
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    class SHELLEXECUTEINFOW(ctypes.Structure):
        _fields_ = [
            ("cbSize", ctypes.c_ulong),
            ("fMask", ctypes.c_ulong),
            ("hwnd", ctypes.c_void_p),
            ("lpVerb", ctypes.c_wchar_p),
            ("lpFile", ctypes.c_wchar_p),
            ("lpParameters", ctypes.c_wchar_p),
            ("lpDirectory", ctypes.c_wchar_p),
            ("nShow", ctypes.c_int),
            ("hInstApp", ctypes.c_void_p),
            ("lpIDList", ctypes.c_void_p),
            ("lpClass", ctypes.c_wchar_p),
            ("hkeyClass", ctypes.c_void_p),
            ("dwHotKey", ctypes.c_ulong),
            ("hIcon", ctypes.c_void_p),
            ("hProcess", ctypes.c_void_p),
        ]

    SEE_MASK_NOCLOSEPROCESS = 0x00000040
    SW_SHOWNORMAL = 1
    info = SHELLEXECUTEINFOW()
    info.cbSize = ctypes.sizeof(info)
    info.fMask = SEE_MASK_NOCLOSEPROCESS
    info.lpVerb = "runas"
    info.lpFile = launcher
    info.lpParameters = params
    info.nShow = SW_SHOWNORMAL
    if not shell32.ShellExecuteExW(ctypes.byref(info)):
        error = ctypes.get_last_error()
        if error == 1223:               # ERROR_CANCELLED
            return False, "已取消（安装打印机队列需要管理员授权）"
        return False, f"提权失败（错误码 {error}）"
    exit_code = 0
    if info.hProcess:
        kernel32.WaitForSingleObject(ctypes.c_void_p(info.hProcess), timeout_ms)
        code = ctypes.c_ulong()
        kernel32.GetExitCodeProcess(ctypes.c_void_p(info.hProcess), ctypes.byref(code))
        kernel32.CloseHandle(ctypes.c_void_p(info.hProcess))
        exit_code = int(code.value)
    return exit_code == 0, "安装完成" if exit_code == 0 else f"安装未完成（退出码 {exit_code}）"


# ---------------------------------------------------------------- 弹窗（没控制台时唯一能说话的方式）

def info_box(title: str, text: str) -> None:
    """提示框：exe（窗口程序）里被提权跑完那一下，就靠它告诉用户结果"""
    if IS_WINDOWS:
        try:
            ctypes.windll.user32.MessageBoxW(None, text, title, 0x40)   # MB_ICONINFORMATION
            return
        except (AttributeError, OSError):
            pass
    _shell_dialog(title, text, None)


def ask_yes_no(title: str, text: str) -> bool:
    """是/否 确认框（托盘菜单里卸载队列前问一句）"""
    if IS_WINDOWS:
        try:
            return ctypes.windll.user32.MessageBoxW(None, text, title, 0x24) == 6   # MB_YESNO → IDYES
        except (AttributeError, OSError):
            pass
    return _shell_dialog(title, text, "yesno") == "yes"


def _shell_dialog(title: str, text: str, mode: str | None) -> str | None:
    """macOS 用 osascript、Linux 用 zenity/kdialog；都没有就只写日志（GUI 场景本来也少见）"""
    if sys.platform == "darwin":
        buttons = '{"取消", "确定"}' if mode else '{"好"}'
        default = "确定" if mode == "yesno" else "好"
        script = f'display dialog {text!r} with title {title!r} buttons {buttons} default button {default}'
        try:
            done = subprocess.run(["osascript", "-e", script], capture_output=True, timeout=600)
            return "yes" if done.returncode == 0 and default.encode() in done.stdout else ("no" if mode else None)
        except (OSError, subprocess.TimeoutExpired):
            return None
    for tool, args in (("zenity", ["--question" if mode else "--info", f"--title={title}", f"--text={text}"]),
                       ("kdialog", ["--yesno" if mode else "--msgbox", text, "--title", title])):
        path = _which(tool)
        if not path:
            continue
        try:
            code = subprocess.run([path, *args], timeout=600, creationflags=CREATE_NO_WINDOW).returncode
            return "yes" if code == 0 else "no"
        except (OSError, subprocess.TimeoutExpired):
            return None
    LOG.info("%s：%s", title, text.replace("\n", " "))
    return None


def _which(tool: str) -> str:
    from shutil import which

    return which(tool) or ""
