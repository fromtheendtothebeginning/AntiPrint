"""打印代理「断开连接 / 重新连接」接口测试（临时脚本）。

用法：backend\\.venv\\Scripts\\python.exe .tmp-test/agent_link_test.py
注意：只对本机后端跑；线上跑会把用户的真实打印代理断开。
"""
import sys
import time

import requests

BASE = "http://127.0.0.1:8301"
PDF = ".tmp-test/test-print.pdf"
PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("  [PASS] " if cond else "  [FAIL] ") + name + (f"  {extra}" if extra else ""))


tag = str(int(time.time()))[-6:]
admin = requests.post(f"{BASE}/api/login", json={"username": "admin", "password": "admin123"}, timeout=20).json()["token"]
AH = {"Authorization": "Bearer " + admin}
user = requests.post(f"{BASE}/api/register", json={"username": "link" + tag, "password": "Test123456"}, timeout=20).json()
UH = {"Authorization": "Bearer " + user["token"]}
AGENT = requests.get(f"{BASE}/api/settings", headers=AH, timeout=20).json()["settings"]["agent_token"]
GH = {"X-Agent-Token": AGENT, "Content-Type": "application/json"}


def agent_endpoints():
    """代理的五个入口各打一次，返回 {名称: 状态码}"""
    with open(PDF, "rb") as fh:
        pdf = fh.read()
    job = requests.post(f"{BASE}/api/jobs", headers=UH, timeout=30,
                        data={"address": "代理断开测试（可删除）", "delivery_mode": "配送"},
                        files=[("files", ("test-print.pdf", pdf, "application/pdf"))]).json()["job"]
    requests.post(f"{BASE}/api/jobs/{job['id']}/approve", headers=AH, timeout=20)
    fid = job["files"][0]["id"]
    return job["id"], {
        "注册": requests.post(f"{BASE}/api/agent/register", headers=GH, json={"name": "linktest"}, timeout=20),
        "心跳": requests.post(f"{BASE}/api/agent/heartbeat", headers=GH, json={"name": "linktest"}, timeout=20),
        "领取": requests.post(f"{BASE}/api/agent/claim", headers=GH, json={}, timeout=20),
        "下载": requests.get(f"{BASE}/api/agent/jobs/{job['id']}/files/{fid}", headers=GH, timeout=20),
        "回报": requests.post(f"{BASE}/api/agent/jobs/{job['id']}/result", headers=GH,
                             json={"ok": True, "error": None}, timeout=20),
    }


try:
    print("\n1. 默认状态：连接中")
    data = requests.get(f"{BASE}/api/settings", headers=AH, timeout=20).json()
    check("agent_enabled 默认开启", str(data["settings"].get("agent_enabled")) == "1", str(data["settings"].get("agent_enabled")))
    r = requests.post(f"{BASE}/api/agent/claim", headers=GH, json={}, timeout=20)
    check("默认时代理能正常领取（200/无任务）", r.status_code == 200, str(r.status_code))

    print("\n2. 权限：普通用户不能断开代理")
    r = requests.post(f"{BASE}/api/settings/agent-link", headers=UH, json={"connected": False}, timeout=20)
    check("普通用户 → 403", r.status_code == 403, str(r.status_code))

    print("\n3. 断开连接")
    r = requests.post(f"{BASE}/api/settings/agent-link", headers=AH, json={"connected": False}, timeout=20)
    body = r.json()
    check("断开成功且回最新状态", r.status_code == 200 and str(body["settings"]["agent_enabled"]) == "0", str(r.status_code))
    check("断开后 agent_online = False", body["agent_online"] is False, str(body["agent_online"]))

    jid, results = agent_endpoints()
    statuses = {name: resp.status_code for name, resp in results.items()}
    check("代理五个入口全部 403", set(statuses.values()) == {403}, str(statuses))
    detail = results["领取"].json().get("detail", "")
    check("403 提示是中文且说明已断开", "断开" in detail, detail[:60])
    after = requests.get(f"{BASE}/api/jobs/{jid}", headers=AH, timeout=20).json()["job"]
    check("断开期间任务没有被领取（仍为已通过）", after["status"] == "已通过", after["status"])

    print("\n4. 重新连接")
    r = requests.post(f"{BASE}/api/settings/agent-link", headers=AH, json={"connected": True}, timeout=20)
    check("重连成功且回最新状态", r.status_code == 200 and str(r.json()["settings"]["agent_enabled"]) == "1", str(r.status_code))
    r = requests.post(f"{BASE}/api/agent/claim", headers=GH, json={}, timeout=20)
    claimed = r.json().get("job") or {}
    check("重连后代理能再次领取（领到排队中的任务）", r.status_code == 200 and claimed.get("id") == jid,
          f"{r.status_code} job={claimed.get('id')}")
    r = requests.post(f"{BASE}/api/agent/jobs/{jid}/result", headers=GH, json={"ok": True, "error": None}, timeout=20)
    check("重连后回报正常", r.status_code == 200, str(r.status_code))
    requests.delete(f"{BASE}/api/jobs/{jid}", headers=AH, timeout=20)
finally:
    # 无论成败都恢复连接，避免把本机后端留在「已断开」状态
    requests.post(f"{BASE}/api/settings/agent-link", headers=AH, json={"connected": True}, timeout=20)

print("\n=== 结果 ===")
print(f"通过 {len(PASS)} 项，失败 {len(FAIL)} 项")
for name in FAIL:
    print("  - 失败：" + name)
sys.exit(1 if FAIL else 0)
