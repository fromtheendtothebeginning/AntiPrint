"""anticraft 登录补测（临时脚本）：本地同名冲突 409 / 服务不可达 502 / 真实服务 401。

单独成脚本的原因：登录限速 10 次/分/IP 是共享的，主脚本前面的用例已把额度用满。
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


def login_anticraft(username, password):
    return requests.post(BASE + "/api/login/anticraft", json={"username": username, "password": password}, timeout=20)


admin = requests.post(BASE + "/api/login", json={"username": "admin", "password": "admin123"}, timeout=10).json()
ADMIN_H = {"Authorization": "Bearer " + admin["token"]}


def set_base(url):
    r = requests.post(BASE + "/api/settings", json={"anticraft_base": url}, headers=ADMIN_H, timeout=20)
    r.raise_for_status()


tag = str(int(time.time()))[-6:]

print("\n5. 本地已有同名账号 → 409 拒绝（防顶号）")
collide = "localuser" + tag
requests.post(BASE + "/api/register", json={"username": collide, "password": "Local123456"}, timeout=10).raise_for_status()
requests.post(MOCK + "/api/__set_account", json={"username": collide, "password": "Mock123456"}, timeout=10).raise_for_status()
set_base(MOCK)
r = login_anticraft(collide, "Mock123456")
check("本地账号同名时 anticraft 登录被拒 409", r.status_code == 409, f"{r.status_code} {r.json().get('detail', '')}")
r_local = requests.post(BASE + "/api/login", json={"username": collide, "password": "Local123456"}, timeout=10)
check("本地密码仍然有效（未被顶掉）", r_local.status_code == 200, str(r_local.status_code))

print("\n6. anticraft 服务不可达 → 502")
set_base("http://127.0.0.1:9")
r = login_anticraft("anyone", "anything")
check("不可达 → 502 且提示中文", r.status_code == 502 and "anticraft" in str(r.json().get("detail", "")),
      f"{r.status_code} {r.json().get('detail', '')}")

print("\n7. 指向真实 anticraft.top：错误凭据 → 401（验证可达性与契约）")
set_base(REAL)
r = login_anticraft("__antiprint_probe__", "definitely-wrong-pw-123")
check("真实服务返回 401 且提示 anticraft 账号或密码错误",
      r.status_code == 401 and "anticraft" in str(r.json().get("detail", "")), f"{r.status_code} {r.json().get('detail', '')}")

print("\n8. 收尾：恢复默认地址并清理测试账号")
set_base(REAL)
sys.path.insert(0, "backend")
import db

user = db.get_user_by_name(collide)
if user:
    for job in db.list_jobs(user["id"]):
        db.delete_job(job["id"])
    with db.tx() as cur:
        cur.execute("DELETE FROM users WHERE id=%s", (user["id"],))
settings = requests.get(BASE + "/api/settings", headers=ADMIN_H, timeout=10).json()["settings"]
check("anticraft_base = https://anticraft.top", settings.get("anticraft_base") == REAL, str(settings.get("anticraft_base")))
check("测试账号已清理", db.get_user_by_name(collide) is None, "")

print(f"\n===== 补测结果：通过 {len(PASS)} 项，失败 {len(FAIL)} 项 =====")
for f in FAIL:
    print("  - 失败：" + f)
sys.exit(1 if FAIL else 0)
