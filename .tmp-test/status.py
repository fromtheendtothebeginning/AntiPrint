"""交付前状态快照（临时脚本）：服务、代理、队列、进程。"""
import subprocess
import sys

import requests

BASE = "http://127.0.0.1:8301"
tok = requests.post(BASE + "/api/login", json={"username": "admin", "password": "admin123"}, timeout=10).json()["token"]
h = {"Authorization": "Bearer " + tok}

health = requests.get(BASE + "/api/health", timeout=10).json()
print("健康检查:", health)
print("首页:", requests.get(BASE + "/", timeout=10).status_code)

data = requests.get(BASE + "/api/jobs", headers=h, timeout=10).json()
print("代理在线:", data["agent_online"])
for a in data["agents"]:
    print(f"  代理 {a['name']} v{a['version']} 最后心跳 {a['last_seen']} 上报打印机 {len(a['printers'])} 台")
print("任务队列:", len(data["jobs"]), "个")
print("设置:", {k: v for k, v in requests.get(BASE + "/api/settings", headers=h, timeout=10).json()["settings"].items() if k != "agent_token"})

ps = (
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'python*' -and "
    "($_.ExecutablePath -like '*AntiPrint*' -or $_.CommandLine -like '*print_agent*') } | "
    "ForEach-Object { '  PID ' + $_.ProcessId + ' ' + $_.Name }"
)
print("本项目 python 进程:")
out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, encoding="utf-8", errors="replace")
print(out.stdout.strip() or "  （无）")
sys.exit(0)
