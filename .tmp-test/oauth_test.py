"""anticraft 授权码绑定链路测试（临时脚本，不属于交付代码）。

按 D:\\anticraft\\index\\docs\\account-binding-api.md 的协议，用 mock anticraft（8302）
模拟授权页与开放接口，验证 AntiPrint 后端对接：start → bind → callback → exchange。
需要 mock 已运行：在 .tmp-test 下 `backend\\..\\backend\\.venv\\Scripts\\python.exe -m uvicorn mock_anticraft:app --port 8302`
"""
import sys
import time
from urllib.parse import parse_qs, urlparse

import requests

BASE = "http://127.0.0.1:8301"
MOCK = "http://127.0.0.1:8302"
REAL = "https://anticraft.top"
ORIGIN = "http://127.0.0.1:8301"
DEV_ORIGIN = "http://localhost:3010"
REDIRECT = ORIGIN + "/api/oauth/anticraft/callback"

PASS, FAIL = [], []
TAG = str(int(time.time()))[-6:]
CLIENT_ID = "ac_test" + TAG
CLIENT_SECRET = "acs_test" + TAG
test_users = []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("  [PASS] " if cond else "  [FAIL] ") + name + (f"  {extra}" if extra else ""))


def get(path, **kw):
    return requests.get(BASE + path, timeout=20, **kw)


def post(path, payload=None, headers=None):
    return requests.post(BASE + path, json=payload or {}, headers=headers, timeout=20)


def mock_post(path, payload):
    return requests.post(MOCK + path, json=payload, timeout=20)


def mock_get(path, **kw):
    return requests.get(MOCK + path, timeout=20, **kw)


admin = post("/api/login", {"username": "admin", "password": "admin123"}).json()
AH = {"Authorization": "Bearer " + admin["token"]}


def run_flow(origin=ORIGIN, follow_bind=True):
    """跑一遍授权流程，返回 (start_resp, bind_resp, callback_resp)"""
    start = get(f"/api/oauth/anticraft/start?origin={origin}", allow_redirects=False)
    if start.status_code != 302:
        return start, None, None
    bind = mock_get(urlparse(start.headers["Location"]).path + "?" + urlparse(start.headers["Location"]).query,
                    allow_redirects=False) if follow_bind else None
    if not bind or bind.status_code != 302:
        return start, bind, None
    cb = get(urlparse(bind.headers["Location"]).path + "?" + urlparse(bind.headers["Location"]).query,
             allow_redirects=False)
    return start, bind, cb


print("\n0. 未配置绑定应用时的行为")
r = get(f"/api/oauth/anticraft/start?origin={ORIGIN}", allow_redirects=False)
check("未配置 client_id → 503 且提示去登记", r.status_code == 503 and "登记" in str(r.json().get("detail", "")),
      f"{r.status_code} {r.json().get('detail', '')}")
r = get("/api/oauth/anticraft/status")
check("status 报 enabled=false", r.json().get("enabled") is False, str(r.json()))

print("\n1. 登记 mock 应用并写入 AntiPrint 设置")
mock_post("/api/__set_app", {"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
                             "redirect_uris": [REDIRECT, DEV_ORIGIN + "/api/oauth/anticraft/callback"],
                             "name": "AntiPrint 远程打印"})
r = post("/api/settings", {"anticraft_base": MOCK, "anticraft_client_id": CLIENT_ID,
                           "anticraft_client_secret": CLIENT_SECRET}, headers=AH)
check("设置保存成功且密钥只回掩码", r.status_code == 200 and r.json()["settings"]["anticraft_client_secret"] == "******",
      str(r.json().get("settings", {}).get("anticraft_client_secret")))
check("GET 设置同样是掩码", get("/api/settings", headers=AH).json()["settings"]["anticraft_client_secret"] == "******", "")
check("status 报 enabled=true", get("/api/oauth/anticraft/status").json().get("enabled") is True, "")

