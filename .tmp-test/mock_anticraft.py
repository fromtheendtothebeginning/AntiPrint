"""mock anticraft 服务（临时测试用，不属于交付代码）。

同时模拟两类接口，用来在没有真实 anticraft 账号的情况下验证 AntiPrint 的对接代码：
1) 密码登录（旧模式）：POST /api/login、GET /api/me
2) 账号绑定开放接口（授权码模式，按 index/docs/account-binding-api.md 实现）：
   GET  /bind?client_id&redirect_uri&state   授权页（本 mock 直接同意并回跳）
   POST /api/open/token                      code 换 access_token
   GET  /api/open/userinfo                   Bearer act_xxx 读资料
   测试控制：POST /api/__set_account、POST /api/__set_app、POST /api/__config

    backend\\.venv\\Scripts\\python.exe -m uvicorn mock_anticraft:app --port 8302   （在本目录下运行）
"""
import secrets
import time
from urllib.parse import urlencode

from fastapi import Body, FastAPI, Header, HTTPException
from fastapi.responses import RedirectResponse

app = FastAPI(title="mock anticraft")

# ── 密码登录（旧模式）──
ACCOUNTS: dict[str, str] = {"demo": "demo123456"}
TOKENS: dict[str, str] = {}

# ── 绑定应用（白名单）──
APPS: dict[str, dict] = {}          # client_id → {secret, redirect_uris}
CODES: dict[str, dict] = {}         # code → {client_id, user, created}
ACCESS_TOKENS: dict[str, dict] = {} # access_token → {client_id, user}
CONFIG: dict = {"auto_deny": False}

USER_PROFILE = {"id": 42, "username": "someone", "nickname": "某人", "avatar_url": None,
                "created_at": "2025-11-02T13:20:31"}
CODE_TTL_SECONDS = 300


@app.post("/api/login")
def login(payload: dict = Body(default={})):
    username = str(payload.get("username") or "").strip()
    password = str(payload.get("password") or "")
    if ACCOUNTS.get(username) != password or not password:
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    token = f"mock-token-{username}-{len(TOKENS) + 1}"
    TOKENS[token] = username
    return {"token": token}


@app.get("/api/me")
def me(authorization: str = Header(default="")):
    token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    username = TOKENS.get(token)
    if not username:
        raise HTTPException(status_code=401, detail="未登录或登录已过期")
    return {"username": username, "role": "user"}


# ── 授权页 ──

@app.get("/bind")
def bind(client_id: str = "", redirect_uri: str = "", state: str = ""):
    app_conf = APPS.get(client_id)
    if not app_conf:
        raise HTTPException(status_code=404, detail="应用不存在或已停用（不在白名单内）")
    if redirect_uri not in app_conf["redirect_uris"]:
        raise HTTPException(status_code=400, detail="回调地址与登记值不一致")
    if CONFIG.get("auto_deny"):
        return RedirectResponse(f"{redirect_uri}?{urlencode({'error': 'access_denied', 'state': state})}", status_code=302)
    code = "acb_" + secrets.token_urlsafe(12)
    profile = dict(USER_PROFILE)
    profile["id"] = CONFIG.get("user_id", USER_PROFILE["id"])   # 可切换用户，便于测不同绑定场景
    if CONFIG.get("username"):
        profile["username"] = CONFIG["username"]
    CODES[code] = {"client_id": client_id, "user": profile, "created": time.time()}
    return RedirectResponse(f"{redirect_uri}?{urlencode({'code': code, 'state': state})}", status_code=302)


@app.get("/api/open/apps/{client_id}")
def app_info(client_id: str):
    app_conf = APPS.get(client_id)
    if not app_conf:
        raise HTTPException(status_code=404, detail="应用不存在或已停用（不在白名单内）")
    return {"client_id": client_id, "name": app_conf.get("name", "mock app"), "scope": "profile"}


@app.post("/api/open/token")
def open_token(payload: dict = Body(default={})):
    client_id = str(payload.get("client_id") or "")
    client_secret = str(payload.get("client_secret") or "")
    code = str(payload.get("code") or "")
    app_conf = APPS.get(client_id)
    if not app_conf or app_conf["secret"] != client_secret:
        raise HTTPException(status_code=400, detail="client_id 或 client_secret 无效")
    record = CODES.pop(code, None)                      # 一次性
    if not record or record["client_id"] != client_id or time.time() - record["created"] > CODE_TTL_SECONDS:
        raise HTTPException(status_code=400, detail="授权码无效或已过期")
    access_token = "act_" + secrets.token_urlsafe(16)
    ACCESS_TOKENS[access_token] = {"client_id": client_id, "user": record["user"]}
    return {
        "access_token": access_token,
        "token_type": "Bearer",
        "expires_in": 2592000,
        "scope": "profile",
        "user": record["user"],
    }


@app.get("/api/open/userinfo")
def open_userinfo(authorization: str = Header(default="")):
    token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    record = ACCESS_TOKENS.get(token)
    if not record:
        raise HTTPException(status_code=401, detail="访问令牌无效或已过期")
    return {"app": {"client_id": record["client_id"], "name": "mock app"}, "scope": "profile", "user": record["user"]}


# ── 测试控制 ──

@app.post("/api/__set_account")
def set_account(payload: dict = Body(default={})):
    """新增/修改密码登录账号"""
    username = str(payload.get("username") or "").strip()
    password = str(payload.get("password") or "")
    if not username or not password:
        raise HTTPException(status_code=400, detail="需要 username 与 password")
    ACCOUNTS[username] = password
    return {"ok": True, "accounts": sorted(ACCOUNTS)}


@app.post("/api/__set_app")
def set_app(payload: dict = Body(default={})):
    """登记/更新绑定应用（模拟 anticraft 后台的白名单登记）"""
    client_id = str(payload.get("client_id") or "").strip()
    client_secret = str(payload.get("client_secret") or "").strip()
    redirect_uris = payload.get("redirect_uris") or []
    if not client_id or not client_secret or not redirect_uris:
        raise HTTPException(status_code=400, detail="需要 client_id / client_secret / redirect_uris")
    APPS[client_id] = {"secret": client_secret, "redirect_uris": list(redirect_uris),
                       "name": payload.get("name") or "AntiPrint 远程打印"}
    return {"ok": True, "apps": sorted(APPS)}


@app.post("/api/__config")
def set_config(payload: dict = Body(default={})):
    """测试开关：auto_deny（授权页点拒绝）、username / user_id（模拟不同 anticraft 用户与改名）"""
    CONFIG.update({k: v for k, v in payload.items() if k in ("auto_deny", "username", "user_id")})
    return {"ok": True, "config": CONFIG}
