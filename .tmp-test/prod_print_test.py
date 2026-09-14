"""线上端到端出纸测试（临时脚本）：登录线上 → 提交 → 批准 → 等本机代理打印并回报。

用法：backend\\.venv\\Scripts\\python.exe .tmp-test\\prod_print_test.py
"""
import sys
import time

import requests

BASE = "http://47.100.125.150"
USERNAME = "end"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""
if not PASSWORD:
    sys.exit("用法：python prod_print_test.py <管理员口令>")

PDF = ".tmp-test/test-print.pdf"
ADDRESS = "线上出纸测试（三教 305 讲台旁）"

login = requests.post(f"{BASE}/api/login", json={"username": USERNAME, "password": PASSWORD}, timeout=20)
login.raise_for_status()
token = login.json()["token"]
H = {"Authorization": "Bearer " + token}
print(f"登录成功：{login.json()['user']}")

settings = requests.get(f"{BASE}/api/settings", headers=H, timeout=20).json()
print("线上设置：", {k: settings["settings"][k] for k in ("printer_name", "launcher", "copies", "dry_run")})
print("代理在线：", settings["agent_online"])

with open(PDF, "rb") as fh:
    pdf = fh.read()

resp = requests.post(
    f"{BASE}/api/jobs",
    data={"address": ADDRESS, "note": "线上链路验证，可忽略", "delivery_mode": "配送"},
    headers=H,
    files=[("files", ("antiprint-online-test.pdf", pdf, "application/pdf"))],
    timeout=30,
)
resp.raise_for_status()
job = resp.json()["job"]
jid = job["id"]
print(f"已提交任务 #{jid}（状态 {job['status']}，配送方式 {job['delivery_mode']}）")

requests.post(f"{BASE}/api/jobs/{jid}/approve", headers=H, timeout=20).raise_for_status()
print("已批准，等待本机代理领取并打印（最长等 120 秒）…")

deadline = time.time() + 120
last = None
while time.time() < deadline:
    time.sleep(4)
    cur = requests.get(f"{BASE}/api/jobs/{jid}", headers=H, timeout=20).json()["job"]
    if cur["status"] != last:
        print(f"  [{time.strftime('%H:%M:%S')}] 状态：{cur['status']}"
              + (f"（{cur.get('print_error') or ''}）" if cur.get("print_error") else ""))
        last = cur["status"]
    if cur["status"] in ("已打印", "打印失败"):
        print("最终状态：", cur["status"], "| printed_at:", cur.get("printed_at"))
        print("下一步可用：", cur["delivery_mode"] == "配送" and "标记「待配送」→「已完成」" or "标记「待取件」→「已完成」")
        sys.exit(0 if cur["status"] == "已打印" else 1)
print("超时：代理未在 120 秒内完成，请查看 agent/log/agent.log")
sys.exit(1)
