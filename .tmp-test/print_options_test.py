"""打印设置（份数/双面/纸张/页面范围/每面页数/缩放/颜色）接口测试（临时脚本）。

用法：backend\\.venv\\Scripts\\python.exe .tmp-test\\print_options_test.py
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


def submit(token, **fields):
    data = {"address": "打印设置测试（可删除）", "delivery_mode": "配送", "note": "选项验证"}
    data.update(fields)
    with open(PDF, "rb") as fh:
        pdf = fh.read()
    return requests.post(
        BASE + "/api/jobs", data=data, headers={"Authorization": "Bearer " + token},
        files=[("files", ("test-print.pdf", pdf, "application/pdf"))], timeout=30,
    )


tag = str(int(time.time()))[-6:]
admin = requests.post(f"{BASE}/api/login", json={"username": "admin", "password": "admin123"}, timeout=20).json()["token"]
reg = requests.post(f"{BASE}/api/register", json={"username": "opts" + tag, "password": "Test123456"}, timeout=20).json()
USER, UT = reg["user"]["username"], reg["token"]
settings = requests.get(f"{BASE}/api/settings", headers={"Authorization": "Bearer " + admin}, timeout=20).json()["settings"]
AGENT = settings["agent_token"]

print("\n1. 完整打印设置提交")
r = submit(UT, copies="2", duplex="duplexlong", paper="A3", pages="1-2", nup="2,2", scale="fit", color="monochrome")
job = r.json().get("job", {}) if r.status_code == 200 else {}
check("提交成功", r.status_code == 200, f"{r.status_code} {r.text[:80]}")
check("份数落库", job.get("copies") == 2, str(job.get("copies")))
opts = job.get("print_options") or {}
check("打印设置解析成 dict", opts.get("duplex") == "duplexlong" and opts.get("paper") == "A3" and opts.get("pages") == "1-2"
      and opts.get("nup") == "2,2" and opts.get("scale") == "fit" and opts.get("color") == "monochrome", str(opts))
jid = job.get("id")

print("\n2. 默认值（不传设置时）")
r = submit(UT)
j2 = r.json().get("job", {})
check("默认份数 1 且 options 里也带份数", j2.get("copies") == 1 and (j2.get("print_options") or {}).get("copies") == 1, str(j2.get("print_options")))

print("\n3. 非法值一律 400")
for field, value, label in (
    ("copies", "0", "份数 0"),
    ("copies", "100", "份数 100"),
    ("copies", "abc", "份数非数字"),
    ("duplex", "duplex", "非法双面值"),
    ("paper", "A2", "非法纸张"),
    ("nup", "5,5", "非法每面页数"),
    ("scale", "huge", "非法缩放"),
    ("color", "rainbow", "非法颜色"),
    ("pages", "abc", "非法页面范围"),
    ("pages", "1;" * 40, "超长页面范围"),
):
    r = submit(UT, **{field: value})
    check(f"{label} → 400", r.status_code == 400, f"{r.status_code} {r.json().get('detail','')}")

print("\n4. 代理领取时能看到打印设置")
requests.post(f"{BASE}/api/jobs/{jid}/approve", headers={"Authorization": "Bearer " + admin}, timeout=20)
claim = requests.post(f"{BASE}/api/agent/claim", headers={"X-Agent-Token": AGENT, "Content-Type": "application/json"},
                      json={}, timeout=20).json().get("job") or {}
check("claim 返回 print_options 与份数", (claim.get("print_options") or {}).get("pages") == "1-2" and claim.get("copies") == 2,
      str({k: claim.get(k) for k in ("copies", "print_options")}))

print("\n5. 用户/管理列表都能读到设置")
mine = requests.get(f"{BASE}/api/jobs/mine", headers={"Authorization": "Bearer " + UT}, timeout=20).json()["jobs"]
target = next((j for j in mine if j["id"] == jid), {})
check("我的任务带 print_options", (target.get("print_options") or {}).get("nup") == "2,2", str(target.get("print_options")))
allj = requests.get(f"{BASE}/api/jobs", headers={"Authorization": "Bearer " + admin}, timeout=20).json()["jobs"]
check("管理队列带 print_options", any((j.get("print_options") or {}).get("paper") == "A3" for j in allj), "")

print("\n6. 清理")
sys.path.insert(0, "backend")
import db  # noqa: E402

for name in (USER,):
    user = db.get_user_by_name(name)
    if user:
        for job_row in db.list_jobs(user["id"]):
            db.delete_job(job_row["id"])
        with db.tx() as cur:
            cur.execute("DELETE FROM users WHERE id=%s", (user["id"],))
check("测试账号与任务已清理", db.get_user_by_name(USER) is None, "")

print(f"\n===== 打印设置测试：通过 {len(PASS)} 项，失败 {len(FAIL)} 项 =====")
for f in FAIL:
    print("  - 失败：" + f)
sys.exit(1 if FAIL else 0)
