"""余额计费接口测试（临时脚本）：免费判定、扣费、余额不足 402、退费、调账。

用法：backend\\.venv\\Scripts\\python.exe .tmp-test/billing_test.py
"""
import sys
import time

import requests

sys.path.insert(0, "backend")
import auth  # noqa: E402
import db  # noqa: E402

BASE = "http://127.0.0.1:8301"
PDF = ".tmp-test/test-print.pdf"
PPTX = ".tmp-test/test-ppt.pptx"
PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("  [PASS] " if cond else "  [FAIL] ") + name + (f"  {extra}" if extra else ""))


tag = str(int(time.time()))[-6:]
admin_token = requests.post(f"{BASE}/api/login", json={"username": "admin", "password": "admin123"}, timeout=20).json()["token"]
AH = {"Authorization": "Bearer " + admin_token}


def register(name, password="Test123456", source="local"):
    """注册一个账号（可指定 source，用来验证 anticraft 账号免费）"""
    r = requests.post(f"{BASE}/api/register", json={"username": name, "password": password}, timeout=20)
    token = r.json()["token"]
    user = r.json()["user"]
    if source != "local":
        with db.tx() as cur:
            cur.execute("UPDATE users SET source=%s WHERE id=%s", (source, user["id"]))
    return user["id"], token


def login(name, password):
    return requests.post(f"{BASE}/api/login", json={"username": name, "password": password}, timeout=20).json()["token"]


def submit(token, paths, **fields):
    data = {"address": "计费测试（可删除）", "delivery_mode": "配送", "note": "计费验证"}
    data.update(fields)
    files = []
    for path in paths:
        with open(path, "rb") as fh:
            content = fh.read()
        name = path.rsplit("/", 1)[-1]
        mime = "application/octet-stream"
        files.append(("files", (name, content, mime)))
    return requests.post(BASE + "/api/jobs", data=data, headers={"Authorization": "Bearer " + token}, files=files, timeout=180)


def set_price(value):
    return requests.post(BASE + "/api/settings", headers=AH, json={"print_price": value}, timeout=20)


def set_free_users(value):
    return requests.post(BASE + "/api/settings", headers=AH, json={"free_users": value}, timeout=20)


def balance_of(token):
    return float(requests.get(BASE + "/api/balance", headers={"Authorization": "Bearer " + token}, timeout=20).json()["balance"])


uin, utoken = register("bill" + tag)
U = {"Authorization": "Bearer " + utoken}
print(f"\n计费账号 #{uin} bill{tag}")

