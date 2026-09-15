"""用户管理（账号操作中心）接口测试：删除账号护栏 + 免费白名单按账号开关。

用法：backend\\.venv\\Scripts\\python.exe .tmp-test/users_admin_test.py
"""
import sys
import time

import requests

BASE = "http://127.0.0.1:8301"
PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("  [PASS] " if cond else "  [FAIL] ") + name + (f"  {extra}" if extra else ""))


tag = str(int(time.time()))[-6:]
admin = requests.post(f"{BASE}/api/login", json={"username": "admin", "password": "admin123"}, timeout=20).json()["token"]
AH = {"Authorization": "Bearer " + admin}
root = requests.post(f"{BASE}/api/login", json={"username": "roottest", "password": "Test123456"}, timeout=20).json()["token"]
RH = {"Authorization": "Bearer " + root}


def register(name):
    r = requests.post(f"{BASE}/api/register", json={"username": name, "password": "Test123456"}, timeout=20).json()
    return r["user"]["id"], r["token"]


def users_by_name():
    return {u["username"]: u for u in requests.get(f"{BASE}/api/users", headers=AH, timeout=20).json()["users"]}


try:
    print("\n1. 列表里能看到所有账号（含余额）")
    del_id, del_token = register("deluser" + tag)
    keep_id, _ = register("keepuser" + tag)
    rows = users_by_name()
    check("新账号出现在列表里", "deluser" + tag in rows and "keepuser" + tag in rows, "")
    check("列表带余额字段", "balance" in rows["deluser" + tag], str(rows.get("deluser" + tag, {}).keys()))

    print("\n2. 删除账号的护栏")
    # 管理员也能删（2026-09-15 放开：与「调整余额」「白名单」同级运营权限）
    other_id, _ = register("deladmin" + tag)
    r = requests.delete(f"{BASE}/api/users/{other_id}", headers=AH, timeout=20)
    check("admin 也能删号（余额 0）", r.status_code == 200, f"{r.status_code} {str(r.text)[:50]}")
    root_id = users_by_name()["roottest"]["id"]
    check("删自己（roottest）→ 400", requests.delete(f"{BASE}/api/users/{root_id}", headers=RH, timeout=20).status_code == 400, "")
    end_row = users_by_name().get("end", {})
    check("删 root 账号 → 400", requests.delete(f"{BASE}/api/users/{end_row.get('id', 0)}", headers=RH, timeout=20).status_code == 400, "")
    # 先充点钱 → 余额不为 0 不让删
    requests.post(f"{BASE}/api/users/{del_id}/balance", headers=AH, json={"delta": "2", "note": "删除测试"}, timeout=20)
    r = requests.delete(f"{BASE}/api/users/{del_id}", headers=RH, timeout=20)
    check("余额不为 0 → 400 且提示先扣到 0", r.status_code == 400 and "余额" in r.json().get("detail", ""), f"{r.status_code} {str(r.text)[:60]}")
    check("该账号还在", "deluser" + tag in users_by_name(), "")

    print("\n3. 清空余额后可以删除")
    requests.post(f"{BASE}/api/users/{del_id}/balance", headers=AH, json={"delta": "-2", "note": "扣到 0"}, timeout=20)
    r = requests.delete(f"{BASE}/api/users/{del_id}", headers=RH, timeout=20)
    check("余额 0 → 删除成功", r.status_code == 200, f"{r.status_code} {str(r.text)[:60]}")
    check("列表里没有了", "deluser" + tag not in users_by_name(), "")
    r = requests.post(f"{BASE}/api/login", json={"username": "deluser" + tag, "password": "Test123456"}, timeout=20)
    check("该账号已无法登录（401）", r.status_code == 401, str(r.status_code))
    check("另一个账号没被误删", "keepuser" + tag in users_by_name(), "")

    print("\n4. 免费白名单按账号开关（用户管理页用的就是这两个调用）")
    uname = "keepuser" + tag
    before = requests.get(f"{BASE}/api/settings", headers=AH, timeout=20).json()["settings"]["free_users"] or ""
    r = requests.post(f"{BASE}/api/settings", headers=AH, json={"free_users": f"{before},{uname}"}, timeout=20)
    check("加入白名单成功", r.status_code == 200 and uname in r.json()["settings"]["free_users"], "")
    prof = requests.get(f"{BASE}/api/profile", headers={"Authorization": "Bearer " + requests.post(f"{BASE}/api/login", json={'username': uname, 'password': 'Test123456'}, timeout=20).json()['token']}, timeout=20).json()["profile"]
    check("该账号被判为免费", prof["billable"] is False and "白名单" in prof["free_reason"], prof["free_reason"])
    requests.post(f"{BASE}/api/settings", headers=AH, json={"free_users": before}, timeout=20)
    check("移出白名单后恢复计费", requests.get(f"{BASE}/api/settings", headers=AH, timeout=20).json()["settings"]["free_users"] == before, "")
    print('\n5. 预登记：白名单里放「还没注册的名字」，注册后自动免费')
    pending = "pending" + tag
    settings_before = requests.get(f"{BASE}/api/settings", headers=AH, timeout=20).json()["settings"]["free_users"] or ""
    r = requests.post(f"{BASE}/api/settings", headers=AH,
                      json={"free_users": f"{settings_before},{pending}"}, timeout=20)
    check("把未注册的名字加进白名单成功", r.status_code == 200 and pending in r.json()["settings"]["free_users"], "")
    check("此时本站还没有这个账号", pending not in users_by_name(), "")
    reg2 = requests.post(f"{BASE}/api/register", json={"username": pending, "password": "Test123456"}, timeout=20).json()
    PH = {"Authorization": "Bearer " + reg2["token"]}
    prof2 = requests.get(f"{BASE}/api/profile", headers=PH, timeout=20).json()["profile"]
    check("注册后立刻是免费账号（登录即生效）",
          prof2["billable"] is False and "白名单" in prof2["free_reason"], prof2["free_reason"])
    with open(".tmp-test/test-print.pdf", "rb") as fh:
        pdf = fh.read()
    r = requests.post(f"{BASE}/api/jobs", headers=PH, timeout=120,
                      data={"address": "预登记白名单测试（可删除）", "delivery_mode": "配送"},
                      files=[("files", ("test-print.pdf", pdf, "application/pdf"))])
    job2 = r.json().get("job", {}) if r.status_code == 200 else {}
    check("该账号提交任务不扣费（charge=0）",
          r.status_code == 200 and float(job2.get("charge") or 0) == 0, f"{r.status_code} charge={job2.get('charge')}")
    if job2.get("id"):
        requests.delete(f"{BASE}/api/jobs/{job2['id']}", headers=AH, timeout=20)
    requests.post(f"{BASE}/api/settings", headers=AH, json={"free_users": settings_before}, timeout=20)

finally:
    for name in ("deluser" + tag, "keepuser" + tag, pending):
        row = users_by_name().get(name)
        if row:
            requests.post(f"{BASE}/api/users/{row['id']}/balance", headers=AH,
                          json={"delta": str(-float(row.get("balance") or 0)), "note": "测试收尾"}, timeout=20)
            requests.delete(f"{BASE}/api/users/{row['id']}", headers=RH, timeout=20)

print("\n=== 结果 ===")
print(f"通过 {len(PASS)} 项，失败 {len(FAIL)} 项")
for name in FAIL:
    print("  - 失败：" + name)
sys.exit(1 if FAIL else 0)
