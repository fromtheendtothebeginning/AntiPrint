"""角色权限测试（临时脚本）：root 提拔/收回管理员，admin 只读，user 无权。

用法：backend\\.venv\\Scripts\\python.exe .tmp-test\role_test.py
"""
import sys

import requests

BASE = "http://127.0.0.1:8301"
PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("  [PASS] " if cond else "  [FAIL] ") + name + (f"  {extra}" if extra else ""))


def token_of(username, password):
    r = requests.post(f"{BASE}/api/login", json={"username": username, "password": password}, timeout=20)
    return (r.json().get("token") or "") if r.status_code == 200 else ""


ROOT = token_of("roottest", "Test123456")
ADMIN = token_of("admin", "admin123")
USER = token_of("roletarget", "Test123456")
check("三个测试账号都能登录", bool(ROOT) and bool(ADMIN) and bool(USER), f"root={bool(ROOT)} admin={bool(ADMIN)} user={bool(USER)}")


def H(tok):
    return {"Authorization": "Bearer " + tok}


print("\n1. 用户列表接口")
r = requests.get(f"{BASE}/api/users", headers=H(ROOT), timeout=20)
users = {u["username"]: u for u in r.json().get("users", [])} if r.status_code == 200 else {}
check("root 能看用户列表", r.status_code == 200 and "roletarget" in users, f"{r.status_code}")
check("列表带角色/来源/任务数/注册时间", all(k in users.get("roletarget", {}) for k in ("role", "source", "job_count", "created_at")), "")
check("列表里 end 已是 root", users.get("end", {}).get("role") == "root", str(users.get("end", {}).get("role")))
r = requests.get(f"{BASE}/api/users", headers=H(ADMIN), timeout=20)
check("admin 也能看用户列表（只读）", r.status_code == 200, str(r.status_code))
r = requests.get(f"{BASE}/api/users", headers=H(USER), timeout=20)
check("普通用户看不了 → 403", r.status_code == 403, str(r.status_code))
r = requests.get(f"{BASE}/api/users", timeout=20)
check("未登录 → 401", r.status_code == 401, str(r.status_code))

tid = users.get("roletarget", {}).get("id")
print("\n2. root 提拔 / 收回管理员")
r = requests.post(f"{BASE}/api/users/{tid}/role", json={"role": "admin"}, headers=H(ROOT), timeout=20)
check("root 把普通用户提为管理员", r.status_code == 200 and r.json()["user"]["role"] == "admin", f"{r.status_code} {r.text[:80]}")
r = requests.get(f"{BASE}/api/me", headers=H(token_of("roletarget", "Test123456")), timeout=20)
check("该用户重新登录后 /api/me 是 admin", r.json().get("role") == "admin", str(r.json()))
new_admin = token_of("roletarget", "Test123456")
r = requests.get(f"{BASE}/api/jobs", headers=H(new_admin), timeout=20)
check("新管理员能访问管理端接口（任务队列）", r.status_code == 200, str(r.status_code))
r = requests.post(f"{BASE}/api/users/{tid}/role", json={"role": "user"}, headers=H(ROOT), timeout=20)
check("root 能收回管理员", r.status_code == 200 and r.json()["user"]["role"] == "user", f"{r.status_code}")
r = requests.get(f"{BASE}/api/jobs", headers=H(token_of("roletarget", "Test123456")), timeout=20)
check("收回后不再是管理员（403）", r.status_code == 403, str(r.status_code))

print("\n3. 越权与边界")
r = requests.post(f"{BASE}/api/users/{tid}/role", json={"role": "admin"}, headers=H(ADMIN), timeout=20)
check("admin 改角色 → 403（只有 root 能改）", r.status_code == 403, f"{r.status_code} {r.json().get('detail','')}")
r = requests.post(f"{BASE}/api/users/{tid}/role", json={"role": "root"}, headers=H(ROOT), timeout=20)
check("不允许通过接口造 root → 400", r.status_code == 400, f"{r.status_code} {r.json().get('detail','')}")
root_id = users.get("roottest", {}).get("id")
r = requests.post(f"{BASE}/api/users/{root_id}/role", json={"role": "user"}, headers=H(ROOT), timeout=20)
check("不能改自己的角色 → 400", r.status_code == 400, f"{r.status_code} {r.json().get('detail','')}")
end_id = users.get("end", {}).get("id")
r = requests.post(f"{BASE}/api/users/{end_id}/role", json={"role": "user"}, headers=H(ROOT), timeout=20)
check("不能改 root 账号的角色 → 400", r.status_code == 400, f"{r.status_code} {r.json().get('detail','')}")
r = requests.post(f"{BASE}/api/users/999999/role", json={"role": "admin"}, headers=H(ROOT), timeout=20)
check("改不存在的用户 → 404", r.status_code == 404, str(r.status_code))

print("\n4. root 权限覆盖管理员接口")
r = requests.get(f"{BASE}/api/settings", headers=H(ROOT), timeout=20)
check("root 能读管理设置", r.status_code == 200, str(r.status_code))
r = requests.get(f"{BASE}/api/jobs", headers=H(ROOT), timeout=20)
check("root 能看待审队列", r.status_code == 200, str(r.status_code))

print(f"\n===== 角色权限测试：通过 {len(PASS)} 项，失败 {len(FAIL)} 项 =====")
for f in FAIL:
    print("  - 失败：" + f)
sys.exit(1 if FAIL else 0)