try:
    print("\n1. 默认单价与账号类型")
    me = requests.get(BASE + "/api/profile", headers=U, timeout=20).json()["profile"]
    check("默认单价 0.1 元/张", me.get("price") == "0.1 元/张", str(me.get("price")))
    check("普通本地账号需计费", me.get("billable") is True and me.get("free_reason") == "", str(me))
    check("初始余额 0", float(me.get("balance") or 0) == 0, str(me.get("balance")))

    print("\n2. 余额不足：402 且不建单、不扣钱")
    before = len(requests.get(BASE + "/api/jobs/mine", headers=U, timeout=20).json()["jobs"])
    r = submit(utoken, [PDF])
    detail = r.json().get("detail") if r.status_code == 402 else {}
    check("余额 0 提交 → 402", r.status_code == 402, f"{r.status_code} {str(r.text)[:80]}")
    check("402 带结构化信息（code/cost/balance）",
          isinstance(detail, dict) and detail.get("code") == "insufficient_balance"
          and float(detail.get("cost", 0)) == 0.1 and float(detail.get("balance", -1)) == 0,
          str(detail))
    check("没有创建任务", len(requests.get(BASE + "/api/jobs/mine", headers=U, timeout=20).json()["jobs"]) == before, "")
    check("余额仍是 0", balance_of(utoken) == 0, str(balance_of(utoken)))

    print("\n3. 充钱后正常扣费（1 页 × 1 份 = 0.1 元）")
    # 调账是 root 权限：测试里把账号临时提到 root（JWT 里的角色是签发时写死的，必须重新登录换新令牌）
    with db.tx() as cur:
        cur.execute("UPDATE users SET role='root' WHERE id=%s", (uin,))
    root_token = login(f"bill{tag}", "Test123456")
    r = requests.post(f"{BASE}/api/users/{uin}/balance", headers={"Authorization": "Bearer " + root_token},
                      json={"delta": "1", "note": "测试充值"}, timeout=20)
    with db.tx() as cur:
        cur.execute("UPDATE users SET role='user' WHERE id=%s", (uin,))
    check("root 调账 +1 元成功", r.status_code == 200 and float(r.json()["balance"]) == 1.0, f"{r.status_code} {str(r.text)[:60]}")

    r = submit(utoken, [PDF])
    job = r.json().get("job", {}) if r.status_code == 200 else {}
    check("提交成功", r.status_code == 200, f"{r.status_code} {str(r.text)[:80]}")
    check("本单扣 0.1 元（charge 落库）", float(job.get("charge") or 0) == 0.1, str(job.get("charge")))
    check("余额扣到 0.9", balance_of(utoken) == 0.9, str(balance_of(utoken)))
    logs = requests.get(BASE + "/api/balance", headers=U, timeout=20).json()["logs"]
    check("流水里有一条「打印扣费 -0.1」",
          any(log["reason"] == "打印扣费" and float(log["delta"]) == -0.1 for log in logs), str(logs[:2]))
    job_id = job.get("id")

    print("\n4. 驳回自动退费")
    r = requests.post(f"{BASE}/api/jobs/{job_id}/reject", headers={**AH, "Content-Type": "application/json"},
                      json={"reason": "计费测试驳回"}, timeout=20)
    check("驳回退回 0.1 元", float(r.json().get("refunded") or 0) == 0.1, f"{r.status_code} {str(r.text)[:60]}")
    check("余额回到 1.0", balance_of(utoken) == 1.0, str(balance_of(utoken)))
    logs = requests.get(BASE + "/api/balance", headers=U, timeout=20).json()["logs"]
    check("流水里有一条「驳回退费 +0.1」",
          any(log["reason"] == "驳回退费" and float(log["delta"]) == 0.1 for log in logs), "")

    print("\n5. 撤回也能退费")
    r = submit(utoken, [PDF])
    jid2 = r.json()["job"]["id"]
    check("再次提交扣费后余额 0.9", balance_of(utoken) == 0.9, str(balance_of(utoken)))
    r = requests.post(f"{BASE}/api/jobs/{jid2}/withdraw", headers=U, timeout=20)
    check("撤回退回 0.1 元", float(r.json().get("refunded") or 0) == 0.1, str(r.status_code))
    check("余额回到 1.0", balance_of(utoken) == 1.0, str(balance_of(utoken)))

    print("\n6. 张数计算：份数 / nup / 页面范围 / PPT 多页")
    r = submit(utoken, [PDF], settings='[{"copies":3,"paper":"A4","pages":"","nup":"1,1","scale":"fit"}]')
    check("3 份 × 1 页 = 0.3 元", float(r.json()["job"]["charge"]) == 0.3, str(r.json()["job"]["charge"]))
    jid3 = r.json()["job"]["id"]
    r = submit(utoken, [PDF], settings='[{"copies":1,"paper":"A4","pages":"1","nup":"2,2","scale":"fit"}]')
    check("nup 2×2 且只打 1 页 → 1 张 0.1 元（当前余额足够）",
          r.status_code == 200 and float(r.json()["job"]["charge"]) == 0.1,
          f"{r.status_code} {str(r.text)[:60]}")
    jid4 = r.json().get("job", {}).get("id")
    for jid in (jid3, jid4):
        if jid:
            requests.post(f"{BASE}/api/jobs/{jid}/withdraw", headers=U, timeout=20)
    before = balance_of(utoken)
    r = submit(utoken, [PPTX])
    check("PPT（3 页）= 0.3 元", r.status_code == 200 and float(r.json()["job"]["charge"]) == 0.3,
          f"{r.status_code} {str(r.text)[:60]} balance before {before}")
    if r.status_code == 200:
        requests.post(f"{BASE}/api/jobs/{r.json()['job']['id']}/withdraw", headers=U, timeout=20)

    print("\n7. 免费账号：管理员 / anticraft / 白名单")
    check("admin 账号提交 charge = 0", (lambda j: j.get("charge") in (0, "0", None))(submit(admin_token, [PDF]).json()["job"]),
          "")
    aid, atoken = register("anti" + tag, source="anticraft")
    AT = {"Authorization": "Bearer " + atoken}
    prof = requests.get(BASE + "/api/profile", headers=AT, timeout=20).json()["profile"]
    check("anticraft 账号被判定免费", prof["billable"] is False and "anticraft" in prof["free_reason"], prof["free_reason"])
    check("anticraft 账号提交 charge = 0", submit(atoken, [PDF]).json()["job"].get("charge") in (0, "0", None), "")

    r = set_free_users(f"bill{tag}")
    check("把账号加进白名单成功", r.status_code == 200, str(r.status_code))
    prof = requests.get(BASE + "/api/profile", headers=U, timeout=20).json()["profile"]
    check("白名单账号被判定免费", prof["billable"] is False and "白名单" in prof["free_reason"], prof["free_reason"])
    bal = balance_of(utoken)
    r = submit(utoken, [PDF])
    check("白名单账号提交不扣费", r.status_code == 200 and float(r.json()["job"]["charge"]) == 0 and balance_of(utoken) == bal,
          f"{r.status_code} {str(r.text)[:60]}")
    jid5 = r.json()["job"]["id"]
    requests.post(f"{BASE}/api/jobs/{jid5}/withdraw", headers=U, timeout=20)
    set_free_users("")

    print("\n8. 单价可改（管理设置）")
    check("单价改成 0.5 成功", set_price("0.5").status_code == 200, "")
    r = submit(utoken, [PDF])
    check("按新单价扣 0.5 元", r.status_code == 200 and float(r.json()["job"]["charge"]) == 0.5,
          f"{r.status_code} {str(r.text)[:60]}")
    jid6 = r.json()["job"]["id"]
    requests.post(f"{BASE}/api/jobs/{jid6}/withdraw", headers=U, timeout=20)
    check("非法单价 400", set_price("abc").status_code == 400, "")
    check("超范围单价 400", set_price("500").status_code == 400, "")
    set_price("0.1")

    print("\n9. 权限：调账限管理员/root")
    r = requests.post(f"{BASE}/api/users/{uin}/balance", headers=AH, json={"delta": "1"}, timeout=20)
    check("admin 能调账（线下收款后代记）", r.status_code == 200, f"{r.status_code} {str(r.text)[:60]}")
    check("用户不能给自己调账（403）", requests.post(f"{BASE}/api/users/{uin}/balance", headers=U, json={"delta": "99"}, timeout=20).status_code == 403, "")

    print("\n10. 负数调账与兜底校验")
    with db.tx() as cur:
        cur.execute("UPDATE users SET role='root' WHERE id=%s", (uin,))
    root_token = login(f"bill{tag}", "Test123456")
    RH = {"Authorization": "Bearer " + root_token}
    r = requests.post(f"{BASE}/api/users/{uin}/balance", headers=RH, json={"delta": "-100"}, timeout=20)
    check("扣到负数被拒（400）", r.status_code == 400, f"{r.status_code} {str(r.text)[:60]}")
    r = requests.post(f"{BASE}/api/users/{uin}/balance", headers=RH, json={"delta": "0"}, timeout=20)
    check("金额 0 被拒（400）", r.status_code == 400, str(r.status_code))
    with db.tx() as cur:
        cur.execute("UPDATE users SET role='user' WHERE id=%s", (uin,))
finally:
    set_price("0.1")
    set_free_users("")
    # 清理：删掉本次测试账号的任务
    for job in requests.get(BASE + "/api/jobs", headers=AH, timeout=20).json()["jobs"]:
        if (job.get("username") or "") in (f"bill{tag}", f"anti{tag}"):
            requests.delete(f"{BASE}/api/jobs/{job['id']}", headers=AH, timeout=20)

print("\n=== 结果 ===")
print(f"通过 {len(PASS)} 项，失败 {len(FAIL)} 项")
for name in FAIL:
    print("  - 失败：" + name)
sys.exit(1 if FAIL else 0)
