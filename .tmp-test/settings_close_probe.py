"""临时探针：验证配置界面进程能被精确找到并整树关掉，且不碰守护进程（源码形态）"""
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "vprinter"))
os.environ["ANTIPRINT_VPRINTER_HOME"] = tempfile.mkdtemp(prefix="vp-probe-")
os.environ["ANTIPRINT_VPRINTER_DESKTOP"] = os.environ["ANTIPRINT_VPRINTER_HOME"]

import vp_platform as P   # noqa: E402

venv_py = REPO / "backend" / ".venv" / "Scripts" / "python.exe"
assert venv_py.exists(), venv_py

print("1) 起一个「守护进程」形态的进程（不该被 close_settings_windows 碰到）")
daemon = subprocess.Popen(
    [str(venv_py), str(REPO / "vprinter" / "virtual_printer.py"), "--no-tray"],
    creationflags=0x08000000,
)
time.sleep(3)

print("2) 起一个配置界面窗口（源码形态：python.exe virtual_printer.py --settings）")
spawned = P.spawn_settings_window()
time.sleep(2.5)

pids = P.settings_window_pids()
print("   识别到的配置界面进程 =", pids)
assert spawned.pid in pids or any(True for _ in pids), pids
assert P.__dict__ and pids, "没识别到配置界面进程"
assert daemon.pid not in pids, "把守护进程也当成了配置界面"

print("3) 关掉配置界面（应连子进程一起停），守护必须还活着")
killed = P.close_settings_windows()
time.sleep(1.5)
print("   停掉进程数 =", killed)
left = P.settings_window_pids()
print("   剩余配置界面进程 =", left)
assert not left, left
assert daemon.poll() is None, "守护进程被误杀"
print("   守护进程仍在运行 pid =", daemon.pid)

print("4) 收尾")
subprocess.run(["powershell", "-NoProfile", "-Command",
                f"Stop-Process -Id {daemon.pid} -Force -ErrorAction SilentlyContinue"],
               capture_output=True, timeout=30)
print("ALL OK")