print("\n2. 来源白名单校验")
r = get("/api/oauth/anticraft/start?origin=http://evil.example.com", allow_redirects=False)
check("未登记来源 → 400 中文提示", r.status_code == 400 and "允许列表" in str(r.json().get("detail", "")),
      f"{r.status_code} {r.json().get('detail', '')}")

print("\n3. 完整授权链路：start → bind → callback → exchange")
start, bind, cb = run_flow()
check("start 302 到 anticraft 授权页", start.status_code == 302 and start.headers["Location"].startswith(f"{MOCK}/bind?"),
      start.headers.get("Location", "")[:70])
q = parse_qs(urlparse(start.headers["Location"]).query)
check("授权参数带 client_id / redirect_uri / state",
      q.get("client_id", [""])[0] == CLIENT_ID and q.get("redirect_uri", [""])[0] == REDIRECT and len(q.get("state", [""])[0]) >= 16,
      str({k: v[0][:40] for k, v in q.items()}))
check("授权页 302 回跳带 code + state", bind.status_code == 302 and "code=" in bind.headers["Location"], "")
cb_q = parse_qs(urlparse(cb.headers["Location"]).query)
check("后端回调 302 到前端落地页带 ticket",
      cb.status_code == 302 and cb.headers["Location"].startswith(ORIGIN + "/login/anticraft/callback?ticket="),
      cb.headers.get("Location", "")[:80])
ticket = cb_q.get("ticket", [""])[0]
r = post("/api/oauth/anticraft/exchange", {"ticket": ticket})
data = r.json() if r.status_code == 200 else {}
check("ticket 换到本地登录态", r.status_code == 200 and bool(data.get("token")), f"{r.status_code} {data}")
check("首次授权 auto_registered=true", data.get("auto_registered") is True, str(data.get("auto_registered")))
check("本地账号 source=anticraft", (data.get("user") or {}).get("source") == "anticraft", str(data.get("user")))
if data.get("token"):
    me = get("/api/me", headers={"Authorization": "Bearer " + data["token"]})
    check("该 token 可访问 /api/me", me.status_code == 200, str(me.json() if me.status_code == 200 else me.status_code))
test_users.append((data.get("user") or {}).get("username"))

print("\n4. 绑定关系落在 anticraft_id 上（用户名可改）")
sys.path.insert(0, "backend")
import db  # noqa: E402

linked = db.get_user_by_anticraft_id(42)
check("DB 中 anticraft_id=42 已绑定", linked is not None and linked["username"] == "someone",
      f"{linked['username'] if linked else None}")

print("\n5. 票据与 state 都是一次性")
r = post("/api/oauth/anticraft/exchange", {"ticket": ticket})
check("同一 ticket 第二次兑换 → 400", r.status_code == 400, f"{r.status_code} {r.json().get('detail', '')}")
r = get(f"/api/oauth/anticraft/callback?code=whatever&state={q.get('state', [''])[0]}", allow_redirects=False)
check("已用过的 state 再回跳 → 400 中文", r.status_code == 400 and "失效" in str(r.json().get("detail", "")),
      f"{r.status_code} {r.json().get('detail', '')}")

print("\n6. 二次授权：复用同一账号，不重复建号")
start, bind, cb = run_flow()
ticket = parse_qs(urlparse(cb.headers["Location"]).query).get("ticket", [""])[0]
data2 = post("/api/oauth/anticraft/exchange", {"ticket": ticket}).json()
check("二次授权成功且 auto_registered=false", data2.get("auto_registered") is False, str(data2.get("auto_registered")))
check("仍是同一个本地账号", (data2.get("user") or {}).get("id") == (data.get("user") or {}).get("id"),
      f"{data2.get('user')}")

print("\n7. anticraft 侧改用户名：按 ID 认出同一人，不新建账号")
mock_post("/api/__config", {"username": "someone_renamed"})
with db.tx() as cur:
    cur.execute("SELECT COUNT(*) c FROM users")
    before = cur.fetchone()["c"]
