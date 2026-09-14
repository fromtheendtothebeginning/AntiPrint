"""anticraft 登录链路测试（临时脚本，不属于交付代码）。

覆盖：自动注册 / 密码同步 / 本地账号冲突 409 / 服务不可达 502 / 真实 anticraft 401。
需要 mock anticraft 已在 127.0.0.1:8302 运行。
"""
import sys
import time

import requests

BASE = "http://127.0.0.1:8301"
MOCK = "http://127.0.0.1:8302"
REAL = "https://anticraft.top"
PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("  [PASS] " if cond else "  [FAIL] ") + name + (f"  {extra}" if extra else ""))


def post(path, payload, base=BASE):
    return requests.post(base + path, json=payload, timeout=20)


def anticraft_login(username, password):
    return post("/api/login/anticraft", {"username": username, "password": password})


admin = post("/api/login", {"username": "admin", "password": "admin123"}).json()
ADMIN_H = {"Authorization": "Bearer " + admin["token"]}


def set_base(url):
    r = post("/api/settings", {"anticraft_base": url}, base=BASE)
    if r.status_code == 401:      # 忘记带管理员头时补一次，避免脚本自身问题掩盖功能问题
        r = requests.post(BASE + "/api/settings", json={"anticraft_base": url}, headers=ADMIN_H, timeout=20)
    r.raise_for_status()
    return r


def mock_account(username, password):
    post("/api/__set_account", {"username": username, "password": password}, base=MOCK).raise_for_status()


def clean_user(username):
    """删掉测试账号（连带其任务）"""
    sys.path.insert(0, "backend")
    import db
    user = db.get_user_by_name(username)
    if not user:
        return
    for job in db.list_jobs(user["id"]):
        db.delete_job(job["id"])
    with db.tx() as cur:
        cur.execute("DELETE FROM users WHERE id=%s", (user["id"],))


print("\n1. 指向 mock 服务后：首次登录自动注册")
set_base(MOCK)
tag = str(int(time.time()))[-6:]
new_user = "acuser" + tag
mock_account(new_user, "Ac123456")
r = anticraft_login(new_user, "Ac123456")
data = r.json() if r.status_code == 200 else {}
check("首次 anticraft 登录成功", r.status_code == 200, f"{r.status_code} {data.get('detail', '')}")
check("auto_registered = true", data.get("auto_registered") is True, str(data.get("auto_registered")))
check("本地账号 source = anticraft", (data.get("user") or {}).get("source") == "anticraft", str(data.get("user")))
check("返回可用 token（能访问 /api/me）", bool(data.get("token")) and requests.get(
    BASE + "/api/me", headers={"Authorization": "Bearer " + data["token"]}, timeout=10).status_code == 200, "")

print("\n2. 用同一 anticraft 账号再次登录：不再重复注册")
r2 = anticraft_login(new_user, "Ac123456")
check("二次登录成功且 auto_registered = false", r2.status_code == 200 and r2.json().get("auto_registered") is False,
      f"{r2.status_code} {r2.json().get('auto_registered')}")

print("\n3. anticraft 侧改密 → 本地密码同步（密码保持一致）")
mock_account(new_user, "Ac654321")
r_old = anticraft_login(new_user, "Ac123456")
check("旧密码被拒 401", r_old.status_code == 401, f"{r_old.status_code} {r_old.json().get('detail', '')}")
r_new = anticraft_login(new_user, "Ac654321")
check("新密码可登录（本地已同步）", r_new.status_code == 200, f"{r_new.status_code}")
r_local = post("/api/login", {"username": new_user, "password": "Ac654321"})
check("同步后可用 AntiPrint 登录页登录（同一密码）", r_local.status_code == 200, str(r_local.status_code))
r_local_old = post("/api/login", {"username": new_user, "password": "Ac123456"})
check("旧的本地密码同时失效", r_local_old.status_code == 401, str(r_local_old.status_code))

print("\n4. 密码错误 / 参数缺失")
r = anticraft_login(new_user, "wrong-password")
check("anticraft 密码错 → 401", r.status_code == 401, f"{r.status_code} {r.json().get('detail', '')}")
r = anticraft_login("", "")
check("空用户名/密码 → 400", r.status_code == 400, str(r.status_code))

print("\n5. 本地已有同名账号 → 409 拒绝（防顶号）")
collide = "localuser" + tag
r_reg = post("/api/register", {"username": collide, "password": "Local123456"})
mock_account(collide, "Mock123456")
r = anticraft_login(collide, "Mock123456")
check("本地账号同名时 anticraft 登录被拒 409", r.status_code == 409, f"{r.status_code} {r.json().get('detail', '')}")
r_local = post("/api/login", {"username": collide, "password": "Local123456"})
check("本地密码仍然有效（未被顶掉）", r_local.status_code == 200, str(r_local.status_code))

print("\n6. anticraft 服务不可达 → 502")
set_base("http://127.0.0.1:9")
r = anticraft_login("anyone", "anything")
check("不可达 → 502 且提示中文", r.status_code == 502 and "anticraft" in str(r.json().get("detail", "")),
      f"{r.status_code} {r.json().get('detail', '')}")

print("\n7. 指向真实 anticraft.top：错误凭据 → 401（验证可达性与契约）")
set_base(REAL)
r = anticraft_login("__antiprint_probe__", "definitely-wrong-pw-123")
check("真实服务返回 401 且提示 anticraft 账号或密码错误",
      r.status_code == 401 and "anticraft" in str(r.json().get("detail", "")), f"{r.status_code} {r.json().get('detail', '')}")

print("\n8. 收尾：恢复默认服务地址并清理测试账号")
set_base(REAL)
settings = requests.get(BASE + "/api/settings", headers=ADMIN_H, timeout=10).json()["settings"]
check("anticraft_base 已恢复为 https://anticraft.top", settings.get("anticraft_base") == REAL, str(settings.get("anticraft_base")))
clean_user(new_user)
clean_user(collide)
import db as _db
check("测试账号已清理", _db.get_user_by_name(new_user) is None and _db.get_user_by_name(collide) is None, "")

print(f"\n===== anticraft 登录测试：通过 {len(PASS)} 项，失败 {len(FAIL)} 项 =====")
for f in FAIL:
    print("  - 失败：" + f)
sys.exit(1 if FAIL else 0)
