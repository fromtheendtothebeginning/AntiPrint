"""撤回（提交人）与重新打印（管理员）接口测试（临时脚本）。

用法：backend\\.venv\\Scripts\\python.exe .tmp-test\withdraw_reprint_test.py
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


def submit(token):
    with open(PDF, "rb") as fh:
        return requests.post(
            BASE + "/api/jobs",
            data={"address": "撤回/重打测试", "delivery_mode": "配送", "note": "可删除"},
            headers={"Authorization": "Bearer " + token},
            files=[("files", ("test-print.pdf", fh.read(), "application/pdf"))],
            timeout=30,
        ).json()["job"]


tag = str(int(time.time()))[-6:]
admin = requests.post(f"{BASE}/api/login", json={"username": "admin", "password": "admin123"}, timeout=20).json()["token"]
AH = {"Authorization": "Bearer " + admin}
reg = requests.post(f"{BASE}/api/register", json={"username": "wd" + tag, "password": "Test123456"}, timeout=20).json()
USER, UT = reg["user"]["username"], reg["token"]
UH = {"Authorization": "Bearer " + UT}
AGENT = requests.get(f"{BASE}/api/settings", headers=AH, timeout=20).json()["settings"]["agent_token"]
Gh = {"X-Agent-Token": AGENT, "Content-Type": "application/json"}

print("\n1. 提交人撤回：待审核 → 已撤回")
j1 = submit(UT)
r = requests.post(f"{BASE}/api/jobs/{j1['id']}/withdraw", headers=UH, timeout=20)
check("待审核可撤回", r.status_code == 200 and r.json()["job"]["status"] == "已撤回", f"{r.status_code} {r.text[:80]}")
r = requests.post(f"{BASE}/api/jobs/{j1['id']}/withdraw", headers=UH, timeout=20)
check("已撤回不能再撤回 → 400", r.status_code == 400, str(r.status_code))

print("\n2. 已通过（还没出纸）也能撤回")
j2 = submit(UT)
requests.post(f"{BASE}/api/jobs/{j2['id']}/approve", headers=AH, timeout=20)
r = requests.post(f"{BASE}/api/jobs/{j2['id']}/withdraw", headers=UH, timeout=20)
check("已通过可撤回", r.status_code == 200 and r.json()["job"]["status"] == "已撤回", f"{r.status_code}")

print("\n3. 打印中 / 已打印 不能撤回")
j3 = submit(UT)
requests.post(f"{BASE}/api/jobs/{j3['id']}/approve", headers=AH, timeout=20)
requests.post(f"{BASE}/api/agent/claim", headers=Gh, json={}, timeout=20)
r = requests.post(f"{BASE}/api/jobs/{j3['id']}/withdraw", headers=UH, timeout=20)
check("打印中不能撤回 → 400", r.status_code == 400, f"{r.status_code} {r.json().get('detail','')}")
requests.post(f"{BASE}/api/agent/jobs/{j3['id']}/result", headers=Gh, json={"ok": True, "error": None}, timeout=20)
r = requests.post(f"{BASE}/api/jobs/{j3['id']}/withdraw", headers=UH, timeout=20)
check("已打印不能撤回 → 400", r.status_code == 400, str(r.status_code))

print("\n4. 权限：不能撤别人的任务")
other = requests.post(f"{BASE}/api/register", json={"username": "oth" + tag, "password": "Test123456"}, timeout=20).json()["token"]
j4 = submit(UT)
r = requests.post(f"{BASE}/api/jobs/{j4['id']}/withdraw", headers={"Authorization": "Bearer " + other}, timeout=20)
check("他人撤回 → 403", r.status_code == 403, str(r.status_code))
r = requests.post(f"{BASE}/api/jobs/{j4['id']}/reprint", headers=UH, timeout=20)
check("普通用户重新打印 → 403", r.status_code == 403, str(r.status_code))

print("\n5. 管理员重新打印：已打印 → 已通过（清掉上次打印痕迹）")
r = requests.post(f"{BASE}/api/jobs/{j3['id']}/reprint", headers=AH, timeout=20)
job = r.json().get("job", {}) if r.status_code == 200 else {}
check("已打印可重新打印", r.status_code == 200 and job.get("status") == "已通过", f"{r.status_code} {r.text[:80]}")
check("上次的 printed_at / agent 已清空", job.get("printed_at") is None, str(job.get("printed_at")))
r = requests.get(f"{BASE}/api/jobs/{j3['id']}", headers=AH, timeout=20).json()["job"]
check("重新入队后能被代理再次领取", requests.post(f"{BASE}/api/agent/claim", headers=Gh, json={}, timeout=20).json()["job"]["id"] == j3["id"], "")
requests.post(f"{BASE}/api/agent/jobs/{j3['id']}/result", headers=Gh, json={"ok": True, "error": None}, timeout=20)

print("\n6. 流转到「待配送 / 已完成」后同样可重新打印；待审核则不行")
requests.post(f"{BASE}/api/jobs/{j3['id']}/advance", headers=AH, json={"to": "待配送"}, timeout=20)
r = requests.post(f"{BASE}/api/jobs/{j3['id']}/reprint", headers=AH, timeout=20)
check("待配送可重新打印", r.status_code == 200 and r.json()["job"]["status"] == "已通过", str(r.status_code))
r = requests.post(f"{BASE}/api/jobs/{j1['id']}/reprint", headers=AH, timeout=20)
check("已撤回不能重新打印 → 400", r.status_code == 400, f"{r.status_code} {r.json().get('detail','')}")

print("\n7. 删除（管理员）依然可用，含已撤回任务")
r = requests.delete(f"{BASE}/api/jobs/{j1['id']}", headers=AH, timeout=20)
check("删除已撤回任务成功", r.status_code == 200, str(r.status_code))
r = requests.get(f"{BASE}/api/jobs/{j1['id']}", headers=AH, timeout=20)
check("删除后取不到该任务 → 404", r.status_code == 404, str(r.status_code))

print("\n8. 清理")
sys.path.insert(0, "backend")
import db  # noqa: E402

for name in (USER, "oth" + tag):
    user = db.get_user_by_name(name)
    if user:
        for row in db.list_jobs(user["id"]):
            db.delete_job(row["id"])
        with db.tx() as cur:
            cur.execute("DELETE FROM users WHERE id=%s", (user["id"],))
check("测试账号与任务已清理", db.get_user_by_name(USER) is None, "")

print(f"\n===== 撤回 / 重新打印测试：通过 {len(PASS)} 项，失败 {len(FAIL)} 项 =====")
for f in FAIL:
    print("  - 失败：" + f)
sys.exit(1 if FAIL else 0)
