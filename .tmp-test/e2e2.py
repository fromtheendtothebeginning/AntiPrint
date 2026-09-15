"""用户配置 + 配送方式 + 交接流转（待配送/待取件/已完成）接口测试（临时脚本）。

用法：backend\\.venv\\Scripts\\python.exe .tmp-test\\e2e2.py
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


def post(path, payload=None, token=None, agent=None):
    h = {}
    if token:
        h["Authorization"] = "Bearer " + token
    if agent:
        h["X-Agent-Token"] = agent
    return requests.post(BASE + path, json=payload or {}, headers=h, timeout=20)


def put(path, payload, token):
    return requests.put(BASE + path, json=payload, headers={"Authorization": "Bearer " + token}, timeout=20)


def get(path, token=None):
    h = {"Authorization": "Bearer " + token} if token else {}
    return requests.get(BASE + path, headers=h, timeout=20)


tag = str(int(time.time()))[-6:]
admin = post("/api/login", {"username": "admin", "password": "admin123"}).json()["token"]
settings = get("/api/settings", admin).json()
AGENT = settings["settings"]["agent_token"]

reg = post("/api/register", {"username": "state" + tag, "password": "Test123456"}).json()
# 计费：新账号余额为 0，先由管理员充 100 元（否则提交会被 402 拦住）
post(f"/api/users/{reg['user']['id']}/balance", {"delta": "100", "note": "测试充值"}, token=admin)
USER, UT = reg["user"]["username"], reg["token"]
pdf_bytes = open(PDF, "rb").read()

print("\n1. 用户配置：默认地址 / 默认配送方式")
p = get("/api/profile", UT).json()["profile"]
check("新用户默认配置为空 + 默认配送", p["default_address"] == "" and p["default_delivery"] == "配送" and not p["anticraft_bound"], str(p))
r = put("/api/profile", {"default_address": "三教 305 讲台旁", "default_delivery": "取件"}, UT)
check("保存默认配置成功", r.status_code == 200 and r.json()["profile"]["default_delivery"] == "取件", str(r.status_code))
r = put("/api/profile", {"default_delivery": "快递"}, UT)
check("非法配送方式被拒 400", r.status_code == 400, f"{r.status_code} {r.json().get('detail', '')}")
r = put("/api/profile", {"default_address": "x" * 300}, UT)
check("超长地址被拒 400", r.status_code == 400, str(r.status_code))


def submit(mode=None, address="", note="状态机测试"):
    data = {"address": address, "note": note}
    if mode:
        data["delivery_mode"] = mode
    return requests.post(
        BASE + "/api/jobs", data=data, headers={"Authorization": "Bearer " + UT},
        files=[("files", ("test-print.pdf", pdf_bytes, "application/pdf"))], timeout=20,
    )


print("\n2. 提交时的配送方式")
r = submit(address="")
check("默认取件：地址可空", r.status_code == 200 and r.json()["job"]["delivery_mode"] == "取件", f"{r.status_code} {r.json().get('detail','')}")
job_pickup = r.json()["job"]["id"]
r = submit("配送", address="")
check("显式配送但地址为空 → 400", r.status_code == 400, f"{r.status_code} {r.json().get('detail', '')}")
r = submit("配送", address="上海市徐汇区某某路 100 号")
check("显式配送（覆盖用户默认取件）", r.status_code == 200 and r.json()["job"]["delivery_mode"] == "配送", str(r.status_code))
job_deliver = r.json()["job"]["id"]
r = submit("随缘", address="x")
check("非法配送方式 → 400", r.status_code == 400, str(r.status_code))

print("\n3. 交接流转：已打印 → 待配送 → 已完成（配送单）")
for jid in (job_deliver, job_pickup):
    post(f"/api/jobs/{jid}/approve", token=admin)
    post("/api/agent/claim", agent=AGENT)
    post(f"/api/agent/jobs/{jid}/result", {"ok": True, "error": None}, agent=AGENT)
st = get(f"/api/jobs/{job_deliver}", UT).json()["job"]
check("配送单已打印", st["status"] == "已打印" and st["delivery_mode"] == "配送", st["status"])

r = post(f"/api/jobs/{job_deliver}/advance", {"to": "待审核"}, admin)
check("回到「待审核」被拒 400", r.status_code == 400, f"{r.status_code} {r.json().get('detail','')}")
r = post(f"/api/jobs/{job_deliver}/advance", {"to": "待取件"}, admin)
check("配送单不能标「待取件」400", r.status_code == 400 and "配送" in str(r.json().get("detail", "")), f"{r.status_code} {r.json().get('detail','')}")
r = post(f"/api/jobs/{job_deliver}/advance", {"to": "待配送"}, admin)
check("标记「待配送」成功", r.status_code == 200 and r.json()["job"]["status"] == "待配送", f"{r.status_code}")
r = post(f"/api/jobs/{job_deliver}/advance", {"to": "待配送"}, admin)
check("重复标记被拒 400", r.status_code == 400, str(r.status_code))
r = post(f"/api/jobs/{job_deliver}/advance", {"to": "已完成"}, admin)
body = r.json()["job"] if r.status_code == 200 else {}
check("标记「已完成」并写入 finished_at", r.status_code == 200 and body.get("status") == "已完成" and body.get("finished_at"), str(body.get("status")))

print("\n4. 交接流转：取件单只能进「待取件」")
r = post(f"/api/jobs/{job_pickup}/advance", {"to": "待配送"}, admin)
check("取件单不能标「待配送」400", r.status_code == 400, f"{r.status_code} {r.json().get('detail','')}")
r = post(f"/api/jobs/{job_pickup}/advance", {"to": "待取件"}, admin)
check("标记「待取件」成功", r.status_code == 200 and r.json()["job"]["status"] == "待取件", str(r.status_code))
r = post(f"/api/jobs/{job_pickup}/advance", {"to": "已完成"}, admin)
check("取件单标记「已完成」成功", r.status_code == 200 and r.json()["job"]["status"] == "已完成", str(r.status_code))

print("\n5. 权限与用户侧可见性")
other = post("/api/register", {"username": "other" + tag, "password": "Test123456"}).json()["token"]
r = post(f"/api/jobs/{job_deliver}/advance", {"to": "已完成"}, other)
check("普通用户调用 advance 被拒 403", r.status_code == 403, str(r.status_code))
r = get("/api/jobs/mine", UT).json()["jobs"]
mine = {j["id"]: j for j in r}
check("用户侧看到已完成与配送方式", mine[job_deliver]["status"] == "已完成" and mine[job_deliver]["delivery_mode"] == "配送", "")
r = get("/api/jobs", admin).json()
check("管理队列返回 delivery_mode / finished_at", all("delivery_mode" in j and "finished_at" in j for j in r["jobs"]), "")

print("\n6. anticraft 绑定票据与解绑校验")
r = post("/api/profile/anticraft/bind-ticket", {}, UT)
check("已登录用户可领绑定票据", r.status_code == 200 and len(r.json().get("ticket", "")) > 10, str(r.status_code))
ticket = r.json().get("ticket", "")
resp = requests.get(
    f"{BASE}/api/oauth/anticraft/start?origin=http://127.0.0.1:8301&bind_ticket={ticket}",
    allow_redirects=False, timeout=20,
)
check("带票据发起授权：302 到 anticraft 且提示绑定对象", resp.status_code == 302 and str(resp.headers.get("Location", "")).startswith("http://localhost:3000/bind?"), str(resp.status_code))
resp2 = requests.get(
    f"{BASE}/api/oauth/anticraft/start?origin=http://127.0.0.1:8301&bind_ticket={ticket}",
    allow_redirects=False, timeout=20,
)
check("票据一次性（二次使用被拒）", resp2.status_code == 400, str(resp2.status_code))
r = post("/api/profile/anticraft/unbind", {"password": "NewPass123"}, UT)
check("未绑定账号解绑被拒 400", r.status_code == 400, f"{r.status_code} {r.json().get('detail','')}")
r = post("/api/profile/anticraft/unbind", {"password": "123"}, UT)
check("解绑密码过短被拒 400", r.status_code == 400, str(r.status_code))

print("\n7. 清理")
sys.path.insert(0, "backend")
import db  # noqa: E402

for name in (USER, "other" + tag):
    user = db.get_user_by_name(name)
    if user:
        for job in db.list_jobs(user["id"]):
            db.delete_job(job["id"])
        with db.tx() as cur:
            cur.execute("DELETE FROM users WHERE id=%s", (user["id"],))
with db.tx() as cur:
    # 只校验「我这轮造的数据没了 + 没有孤儿任务」；库里可能还有用户自己的账号与示例任务，不做数量断言
    cur.execute("SELECT COUNT(*) c FROM print_jobs j LEFT JOIN users u ON u.id=j.user_id WHERE u.id IS NULL")
    orphans = cur.fetchone()["c"]
check(
    "测试账号已清理且无孤儿任务",
    db.get_user_by_name(USER) is None and db.get_user_by_name("other" + tag) is None and orphans == 0,
    f"孤儿任务 {orphans} 个",
)

print(f"\n===== 配置 + 状态机测试：通过 {len(PASS)} 项，失败 {len(FAIL)} 项 =====")
for f in FAIL:
    print("  - 失败：" + f)
sys.exit(1 if FAIL else 0)