start, bind, cb = run_flow()
ticket = parse_qs(urlparse(cb.headers["Location"]).query).get("ticket", [""])[0]
data3 = post("/api/oauth/anticraft/exchange", {"ticket": ticket}).json()
with db.tx() as cur:
    cur.execute("SELECT COUNT(*) c FROM users")
    after = cur.fetchone()["c"]
check("改名后登录成功且不新建账号", data3.get("user", {}).get("id") == data.get("user", {}).get("id") and before == after,
      f"用户数 {before} → {after}")
mock_post("/api/__config", {"username": None})

print("\n8. 用户在授权页点「拒绝」")
mock_post("/api/__config", {"auto_deny": True})
start, bind, cb = run_flow()
check("拒绝后回到前端落地页并带中文错误",
      cb.status_code == 302 and "error=" in cb.headers["Location"] and "/login/anticraft/callback" in cb.headers["Location"],
      cb.headers.get("Location", "")[:90])
mock_post("/api/__config", {"auto_deny": False})

print("\n9. 本地已存在同名账号（不同 anticraft 用户）→ 拒绝")
local_name = "localonly" + TAG
post("/api/register", {"username": local_name, "password": "Local123456"})
mock_post("/api/__config", {"user_id": 777, "username": local_name})
start, bind, cb = run_flow()
check("同名本地账号 → 回落地页报「已被占用」",
      cb.status_code == 302 and "%E5%8D%A0%E7%94%A8" in cb.headers["Location"],   # URL 编码的「占用」
      cb.headers.get("Location", "")[:110])
mock_post("/api/__config", {"user_id": 42, "username": None})

print("\n10. client_secret 不对 → 换令牌失败，回落地页报错")
post("/api/settings", {"anticraft_client_secret": "acs_wrong_secret"}, headers=AH)
start, bind, cb = run_flow()
check("错误密钥 → 回落地页带 anticraft 的报错",
      cb.status_code == 302 and "error=" in cb.headers["Location"]
      and "client_id" in requests.utils.unquote(cb.headers["Location"]),
      requests.utils.unquote(cb.headers["Location"])[:110])
post("/api/settings", {"anticraft_client_secret": CLIENT_SECRET}, headers=AH)

print("\n11. 收尾：恢复真实服务地址、清空绑定配置、清理测试账号")
post("/api/settings", {"anticraft_base": REAL, "anticraft_client_id": ""}, headers=AH)
with db.tx() as cur:      # 空串会被「保持原值」逻辑挡住，这里直接清库
    cur.execute("UPDATE settings SET v='' WHERE k IN ('anticraft_client_id','anticraft_client_secret')")
settings = get("/api/settings", headers=AH).json()["settings"]
check("已恢复 https://anticraft.top 且清空 client_id/secret",
      settings["anticraft_base"] == REAL and settings["anticraft_client_id"] == "" and settings["anticraft_client_secret"] == "",
      f"{settings['anticraft_base']} / {settings['anticraft_client_id']!r}")
for name in test_users + [local_name]:
    if not name:
        continue
    user = db.get_user_by_name(name)
    if user:
        for job in db.list_jobs(user["id"]):
            db.delete_job(job["id"])
        with db.tx() as cur:
            cur.execute("DELETE FROM users WHERE id=%s", (user["id"],))
with db.tx() as cur:
    cur.execute("DELETE FROM users WHERE anticraft_id IS NOT NULL AND role<>'admin'")
    cur.execute("SELECT COUNT(*) c FROM users")
    remaining = cur.fetchone()["c"]
check("测试账号已清理（仅剩管理员）", remaining == 1, f"剩余用户 {remaining} 个")

print(f"\n===== 授权绑定测试：通过 {len(PASS)} 项，失败 {len(FAIL)} 项 =====")
for f in FAIL:
    print("  - 失败：" + f)
sys.exit(1 if FAIL else 0)
