"""逐文件打印设置接口测试（临时脚本）。

用法：backend\\.venv\\Scripts\\python.exe .tmp-test\per_file_settings_test.py
"""
import json
import sys
import time

import requests

BASE = "http://127.0.0.1:8301"
PDF = ".tmp-test/test-print.pdf"
PNG = ".tmp-test/test-image.png"
PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("  [PASS] " if cond else "  [FAIL] ") + name + (f"  {extra}" if extra else ""))


def submit(token, settings=None, files=None, **fields):
    data = {"address": "逐文件设置测试", "delivery_mode": "配送", "note": "可删除"}
    data.update(fields)
    if settings is not None:
        data["settings"] = json.dumps(settings, ensure_ascii=False)
    payload = files if files is not None else [
        ("files", ("test-print.pdf", open(PDF, "rb").read(), "application/pdf")),
        ("files", ("test-image.png", open(PNG, "rb").read(), "image/png")),
    ]
    return requests.post(BASE + "/api/jobs", data=data, headers={"Authorization": "Bearer " + token},
                         files=payload, timeout=30)


tag = str(int(time.time()))[-6:]
admin = requests.post(f"{BASE}/api/login", json={"username": "admin", "password": "admin123"}, timeout=20).json()["token"]
reg = requests.post(f"{BASE}/api/register", json={"username": "per" + tag, "password": "Test123456"}, timeout=20).json()
USER, UT = reg["user"]["username"], reg["token"]
AGENT = requests.get(f"{BASE}/api/settings", headers={"Authorization": "Bearer " + admin}, timeout=20).json()["settings"]["agent_token"]

print("\n1. 两个文件两套设置")
r = submit(UT, settings=[
    {"copies": 2, "paper": "A3", "pages": "1-2", "nup": "2,2", "scale": "fit"},
    {"copies": 1, "paper": "A4", "nup": "1,1"},
])
job = r.json().get("job", {}) if r.status_code == 200 else {}
check("提交成功", r.status_code == 200, f"{r.status_code} {r.text[:100]}")
files = job.get("files") or []
check("两个文件都落库", len(files) == 2, str(len(files)))
if len(files) == 2:
    check("文件1 设置 = 自己的那套", files[0]["print_options"].get("paper") == "A3" and files[0]["print_options"].get("copies") == 2
          and files[0]["print_options"].get("nup") == "2,2" and files[0]["print_options"].get("pages") == "1-2", str(files[0]["print_options"]))
    check("文件2 设置 = 另一套", files[1]["print_options"].get("paper") == "A4" and files[1]["print_options"].get("copies") == 1
          and files[1]["print_options"].get("nup") == "1,1", str(files[1]["print_options"]))
jid = job.get("id")

print("\n2. 代理领取时逐文件带设置")
requests.post(f"{BASE}/api/jobs/{jid}/approve", headers={"Authorization": "Bearer " + admin}, timeout=20)
claim = requests.post(f"{BASE}/api/agent/claim", headers={"X-Agent-Token": AGENT, "Content-Type": "application/json"},
                      json={}, timeout=20).json().get("job") or {}
cfiles = claim.get("files") or []
check("claim 的两个文件分别带 print_options", len(cfiles) == 2
      and cfiles[0]["print_options"].get("paper") == "A3" and cfiles[1]["print_options"].get("paper") == "A4",
      str([f.get("print_options") for f in cfiles]))

print("\n3. 非法与边界")
r = submit(UT, settings=[{"paper": "A2"}])
check("非法纸张 → 400", r.status_code == 400, f"{r.status_code} {r.json().get('detail','')}")
r = submit(UT, settings=[{"copies": 0}])
check("份数 0 → 400", r.status_code == 400, str(r.status_code))
r = submit(UT, settings=[{"pages": "abc"}])
check("非法页面范围 → 400", r.status_code == 400, str(r.status_code))
r = submit(UT, settings="not-json")
check("settings 不是 JSON → 400", r.status_code == 400, str(r.status_code))
r = submit(UT, settings=[{"paper": "A3"}])   # 只给第一个文件设置
j2 = r.json().get("job", {})
fs2 = j2.get("files") or []
check("只给第一个文件设置时：第2个回落为任务级默认（空）", len(fs2) == 2 and fs2[0]["print_options"].get("paper") == "A3"
      and not fs2[1].get("print_options"), str([f.get("print_options") for f in fs2]))

print("\n4. 兼容：不传 settings 时沿用任务级设置")
r = submit(UT, paper="A5", copies="3", files=[("files", ("test-print.pdf", open(PDF, "rb").read(), "application/pdf"))])
j3 = r.json().get("job", {})
check("任务级设置仍生效且文件未带自己的设置",
      j3.get("print_options", {}).get("paper") == "A5" and j3.get("copies") == 3 and not (j3.get("files") or [{}])[0].get("print_options"),
      str({k: j3.get(k) for k in ("copies", "print_options")}))

print("\n5. 清理")
sys.path.insert(0, "backend")
import db  # noqa: E402

user = db.get_user_by_name(USER)
if user:
    for row in db.list_jobs(user["id"]):
        db.delete_job(row["id"])
    with db.tx() as cur:
        cur.execute("DELETE FROM users WHERE id=%s", (user["id"],))
check("测试账号与任务已清理", db.get_user_by_name(USER) is None, "")

print(f"\n===== 逐文件设置测试：通过 {len(PASS)} 项，失败 {len(FAIL)} 项 =====")
for f in FAIL:
    print("  - 失败：" + f)
sys.exit(1 if FAIL else 0)
