# -*- coding: utf-8 -*-
"""exe 分发包用例（临时脚本，不算交付代码）。

验证 dist/AntiPrintVPrinter-<版本>.zip 里的单文件 exe：
  1. 单文件 exe 能跑、自检/状态有输出（窗口程序靠 AttachConsole 挂到调用方控制台）
  2. --status 报告「运行形态 = exe」、程序目录指向 exe 所在文件夹
  3. --simulate 端到端：exe 自己登录 → 转 PDF → 提交到网站 → 网站上出现「待审核」任务 → 删除
  4. exe 起托盘常驻后，Windows 右下角（通知区/溢出层）能看到 AntiPrint 图标
  5. 冻结形态的自启动命令 = exe 自己、拉起配置窗口 = 「exe --settings」
  6. zip 内容：install/ 脚本齐全、README 带 BOM+CRLF、bat 是 CRLF、不含配置/令牌
  7. 单文件 exe 的启动耗时（用户体验参考）

跑法： backend\\.venv\\Scripts\\python.exe .tmp-test\\vprinter_exe_test.py
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "vprinter"))

import requests                                                              # noqa: E402

BASE = "http://127.0.0.1:8301"
SAMPLE = ROOT / ".tmp-test" / "test-print.pdf"
STAGE = ROOT / "dist" / "AntiPrintVPrinter"
EXE = STAGE / "AntiPrintVPrinter.exe"          # 分发包里那份（只读，不要直接拿去当常驻跑）
EXE_TEST = None                                # 用例自己的副本（见 stop_all 的说明），建好临时目录后赋值

PASS = 0
FAIL = 0
CREATED: list[int] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  [OK  ] {name}" + (f" — {detail}" if detail else ""))
    else:
        FAIL += 1
        print(f"  [FAIL] {name}" + (f" — {detail}" if detail else ""))


def section(title: str) -> None:
    print(f"\n== {title} ==")


def note(text: str) -> None:
    """提示信息（不计入通过/失败）：环境限制导致的「验不了」，别伪装成通过"""
    print(f"  [SKIP] {text}")


def req(method: str, path: str, token: str = "", **kwargs):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    resp = requests.request(method, BASE + path, headers=headers, timeout=30, **kwargs)
    try:
        return resp.status_code, resp.json()
    except ValueError:
        return resp.status_code, {}


def run_exe(*args: str, timeout: int = 120) -> tuple[int, str]:
    """跑用例自己那份 exe（不是分发包里那份），返回（退出码，标准输出）。
    用测试自己的 ANTIPRINT_VPRINTER_HOME（不然会去读写真用户的配置），
    并设 ANTIPRINT_VPRINTER_NO_CONSOLE=1 禁止它 AttachConsole —— 否则窗口程序会把输出
    写到调用方的控制台而不是这根管道里，断言就抓不到东西了（真人从 cmd 里跑时才是那个行为）。"""
    env = dict(ENV, ANTIPRINT_VPRINTER_NO_CONSOLE="1")
    done = subprocess.run([str(EXE_TEST), *args], capture_output=True, timeout=timeout, env=env)
    text = (done.stdout + done.stderr).decode("utf-8", errors="replace")
    return done.returncode, text.strip()


def admin_token() -> str:
    """管理员令牌：优先用 .tmp-test/.admin-token.json 的缓存（登录接口 10 次/分钟限速），
    缓存没了或失效了就用 admin/admin123 登一次并写回缓存。"""
    cache = ROOT / ".tmp-test" / ".admin-token.json"
    try:
        token = json.loads(cache.read_text(encoding="utf-8")).get("token") or ""
        if token and req("GET", "/api/settings", token)[0] == 200:
            return token
    except (OSError, ValueError):
        pass
    code, data = req("POST", "/api/login", json={"username": "admin", "password": "admin123"})
    assert code == 200, f"管理员登录失败：{code} {data}"
    cache.write_text(json.dumps({"token": data["token"], "ts": int(time.time() * 1000)}), encoding="utf-8")
    return data["token"]


ADMIN = admin_token()

HOME = Path(tempfile.mkdtemp(prefix="vp-exe-"))
ENV = dict(os.environ, ANTIPRINT_VPRINTER_HOME=str(HOME / "home"))
# 用例只跑**自己的这份副本**：分发包里那份可能正被用户当常驻程序跑着，
# 而单文件 exe 的「停」只能按进程名杀（父子两个），按名字杀会连用户那份一起端掉 —— 绝对不行。
EXE_TEST = HOME / "AntiPrintVPrinter.exe"
shutil.copy2(EXE, EXE_TEST)

print(f"exe 用例（exe 路径 {EXE}，用例副本 {EXE_TEST}）")


def _probe_select() -> str:
    """挑出本副本的进程（父=解包器、子=程序本身，可执行文件路径相同）"""
    return ("(Get-CimInstance Win32_Process | Where-Object { "
            f"$_.ExecutablePath -eq '{EXE_TEST}' }})")


def test_process_count() -> int:
    """本副本还活着几个进程 —— 判断守护进程在不在，比看状态字段更直接"""
    done = subprocess.run(["powershell", "-NoProfile", "-Command", f"{_probe_select()}.Count"],
                          capture_output=True, timeout=60)
    try:
        return int(done.stdout.decode("utf-8", "ignore").strip() or 0)
    except ValueError:
        return -1


def stop_all() -> int:
    """停掉**本次用例启动的** exe 进程，返回剩余数量。

    单文件 exe 是「父进程解包 + 子进程跑程序」两个进程：Popen.terminate() 只杀得掉父进程，
    子进程会活下来继续占托盘图标与单实例锁 —— 所以停的时候按可执行文件路径精确匹配，
    把这份副本的父子进程一起停（真人用的是 `stop-vprinter.bat`，它按进程名杀，
    在只有一份 exe 的机器上等价，但会误伤别人正在跑的副本，所以用例里不用它）。"""
    kill = f"{_probe_select()} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}"
    subprocess.run(["powershell", "-NoProfile", "-Command", kill], capture_output=True, timeout=60)
    time.sleep(1.5)
    return test_process_count()


# ------------------------------------------------------------------ 1. exe 存在且能跑

section("1. 单文件 exe 能跑起来")
check("分发包里的 exe 存在", EXE.is_file(), f"{EXE}（{EXE.stat().st_size // 1048576 if EXE.is_file() else 0}MB）")
started = time.time()
code, out = run_exe("--status")
elapsed = time.time() - started
payload = {}
try:
    payload = json.loads(out)
except ValueError:
    pass
check("--status 输出可解析的 JSON（窗口程序也有输出）", bool(payload) and code == 0, out[:120])
check("自报「运行形态 = exe」", payload.get("运行形态") == "exe", str(payload.get("运行形态")))
check("程序目录 = exe 所在文件夹", str(payload.get("程序目录", "")).lower() == str(EXE_TEST.parent).lower(),
      str(payload.get("程序目录")))
check("exe 自带网站 logo（包内 assets/antiprint-logo.png，不依赖仓库的 frontend 目录）",
      "antiprint-logo.png" in str(payload.get("图标", "")), str(payload.get("图标")))
check("单文件 exe 冷启动可以接受（< 8 秒，含一次性解包到临时目录）", elapsed < 8, f"{elapsed:.2f} 秒")

section("1b. 没有 Python 的机器上照样能用")
clean = {k: v for k, v in os.environ.items() if k not in ("PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV")}
clean["PATH"] = r"C:\Windows\system32;C:\Windows"          # PATH 里没有 python
clean["PYTHONHOME"] = r"C:\no-such-python"                    # 乱指也不该被它带崩
clean["PYTHONPATH"] = r"C:\no-such-python"
clean["ANTIPRINT_VPRINTER_HOME"] = str(HOME / "nopython")
clean["ANTIPRINT_VPRINTER_NO_CONSOLE"] = "1"
done = subprocess.run([str(EXE_TEST), "--status"], capture_output=True, timeout=90, env=clean)
out = done.stdout.decode("utf-8", "ignore")
check("PATH 里没有 python、PYTHONHOME 乱指，exe 照样跑出 JSON",
      done.returncode == 0 and '"version"' in out,
      f"退出码 {done.returncode}；PATH={clean['PATH']}")

# 桌面快捷方式：用临时「桌面」（环境变量覆盖），验证它指向 exe 自己（冻结形态最容易悄悄指错）
desk = HOME / "假桌面"
desk.mkdir(parents=True, exist_ok=True)
short_env = dict(ENV, ANTIPRINT_VPRINTER_DESKTOP=str(desk), ANTIPRINT_VPRINTER_NO_CONSOLE="1")
done = subprocess.run([str(EXE_TEST), "--create-shortcut"], capture_output=True, timeout=120, env=short_env)
shortcut = desk / "AntiPrint 虚拟打印机.lnk"
check("exe 能自己创建桌面快捷方式（--create-shortcut）",
      done.returncode == 0 and shortcut.exists(),
      done.stdout.decode("utf-8", "ignore").strip()[:160] or "（没输出）")
if shortcut.exists():
    probe = ("$ws = New-Object -ComObject WScript.Shell; "
             f"$l = $ws.CreateShortcut('{shortcut}'); $l.TargetPath")
    done = subprocess.run(["powershell", "-NoProfile", "-Command", probe], capture_output=True, timeout=60)
    target = done.stdout.decode("utf-8", "ignore").strip()
    check("快捷方式指向 exe 本身（不是 python 也不是别人）",
          target.lower() == str(EXE_TEST).lower(), f"目标={target}")
# 再跑一次：应当说「已经有了」而不是覆盖出问题
done = subprocess.run([str(EXE_TEST), "--create-shortcut"], capture_output=True, timeout=120, env=short_env)
check("重复创建不报错", done.returncode == 0, done.stdout.decode("utf-8", "ignore").strip()[:120])

# ------------------------------------------------------------------ 2. 自检

section("2. 自检（--selftest）")
code, out = run_exe("--selftest")
check("自检有逐项输出", "虚拟打印机队列" in out and "托盘图标" in out, out.splitlines()[0] if out else "（无输出）")
check("自检写明 exe 形态与程序目录", "exe 形态" in out and str(EXE_TEST.parent) in out)
check("自检里托盘可用（pystray/Pillow 已打进 exe）", "[OK  ] 托盘图标" in out)
check("未配置账号时关键项不通过、退出码 1（提示去填账号）", code == 1 and "还没填写用户名/密码" in out)

# ------------------------------------------------------------------ 3. exe 端到端

section("3. exe 端到端：注册账号 → 充值 → exe --simulate → 网站上出现任务")
stamp = str(int(time.time()))[-6:]
user = f"vpexe{stamp}"
s_code, _ = req("POST", "/api/register", json={"username": user, "password": "vptest123"})
assert s_code == 200, f"注册失败：{s_code}"
users = req("GET", "/api/users", ADMIN)[1]["users"]
uid = next(u["id"] for u in users if u["username"] == user)
assert req("POST", f"/api/users/{uid}/balance", ADMIN, json={"delta": "5", "note": "exe 用例"})[0] == 200

(HOME / "home").mkdir(parents=True, exist_ok=True)
(HOME / "home" / "config.json").write_text(json.dumps({
    "server": BASE, "auth_mode": "local", "username": user, "password": "vptest123",
    "delivery_mode": "取件", "address": "", "note": "exe 用例", "copies": 1,
    "printer_name": "AntiPrint-1.0.0", "watch_dirs": [], "paused": False, "autostart": False,
}, ensure_ascii=False), encoding="utf-8")

code, out = run_exe("--simulate", str(SAMPLE))
check("exe 自己登录并提交成功", code == 0 and "成功" in out, out.strip()[:160])
job_id = 0
match = re.search(r"#(\d+)", out)
if match:
    job_id = int(match.group(1))
    CREATED.append(job_id)
token = req("POST", "/api/login", json={"username": user, "password": "vptest123"})[1].get("token", "")
jobs = req("GET", "/api/jobs/mine", token)[1].get("jobs", [])
job = next((j for j in jobs if j["id"] == job_id), None)
check("网站上能查到这条任务且是「待审核」", bool(job) and job["status"] == "待审核",
      job and f"{job['status']} {job['files'][0]['filename']}")
check("任务文件名与备注正确", bool(job) and job["files"][0]["filename"] == "test-print.pdf"
      and job["note"] == "exe 用例", job and f"{job['files'][0]['filename']} / {job['note']}")
check("exe 把登录令牌写回了自己的配置", bool(json.loads((HOME / "home" / "config.json").read_text(encoding="utf-8")).get("token")))

# ------------------------------------------------------------------ 4. 托盘图标

section("4. exe 常驻 + Windows 右下角托盘图标")
proc = subprocess.Popen([str(EXE_TEST)], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    # 等「托盘图标已显示」这行日志出现（单文件 exe 冷启动 6 秒左右 + 托盘初始化，
    # 固定等 10 秒会偶发抢跑 —— 2026-09-16 就闪失败过一次），最长等 30 秒
    log_file = HOME / "home" / "log" / "vprinter.log"
    tray_line = ""
    deadline = time.time() + 30
    while time.time() < deadline:
        if log_file.exists():
            log_text = log_file.read_text(encoding="utf-8", errors="replace")
            tray_line = next((line for line in log_text.splitlines() if "托盘图标已显示" in line), "")
            if tray_line:
                break
        time.sleep(1)
    check("exe 常驻进程还活着（没崩）", proc.poll() is None, f"exit={proc.poll()}")
    # 「图标真的挂上系统托盘了」以应用自己的日志为准：pystray 的 setup 回调在
    # Shell_NotifyIcon 成功之后才执行（失败会抛异常），所以这行日志就是「Shell 收下了」的证据。
    check("托盘图标已被系统托盘接受（应用日志里的就绪信号）", bool(tray_line),
          tray_line or "（等 30 秒也没等到「托盘图标已显示」）")
    check("该图标取自网站 logo", "apple-touch-icon.png" in tray_line or "antiprint-logo.png" in tray_line,
          tray_line)
    # 下面再用 UI Automation 佐证一次。Win11 的「显示隐藏的图标」按钮在有些状态下不再支持
    # Invoke（实测报 Unsupported Pattern），溢出层打不开时枚举不到 —— 那就只提示、不算失败。
    visible = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                              str(ROOT / ".tmp-test" / "tray_check.ps1"), "-Match", "AntiPrint"],
                             capture_output=True, timeout=120)
    visible_text = visible.stdout.decode("utf-8", "ignore")
    found_visible = any(line.strip().startswith("- ") and "AntiPrint" in line
                        for line in visible_text.splitlines())
    flyout = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                             str(ROOT / ".tmp-test" / "tray_flyout_check.ps1")],
                            capture_output=True, timeout=120)
    flyout_text = flyout.stdout.decode("utf-8", "ignore")
    found_flyout = "FOUND=AntiPrint" in flyout_text
    if found_visible or found_flyout:
        check("UI Automation 也能在右下角看到它", True,
              f"常显区={'有' if found_visible else '无'} ／ 溢出层={'有' if found_flyout else '无'}")
    else:
        note("UI Automation 这次没看到（Win11 溢出层那个按钮不再支持 Invoke，检测打不开）；"
             "以应用日志为准 —— 12:57 那次同一套检测是能看到图标的")
    # 托盘常驻时也能查状态（互不干扰）
    live = test_process_count()
    check("守护进程确实在跑（本副本有进程活着）", live > 0, f"{live} 个进程")
    code, out = run_exe("--status")
    check("--status 能看到守护进程在跑", '"守护进程": true' in out,
          " ".join(line.strip() for line in out.splitlines() if "守护进程" in line) or out[:120])
finally:
    proc.terminate()                 # 只杀得掉父进程（解包器），子进程要靠下面这步
    left = stop_all()
    check("用例能把 exe 的父子进程一起停干净（托盘「退出」走的就是这套）", left == 0, f"剩余 {left} 个")

# ------------------------------------------------------------------ 4b. 退出程序

section("4b. 退出：配置界面窗口一起关掉，守护进程不受影响")
# 配置界面是另一个进程；单文件 exe 下它自己还是「解包器父进程 + 程序子进程」两个 ——
# 「退出」必须把整树关掉（2026-09-16 用户反馈「托盘图标关闭后程序没有真正关闭」），
# 同时绝不能碰到守护进程（它得继续监听打印任务、继续出纸）。
HELPER = ROOT / ".tmp-test" / "settings_close_helper.py"
ENV_QUIET = dict(ENV, ANTIPRINT_VPRINTER_NO_GUI="1")     # 别让首次引导再开一个窗口来捣乱


def helper(action: str):
    """在另一个进程里调产品代码（文件方式，命令行里不会出现 --settings）。

    匹配规则是按形态算的（exe 形态 = AntiPrintVPrinter.exe），helper 跑在源码 python 里，
    所以要加 `--frozen` 让它冒充 exe 形态，否则它看不到分发包的窗口。"""
    done = subprocess.run([sys.executable, str(HELPER), action, "--frozen"],
                          capture_output=True, timeout=120, env=ENV_QUIET)
    return json.loads(done.stdout.decode("utf-8", "ignore").strip() or "null")


def settings_proc_count() -> int:
    """本副本里命令行带 --settings 的进程数（配置界面窗口）"""
    sel = ("(Get-CimInstance Win32_Process | Where-Object { "
           f"$_.ExecutablePath -eq '{EXE_TEST}' -and $_.CommandLine -like '*--settings*' }}).Count")
    done = subprocess.run(["powershell", "-NoProfile", "-Command", sel], capture_output=True, timeout=60)
    try:
        return int(done.stdout.decode("utf-8", "ignore").strip() or 0)
    except ValueError:
        return -1


def daemon_proc_count() -> int:
    """守护进程占的进程数 = 本副本总数 - 配置界面窗口数"""
    return test_process_count() - settings_proc_count()


quit_proc = subprocess.Popen([str(EXE_TEST)], env=ENV_QUIET,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
window_proc = None
try:
    time.sleep(12)                                   # 冷启动解包 + 托盘就绪
    running = daemon_proc_count()
    check("守护进程起来了（下面要验它不被误杀）", quit_proc.poll() is None and running >= 2,
          f"本副本进程 {test_process_count()} 个（守护 {running}）")
    window_proc = subprocess.Popen([str(EXE_TEST), "--settings"], env=ENV_QUIET,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(10)                                   # 单文件 exe 冷启动要 5~7 秒
    opened = settings_proc_count()
    check("配置界面窗口开着（父/子两个进程）", opened >= 1, f"{opened} 个")
    pids = helper("list")
    check("产品代码能认出配置界面进程（命令行里的 --settings）",
          isinstance(pids, list) and len(pids) >= 1, str(pids))
    killed = helper("close")
    time.sleep(2)
    check("退出把配置界面窗口整树关掉（解包器父进程不残留）",
          isinstance(killed, int) and killed >= 1 and settings_proc_count() == 0,
          f"停掉 {killed} 个，剩余 {settings_proc_count()} 个")
    check("关窗口不误杀守护进程（进程数不变、没退出）",
          quit_proc.poll() is None and daemon_proc_count() == running,
          f"守护 {daemon_proc_count()} 个（原 {running} 个）")
    log_text = (HOME / "home" / "log" / "vprinter.log").read_text(encoding="utf-8", errors="replace")
    check("守护进程日志里没有 ERROR", "ERROR" not in log_text, log_text[-160:])
finally:
    if window_proc is not None and window_proc.poll() is None:
        window_proc.terminate()
    quit_proc.terminate()
    left = stop_all()
    check("收尾：本副本进程停干净", left == 0, f"剩余 {left} 个")

# ------------------------------------------------------------------ 5. 冻结形态下的命令行

section("5. 冻结形态：自启动命令与配置窗口都指向 exe")
import vp_platform                                                           # noqa: E402

saved_frozen = vp_platform.IS_FROZEN
saved_exe = sys.executable
try:
    # 让 vp_platform 以为自己在 exe 里（sys 是同一个模块对象，测完立刻还原）
    vp_platform.IS_FROZEN = True
    sys.executable = str(EXE_TEST)
    frozen_argv = vp_platform.launch_argv("--settings")
    check("exe 形态拉起配置窗口 = 「exe --settings」（不带脚本路径）",
          frozen_argv == [str(EXE_TEST), "--settings"], " ".join(frozen_argv))
    check("exe 形态的自启动命令 = exe 自己（不带 .py 脚本路径）",
          vp_platform.autostart_command() == f'"{EXE_TEST}" --silent', vp_platform.autostart_command())
    check("exe 形态的程序目录 = exe 所在文件夹",
          vp_platform.app_dir() == EXE_TEST.parent, str(vp_platform.app_dir()))
finally:
    vp_platform.IS_FROZEN = saved_frozen
    sys.executable = saved_exe
src_argv = vp_platform.launch_argv("--settings")
check("源码形态仍然带 virtual_printer.py（没改坏原来那条路）",
      len(src_argv) == 3 and src_argv[2] == "--settings", " ".join(src_argv))

# 配置窗口在 exe 里能不能起来（tkinter/tcl 是否打进包）—— 真的拉一个窗口，用 UI Automation 找它
settings = subprocess.Popen([str(EXE_TEST), "--settings"], env=ENV,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(10)
    done = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                           str(ROOT / ".tmp-test" / "tray_check.ps1"), "-Match", "AntiPrint"],
                          capture_output=True, timeout=120)
    windows = done.stdout.decode("utf-8", "ignore")
    title_line = next((l for l in windows.splitlines() if l.startswith("WINDOW_TITLE=")), "")
    check("exe 能拉起配置窗口（Tk 已打进包）", "AntiPrint" in title_line and "配置" in title_line, title_line or windows[-200:])
    check("配置窗口进程还活着", settings.poll() is None, f"exit={settings.poll()}")
finally:
    settings.terminate()
    stop_all()

# ------------------------------------------------------------------ 6. 绿色模式

section("6. 绿色模式：双击 exe 就能用，数据在程序旁边")
green_dir = HOME / "绿色目录 test"          # 名字里带空格与中文，顺便验路径处理
green_dir.mkdir(parents=True, exist_ok=True)
green_exe = green_dir / "AntiPrintVPrinter.exe"
shutil.copy2(EXE, green_exe)
green_data = green_dir / "AntiPrintVPrinter-data"

clean_env = {k: v for k, v in os.environ.items()
             if k not in ("ANTIPRINT_VPRINTER_HOME", "ANTIPRINT_VPRINTER_SPOOL",
                          "ANTIPRINT_VPRINTER_CUPS_SPOOL")}
clean_env["ANTIPRINT_VPRINTER_NO_CONSOLE"] = "1"
done = subprocess.run([str(green_exe), "--status"], capture_output=True, timeout=120, env=clean_env)
payload = json.loads(done.stdout.decode("utf-8", "ignore") or "{}")
check("不带任何参数双击/直接跑就能用（--status 正常）", done.returncode == 0 and bool(payload), str(done.returncode))
check("数据就地存放在 exe 旁边（绿色模式）",
      payload.get("数据模式") == "绿色模式（程序旁边）"
      and Path(payload.get("数据目录", "")).name == "AntiPrintVPrinter-data"
      and Path(payload.get("数据目录", "")).parent == green_dir,
      f"{payload.get('数据模式')} → {payload.get('数据目录')}")
done = subprocess.run([str(green_exe), "--init-config"], capture_output=True, timeout=120, env=clean_env)
check("配置文件真的落在那个目录里", (green_data / "config.json").is_file(),
      str(sorted(p.name for p in green_data.glob("*"))[:6]))
check("实例锁就在程序旁边的数据目录里（不带任何东西去 LOCALAPPDATA）",
      str(payload.get("实例锁", "")).startswith(str(green_data)),
      str(payload.get("实例锁")))
check("落盘文件也在同一个数据目录里（打印数据跟着文件夹走）",
      any(str(green_data) in str(item) for item in payload.get("监听目标", [])),
      str(payload.get("监听目标")))

# 程序目录不可写时的回落：拿一个同名「文件」占住目录名，程序应当退到用户目录
blocked_dir = HOME / "只读目录 test"
blocked_dir.mkdir(parents=True, exist_ok=True)
blocked_exe = blocked_dir / "AntiPrintVPrinter.exe"
shutil.copy2(EXE, blocked_exe)
(blocked_dir / "AntiPrintVPrinter-data").write_text("占位文件，让 mkdir 失败", encoding="utf-8")
done = subprocess.run([str(blocked_exe), "--status"], capture_output=True, timeout=120, env=clean_env)
payload = json.loads(done.stdout.decode("utf-8", "ignore") or "{}")
check("程序旁边写不了就自动回落到用户目录（不会崩）",
      done.returncode == 0 and payload.get("数据模式") == "用户目录", str(payload.get("数据模式")))

section("6b. 队列自助安装（本会话不是管理员，验提示而不是真装）")
spool_root = Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "AntiPrint"
had_spool = spool_root.exists()
done = subprocess.run([str(EXE_TEST), "--install-printer"], capture_output=True, timeout=120,
                      env=dict(ENV, ANTIPRINT_VPRINTER_NO_CONSOLE="1"))
text = (done.stdout + done.stderr).decode("utf-8", "ignore")
check("非管理员跑 --install-printer：明确提示需要管理员、给出手抄命令",
      done.returncode == 1 and "需要管理员权限" in text and "--install-printer" in text,
      text.strip().splitlines()[0] if text.strip() else "")
check("非管理员时不会改动系统（没有偷偷建落盘目录）", had_spool or not spool_root.exists(),
      f"{spool_root} {'已存在（装过队列的机器上正常）' if had_spool else '未被创建'}")

section("6c. 提权命令与托盘菜单")
import vp_platform                                                           # noqa: E402
import vp_printer                                                            # noqa: E402

saved_frozen, saved_exe = vp_platform.IS_FROZEN, sys.executable
try:
    vp_platform.IS_FROZEN, sys.executable = True, str(EXE_TEST)
    launcher, params = vp_printer.elevate_command(["--install-printer"])
    check("提权命令 = 用管理员身份再跑一遍自己（exe --install-printer）",
          launcher == str(EXE_TEST) and params == '"--install-printer"', f"{launcher} {params}")
finally:
    vp_platform.IS_FROZEN, sys.executable = saved_frozen, saved_exe

# ------------------------------------------------------------------ 7. zip 内容

section("7. 分发包内容检查")
zips = sorted((ROOT / "dist").glob("AntiPrintVPrinter-*.zip"))
check("分发包存在", bool(zips), str(zips[-1].name if zips else "（没找到）"))
if zips:
    with zipfile.ZipFile(zips[-1]) as zf:
        names = zf.namelist()
        check("包内有 exe", any(n.endswith("AntiPrintVPrinter.exe") for n in names))
        check("包内有 install/ 全部脚本",
              all(any(n.endswith("install/" + f) for n in names) for f in
                  ("install-printer-windows.ps1", "uninstall-printer-windows.ps1",
                   "cups-backend-antiprint", "setup-cups.sh", "uninstall-cups.sh", "antiprint.ppd")),
              f"{len(names)} 个文件")
        check("包内有 macOS/Linux 的启动脚本与「快速开始.txt」（免 Python 用户直接照着做）",
              all(any(n.endswith(f) for n in names) for f in
                  ("start-vprinter.sh", "check-vprinter.sh", "快速开始.txt")))
        check("包内有三个 bat 与 README",
              all(any(n.endswith(f) for n in names) for f in
                  ("start-vprinter.bat", "check-vprinter.bat", "stop-vprinter.bat", "README.txt")))
        check("包里没有 config.json / 日志 / 令牌",
              not any(n.endswith(("config.json", "vprinter.log", "vprinter.lock")) for n in names))
        readme = zf.read(next(n for n in names if n.endswith("README.txt")))
        check("README 带 UTF-8 BOM 且是 CRLF（记事本不乱码）",
              readme.startswith(b"\xef\xbb\xbf") and b"\r\n" in readme and b"\n\n" not in readme)
        bat = zf.read(next(n for n in names if n.endswith("start-vprinter.bat")))
        check("bat 是 CRLF + 纯 ASCII", b"\r\n" in bat and all(b < 128 for b in bat))
        check("bat 优先用 exe（分发包里不需要 Python）", b"AntiPrintVPrinter.exe" in bat)

# ------------------------------------------------------------------ 收尾

section("收尾：清理")
for job_id in set(CREATED):
    req("DELETE", f"/api/jobs/{job_id}", ADMIN)
print(f"  已删除 {len(set(CREATED))} 个测试任务（会自动退费）")
shutil.rmtree(HOME, ignore_errors=True)

print(f"\n结果：{PASS} 项通过，{FAIL} 项失败")
sys.exit(1 if FAIL else 0)
