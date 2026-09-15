# main.py — AntiPrint 后端入口：用户/管理员 HTTP 接口 + 打印代理路由 + 生产静态托管（单进程）

import hashlib
import json
import logging
import mimetypes
import os
import re
import secrets
import shutil
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import pymysql
import uvicorn
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from decimal import Decimal

import auth
import billing
import config
import constants
import convert
import db
import agent_api
from agent_api import router as agent_router

# ── pythonw 兼容：pythonw.exe 下 sys.stdout/stderr 为 None，uvicorn 与 logging 会直接抛错
# （antiClass 踩过此坑，勿删）──
if sys.stdout is None or sys.stderr is None:
    _log_stream = open(config.LOG_DIR / "server.log", "a", encoding="utf-8")
    if sys.stdout is None:
        sys.stdout = _log_stream
    if sys.stderr is None:
        sys.stderr = _log_stream

# ── 日志：中文，落 backend/log/server.log ──
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.FileHandler(config.LOG_DIR / "server.log", encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("antiprint")

# 登录限速：同一 IP 每分钟最多 10 次尝试（内存滑动窗口，够本机/小规模部署用）
LOGIN_LIMIT = 10
LOGIN_WINDOW_SECONDS = 60
_login_hits: dict[str, deque] = {}
_login_lock = threading.Lock()


def _client_ip(request: Request) -> str:
    """取客户端 IP：优先 X-Forwarded-For 首段（nginx 反代），否则直连地址"""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _rate_limit_login(request: Request):
    """登录限速：超限抛 429"""
    key = _client_ip(request)
    now = time.monotonic()
    with _login_lock:
        if len(_login_hits) > 4096:     # 防御性：来源过多时整体清空，避免内存无上限增长
            _login_hits.clear()
        bucket = _login_hits.setdefault(key, deque())
        while bucket and now - bucket[0] > LOGIN_WINDOW_SECONDS:
            bucket.popleft()
        if len(bucket) >= LOGIN_LIMIT:
            raise HTTPException(status_code=429, detail="登录尝试过于频繁，请 1 分钟后再试")
        bucket.append(now)


def _public_user(user: dict) -> dict:
    return {
        "id": user["id"],
        "username": user["username"],
        "role": user["role"],
        "source": user.get("source") or "local",
    }


# ── anticraft（anticraft.top）账号对接 ──

ANTICRAFT_TIMEOUT_SECONDS = 12
SECRET_MASK = "******"      # client_secret 在管理端只回显掩码，不回明文


def _masked_settings() -> dict:
    """读设置项并给敏感值打掩码（client_secret 只进不出；agent_token 例外——代理配置需要复制）"""
    settings = dict(db.get_settings())
    if settings.get("anticraft_client_secret"):
        settings["anticraft_client_secret"] = SECRET_MASK
    return settings


def _anticraft_request(url: str, payload: dict | None = None, token: str | None = None):
    """调用 anticraft 接口；返回 (HTTP 状态码, 解析后的 dict)。

    4xx/5xx 也返回状态码（不抛异常），只有网络层不可达才抛 OSError/URLError，
    由调用方映射成 502 中文提示。用标准库 urllib，避免给后端新增 requests 依赖。
    """
    headers = {"Accept": "application/json"}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(url, data=data, headers=headers, method="POST" if payload is not None else "GET")
    try:
        with urllib.request.urlopen(request, timeout=ANTICRAFT_TIMEOUT_SECONDS) as response:
            body = response.read().decode("utf-8", "replace")
            return response.status, (json.loads(body) if body.strip() else {})
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, (json.loads(body) if body.strip() else {})
        except json.JSONDecodeError:
            return exc.code, {}


def _agent_online(agents: list) -> bool:
    """是否有代理在 90 秒内上报过心跳；管理员已断开连接时一律算「不在线」"""
    if not agent_api.agent_enabled():
        return False
    now = datetime.now()
    for agent in agents:
        last_seen = agent.get("last_seen")
        if not last_seen:
            continue
        try:
            seen = datetime.fromisoformat(last_seen)
        except ValueError:
            continue
        if (now - seen).total_seconds() <= config.AGENT_ONLINE_SECONDS:
            return True
    return False


def _content_disposition(kind: str, filename: str) -> str:
    """文件名给 ASCII 兜底 + RFC 5987 编码，兼容中文名"""
    fallback = filename.encode("ascii", "ignore").decode().replace('"', "") or "file"
    return f"{kind}; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename)}"


PRINT_OPTION_FIELDS = ("copies", "paper", "pages", "nup", "scale")


def _parse_print_options(raw) -> dict:
    """把库里存的 JSON 文本解析成 dict；解析失败返回空 dict（老数据没有该字段）"""
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    parsed = {k: v for k, v in data.items() if k in PRINT_OPTION_FIELDS and v not in (None, "")}
    if "copies" in parsed:
        try:
            parsed["copies"] = int(parsed["copies"])
        except (TypeError, ValueError):
            parsed.pop("copies", None)
    return parsed


def _build_print_options(paper: str, pages: str, nup: str, scale: str) -> dict:
    """校验提交页传来的打印设置，返回可直接存库的 dict（空值表示用打印机/驱动默认）。

    取值必须是白名单里的 SumatraPDF 参数；页面范围只允许数字、逗号、短横线。
    双面/彩色不在支持范围内（目标机型为黑白激光、无自动双面单元）。
    """
    options = {}
    if paper:
        if paper not in constants.PRINT_PAPER:
            raise HTTPException(status_code=400, detail="纸张大小不正确")
        options["paper"] = paper
    if nup:
        if nup not in constants.PRINT_NUP:
            raise HTTPException(status_code=400, detail="每面页数设置不正确")
        options["nup"] = nup
    if scale:
        if scale not in constants.PRINT_SCALE:
            raise HTTPException(status_code=400, detail="缩放设置不正确")
        options["scale"] = scale
    pages = (pages or "").strip()
    if pages:
        if len(pages) > constants.PAGE_RANGE_MAX_LEN or not re.fullmatch(r"[0-9,\-\s]+", pages):
            raise HTTPException(status_code=400, detail="页面范围格式不正确（示例：1-3,5）")
        options["pages"] = pages
    return options


def _job_payload(job):
    """任务出参：任务级与**每个文件**的 print_options 都从 JSON 文本解析成 dict"""
    if not job:
        return job
    payload = dict(job)
    payload["print_options"] = _parse_print_options(job.get("print_options"))
    payload["files"] = [
        {**item, "print_options": _parse_print_options(item.get("print_options"))}
        for item in (job.get("files") or [])
    ]
    return payload


def _load_job_for(job_id: int, user: dict) -> dict:
    """取任务并校验权限：本人或管理员，否则 403"""
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    if user["role"] not in ("admin", "root") and job["user_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="无权访问该任务")
    return job


def _find_file(job: dict, file_id: int):
    return next((item for item in job.get("files", []) if item["id"] == file_id), None)


def _file_response(job_id: int, file_row: dict, download: bool = False) -> FileResponse:
    """文件响应：路径由 DB 的 stored_name 拼接并校验在 uploads/<job_id>/ 内（防目录穿越）

    Office（Word/PPT）**预览一律给转换后的 PDF**（浏览器内嵌预览也只认 PDF/图片）；
    `download=1` 是「下载原文件」，仍给用户上传的原始文件。
    """
    filename = file_row["filename"]
    path = config.upload_path(job_id, file_row["stored_name"])
    if not path or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="文件不存在")
    if not download and convert.is_office(filename):
        try:
            pdf_path, filename = convert.pdf_for(path, filename, file_row.get("sha256"))
        except convert.ConvertError as exc:
            raise HTTPException(status_code=500, detail=f"无法预览：{exc}")
        path = str(pdf_path)
        media_type = "application/pdf"
    else:
        media_type = mimetypes.guess_type(file_row["stored_name"])[0] or "application/octet-stream"
    headers = {
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": _content_disposition("attachment" if download else "inline", filename),
    }
    return FileResponse(path, media_type=media_type, headers=headers)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动初始化：建库 → 建表 → 补列 → 播种管理员。

    数据库不可用时只打印中文错误日志并继续启动，/api/health 会报 db=error，
    这样前端能起来并看到提示，而不是整个服务挂掉。
    """
    try:
        db.ensure_database()
        db.init_db()
        db.run_migrations()
        db.seed_admin()
        logger.info(
            "数据库初始化完成：库 %s @ %s:%s",
            config.DB, config.DB_CONFIG["host"], config.DB_CONFIG["port"],
        )
    except Exception as exc:
        logger.error("数据库初始化失败，服务仍会启动（/api/health 将报 db=error）：%s", exc)
    yield


app = FastAPI(title="AntiPrint 远程打印服务", version=config.VERSION, lifespan=lifespan)

# 开发期 CORS：允许 Vite(3010) 直连；生产走 nginx 同源，无需跨域
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(agent_router)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    # 用 SAMEORIGIN：管理端要用同源 iframe 预览 PDF，DENY 会把它一起挡掉
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    return response


# ── 请求体模型（字段都有默认值，缺参数时返回中文 400 而不是英文 422）──

class RegisterBody(BaseModel):
    username: str = ""
    password: str = ""


class LoginBody(BaseModel):
    username: str = ""
    password: str = ""


class RejectBody(BaseModel):
    reason: str = ""


class SettingsBody(BaseModel):
    launcher: str | None = None
    printer_name: str | None = None
    copies: str | int | None = None
    dry_run: str | int | bool | None = None
    anticraft_base: str | None = None
    anticraft_client_id: str | None = None
    anticraft_client_secret: str | None = None
    anticraft_origins: str | None = None
    anticraft_admin_users: str | None = None
    print_price: str | None = None
    cover_page: str | int | bool | None = None
    free_users: str | None = None


class TicketBody(BaseModel):
    ticket: str = ""


class AdvanceBody(BaseModel):
    """交接流转的目标状态：待配送 / 待取件 / 已完成"""
    to: str = ""


# ── 健康检查 ──

@app.get("/api/health")
def health():
    """探活：DB 不可用时 db=error（服务本身仍可用）"""
    db_ok = True
    try:
        with db.tx() as cur:
            cur.execute("SELECT 1")
    except Exception:
        db_ok = False
    return {"ok": True, "db": "ok" if db_ok else "error", "version": config.VERSION}


# ── 账号 ──

@app.post("/api/register")
def register(body: RegisterBody):
    username = (body.username or "").strip()
    if not 3 <= len(username) <= 32:
        raise HTTPException(status_code=400, detail="用户名长度需为 3~32 个字符")
    if len(body.password or "") < 6:
        raise HTTPException(status_code=400, detail="密码至少 6 位")
    if db.get_user_by_name(username):
        raise HTTPException(status_code=400, detail="用户名已被占用")
    try:
        user = db.create_user(username, auth.hash_password(body.password), "user")
    except pymysql.err.IntegrityError:
        raise HTTPException(status_code=400, detail="用户名已被占用")
    logger.info("新用户注册：%s", username)
    return {"token": auth.create_token(user), "user": _public_user(user)}


@app.post("/api/login")
def login(body: LoginBody, request: Request):
    _rate_limit_login(request)
    username = (body.username or "").strip()
    user = db.get_user_by_name(username) if username else None
    if not user or not auth.verify_password(body.password or "", user.get("password_hash")):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    logger.info("用户登录：%s（%s）", user["username"], user["role"])
    return {"token": auth.create_token(user), "user": _public_user(user)}


@app.get("/api/me")
def me(user: dict = Depends(auth.get_current_user)):
    return {"id": user["id"], "username": user["username"], "role": user["role"]}


# ── 用户配置：默认地址 / 默认配送方式 / anticraft 绑定 ──

class ProfileBody(BaseModel):
    default_address: str | None = None
    default_delivery: str | None = None


class UnbindBody(BaseModel):
    password: str = ""


def _profile_payload(user: dict) -> dict:
    row = db.get_user_by_id(user["id"]) or {}
    return {
        "id": row.get("id", user["id"]),
        "username": row.get("username", user["username"]),
        "role": row.get("role", user["role"]),
        "source": row.get("source") or "local",
        "anticraft_bound": bool(row.get("anticraft_id")),
        "anticraft_id": row.get("anticraft_id"),
        "default_address": row.get("default_address") or "",
        "default_delivery": row.get("default_delivery") or constants.DELIVER,
        # 计费相关：余额、是否免费（管理员/anticraft/白名单）、为什么免费、当前单价
        "balance": row.get("balance") or 0,
        # 头像文件名（空 = 前端用首字母占位）；前端用 /api/users/{id}/avatar 取图
        "avatar": row.get("avatar") or "",
        "billable": not billing.is_free(row),
        "free_reason": billing.free_reason(row),
        "price": billing.price_text(),
    }


@app.get("/api/profile")
def get_profile(user: dict = Depends(auth.get_current_user)):
    """用户配置：默认配送地址、默认配送方式、anticraft 绑定状态"""
    return {"profile": _profile_payload(user)}


@app.put("/api/profile")
def update_profile(body: ProfileBody, user: dict = Depends(auth.get_current_user)):
    """保存默认地址 / 默认配送方式（提交页据此预填）"""
    row = db.get_user_by_id(user["id"]) or {}
    address = row.get("default_address") or ""
    if body.default_address is not None:
        address = body.default_address.strip()
        if len(address) > 255:
            raise HTTPException(status_code=400, detail="默认地址过长（最多 255 字）")
    mode = row.get("default_delivery") or constants.DELIVER
    if body.default_delivery is not None:
        mode = body.default_delivery.strip()
        if mode not in constants.DELIVERY_MODES:
            raise HTTPException(status_code=400, detail="默认配送方式只能是「配送」或「取件」")
    db.set_user_profile(user["id"], address, mode)
    logger.info("用户 %s 更新配置（默认配送方式=%s）", user["username"], mode)
    return {"profile": _profile_payload(user)}


@app.post("/api/profile/anticraft/bind-ticket")
def anticraft_bind_ticket(user: dict = Depends(auth.get_current_user)):
    """已登录用户发起「绑定 anticraft 账号」：先换一张一次性票据。

    浏览器整页跳转带不了 Authorization 头，所以在这里（带 token）先领票据，
    回调时凭票据知道「这次授权要绑到哪个本地账号」。
    """
    base, client_id, client_secret = _anticraft_config()
    if not (base and client_id and client_secret):
        raise HTTPException(status_code=503, detail="尚未配置 anticraft 绑定应用（client_id / client_secret）")
    ticket = secrets.token_urlsafe(24)
    _oauth_gc()
    with _OAUTH_LOCK:
        _OAUTH_BINDS[ticket] = {"user_id": user["id"], "created": time.monotonic()}
    return {"ticket": ticket}


@app.post("/api/profile/anticraft/unbind")
def anticraft_unbind(body: UnbindBody, user: dict = Depends(auth.get_current_user)):
    """解除 anticraft 绑定：必须同时设置本地密码（授权建号的账号没有可用密码，只解绑会把自己锁在门外）"""
    password = (body.password or "").strip()
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="请设置至少 6 位的本地密码（解绑后用它登录）")
    row = db.get_user_by_id(user["id"]) or {}
    if not row.get("anticraft_id"):
        raise HTTPException(status_code=400, detail="当前账号未绑定 anticraft")
    db.unbind_anticraft(user["id"], auth.hash_password(password))
    logger.info("用户 %s 解除 anticraft 绑定并设置了本地密码", user["username"])
    return {"profile": _profile_payload(user)}


# ── 用户管理（root：超级管理员）──
# 角色层级：user < admin < root。admin 能看用户列表，只有 root 能改角色；
# root 只能把人设为 user / admin（不能通过接口再造 root，避免权限外扩）。

class RoleBody(BaseModel):
    role: str = ""


@app.get("/api/balance")
def get_balance(user: dict = Depends(auth.get_current_user)):
    """我的余额页：余额、是否计费、为什么免费、单价与最近流水"""
    row = db.get_user_by_id(user["id"]) or {}
    return {
        "balance": row.get("balance") or 0,
        "billable": not billing.is_free(row),
        "free_reason": billing.free_reason(row),
        "price": billing.price_text(),
        "logs": db.list_balance_logs(user["id"], 50),
        # 付款码暂未实现：前端据此显示「充值暂未开放」占位
        "recharge_enabled": False,
    }


AVATAR_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp")
AVATAR_MAGIC = (
    b"\x89PNG\r\n\x1a\n",      # png
    b"\xff\xd8\xff",              # jpeg
    b"GIF87a", b"GIF89a",           # gif
)
AVATAR_MAX = 2 * 1024 * 1024        # 2MB


@app.post("/api/profile/avatar")
async def upload_avatar(file: UploadFile = File(...), user: dict = Depends(auth.get_current_user)):
    """上传/更换头像（png/jpg/gif/webp，≤2MB）；换头像只换文件名，前端不用清缓存。"""
    original = Path(file.filename or "").name.strip()[:255] or "avatar"
    suffix = Path(original).suffix.lower()
    if suffix not in AVATAR_EXT:
        raise HTTPException(status_code=400, detail="头像只支持 png / jpg / gif / webp")
    content = await file.read(AVATAR_MAX + 1)
    if len(content) > AVATAR_MAX:
        raise HTTPException(status_code=400, detail="头像不能超过 2MB，请先压缩")
    if not content:
        raise HTTPException(status_code=400, detail="头像文件是空的")
    head = content[:16]
    is_webp = head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    if not (is_webp or any(head.startswith(magic) for magic in AVATAR_MAGIC)):
        raise HTTPException(status_code=400, detail="这不是有效的图片文件（按内容判断）")

    row = db.get_user_by_id(user["id"]) or {}
    old = row.get("avatar") or ""
    stored = f"{user['id']}-{int(time.time() * 1000)}{suffix}"
    (config.AVATAR_DIR / stored).write_bytes(content)
    db.set_user_avatar(user["id"], stored)
    if old and old != stored:
        try:                                     # 旧的删掉，失败不影响这次更换
            (config.AVATAR_DIR / old).unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("删除旧头像 %s 失败：%s", old, exc)
    logger.info("用户 %s 更新了头像（%s，%s 字节）", user["username"], stored, len(content))
    return {"profile": _profile_payload(user)}


@app.delete("/api/profile/avatar")
def remove_avatar(user: dict = Depends(auth.get_current_user)):
    """移除头像：清 users.avatar 并删文件（回到首字母占位）"""
    row = db.get_user_by_id(user["id"]) or {}
    name = str(row.get("avatar") or "")
    if name:
        db.set_user_avatar(user["id"], None)
        try:
            (config.AVATAR_DIR / os.path.basename(name)).unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("删除头像文件 %s 失败：%s", name, exc)
    logger.info("用户 %s 移除了头像", user["username"])
    return {"profile": _profile_payload(user)}


@app.get("/api/users/{user_id}/avatar")
def get_avatar(user_id: int, user: dict = Depends(auth.get_current_user)):
    """读头像图（登录即可看；文件名只允许 avatars/<id>-* 这种形状，防目录穿越）。"""
    row = db.get_user_by_id(user_id)
    if not row or not row.get("avatar"):
        raise HTTPException(status_code=404, detail="该用户没有设置头像")
    name = str(row["avatar"])
    if os.path.basename(name) != name or not name.startswith(f"{user_id}-"):
        raise HTTPException(status_code=404, detail="头像不存在")
    path = config.AVATAR_DIR / name
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="头像文件不存在")
    media_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
    return FileResponse(str(path), media_type=media_type,
                        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"})


@app.get("/api/users")
def list_users(user: dict = Depends(auth.require_admin)):
    """用户列表（管理员可看，含角色/来源/anticraft 绑定/任务数）"""
    return {
        "users": [
            {
                "id": row["id"],
                "username": row["username"],
                "role": row["role"],
                "source": row.get("source") or "local",
                "anticraft_id": row.get("anticraft_id"),
                "balance": row.get("balance") or 0,
                "created_at": row.get("created_at"),
                "job_count": row.get("job_count") or 0,
            }
            for row in db.list_users()
        ]
    }


class BalanceBody(BaseModel):
    """管理员调账：delta 为正=加钱，为负=扣钱（元，最多两位小数）"""
    delta: str | float | int
    note: str | None = None


@app.post("/api/users/{user_id}/balance")
def adjust_user_balance(user_id: int, body: BalanceBody, user: dict = Depends(auth.require_admin)):
    """管理员/root 给某个账号加/减余额（充值暂未实现，先由管理员手工记账）"""
    target = db.get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")
    try:
        delta = billing.parse_price(abs(Decimal(str(body.delta)).copy_abs()))
    except (ValueError, ArithmeticError):
        raise HTTPException(status_code=400, detail="金额需为 0 ~ 100 之间的数字（最多两位小数）")
    if delta == 0:
        raise HTTPException(status_code=400, detail="金额不能为 0")
    if Decimal(str(body.delta)) < 0:
        delta = -delta
    if delta > Decimal("10000") or delta < Decimal("-10000"):
        raise HTTPException(status_code=400, detail="单次调账不能超过 10000 元")
    note = (body.note or "").strip()[:40] or "管理员调账"
    ok, balance = db.add_balance(user_id, delta, note, actor=user["username"])
    if not ok:
        raise HTTPException(status_code=400, detail=f"扣减后余额不能为负（当前 {balance} 元）")
    logger.info("root %s 给用户 %s 调账 %s 元（%s），余额 %s", user["username"], target["username"], delta, note, balance)
    return {"ok": True, "balance": str(balance)}


@app.delete("/api/users/{user_id}")
def delete_user(user_id: int, user: dict = Depends(auth.require_admin)):
    """删除账号（管理员/root）：**余额必须为 0**，不能删自己或 root。

    任务与余额流水保留（任务列表里提交人显示为空），所以不放心的账号先把余额调成 0 再删。
    """
    target = db.get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")
    if target["id"] == user["id"]:
        raise HTTPException(status_code=400, detail="不能删除自己的账号")
    if target["role"] == "root":
        raise HTTPException(status_code=400, detail="不能删除超级管理员账号")
    balance = Decimal(str(target.get("balance") or 0))
    if balance != 0:
        raise HTTPException(
            status_code=400,
            detail=f"该账号余额还有 {balance} 元，先在「调整余额」里扣到 0 再删除",
        )
    db.delete_user(user_id)
    logger.info("root %s 删除了账号 %s（#%s，余额 0）", user["username"], target["username"], user_id)
    return {"ok": True}


@app.post("/api/users/{user_id}/role")
def set_user_role(user_id: int, body: RoleBody, user: dict = Depends(auth.require_root)):
    """root 把某个用户设为「普通用户」或「管理员」"""
    target_role = (body.role or "").strip()
    if target_role not in ("user", "admin"):
        raise HTTPException(status_code=400, detail="角色只能是 user（普通用户）或 admin（管理员）")
    target = db.get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")
    if target["id"] == user["id"]:
        raise HTTPException(status_code=400, detail="不能修改自己的角色")
    if target["role"] == "root":
        raise HTTPException(status_code=400, detail="不能修改超级管理员（root）的角色")
    db.set_user_role(target["id"], target_role)
    logger.info("root %s 把用户 %s 设为 %s", user["username"], target["username"], target_role)
    return {"ok": True, "user": {"id": target["id"], "username": target["username"], "role": target_role}}


@app.post("/api/login/anticraft")
def login_anticraft(body: LoginBody, request: Request):
    """用 anticraft 账号登录。

    凭据交给 anticraft（设置项 anticraft_base，默认 https://anticraft.top）校验：
    本地没有同名账号 → 自动创建（密码与 anticraft 一致）；已有 anticraft 来源账号 → 同步密码；
    已被本地账号占用 → 409 拒绝（避免用 anticraft 账号顶掉 AntiPrint 自建账号，含管理员）。
    """
    _rate_limit_login(request)
    username = (body.username or "").strip()
    password = body.password or ""
    if not username or not password:
        raise HTTPException(status_code=400, detail="请填写 anticraft 用户名和密码")

    base = (db.get_settings().get("anticraft_base") or "").strip().rstrip("/")
    if not base.startswith(("http://", "https://")):
        raise HTTPException(status_code=500, detail="anticraft 服务地址未配置正确，请联系管理员")

    try:
        status, data = _anticraft_request(f"{base}/api/login", {"username": username, "password": password})
    except (urllib.error.URLError, OSError, ValueError) as exc:
        logger.warning("anticraft 登录请求失败：%s", exc)
        raise HTTPException(status_code=502, detail="无法连接 anticraft 服务，请稍后重试或改用 AntiPrint 账号登录")
    if status in (401, 403):
        raise HTTPException(status_code=401, detail="anticraft 账号或密码错误")
    if status != 200:
        raise HTTPException(status_code=502, detail=f"anticraft 登录失败（HTTP {status}）")

    # 反查 /api/me 拿权威用户名：避免大小写/空格差异在本地建出第二个账号
    canonical = username
    anticraft_token = str(data.get("token") or "")
    if anticraft_token:
        try:
            me_status, me_data = _anticraft_request(f"{base}/api/me", token=anticraft_token)
            if me_status == 200 and me_data.get("username"):
                canonical = str(me_data["username"]).strip()
        except (urllib.error.URLError, OSError, ValueError) as exc:
            logger.warning("anticraft /api/me 校验失败，沿用提交的用户名：%s", exc)

    user = db.get_user_by_name(canonical)
    auto_registered = False
    if user is None:
        try:
            user = db.create_user(canonical, auth.hash_password(password), "user", "anticraft")
            auto_registered = True
            logger.info("anticraft 账号首次登录，已自动创建 AntiPrint 账号：%s", canonical)
        except pymysql.err.IntegrityError:
            user = db.get_user_by_name(canonical)      # 并发下已被创建，直接复用
    elif (user.get("source") or "local") == "anticraft":
        db.set_user_password(user["id"], auth.hash_password(password))
        logger.info("anticraft 账号登录，已同步密码保持与 anticraft 一致：%s", canonical)
    else:
        raise HTTPException(status_code=409, detail="该用户名已被 AntiPrint 本地账号占用，请用 AntiPrint 密码登录，或联系管理员")

    if not user:
        raise HTTPException(status_code=500, detail="账号创建失败，请重试")
    # anticraft 站内登录响应里带 role，管理员直接给本地 admin（只提升不降级）
    user = _promote_if_anticraft_admin(user, data.get("user") or {})
    return {"token": auth.create_token(user), "user": _public_user(user), "auto_registered": auto_registered}


# ── anticraft 账号绑定：OAuth 授权码模式（协议见 D:\anticraft\index\docs\account-binding-api.md）──
# 流程：前端跳 /api/oauth/anticraft/start → 302 到 anticraft /bind → 用户确认授权 → 回跳
# /api/oauth/anticraft/callback?code=.. → 服务端用 client_secret 换 access_token → 按 anticraft
# 用户 ID 绑定/创建本地账号 → 302 回前端回调页（带一次性 ticket）→ 前端用 ticket 换本地 JWT。
# client_secret 只在服务端使用，绝不下发浏览器；state 与 ticket 都是一次性、带 TTL。
# 注意：state/ticket 存内存（本项目单进程）；若将来多进程/多实例部署，要改存数据库。

_OAUTH_LOCK = threading.Lock()
_OAUTH_STATES: dict = {}      # state → {origin, return_to, bind_user_id?, created}
_OAUTH_TICKETS: dict = {}     # ticket → {user_id, auto_registered, created}
_OAUTH_BINDS: dict = {}       # 绑定票据 → {user_id, created}（已登录用户发起绑定时使用）
OAUTH_STATE_TTL = 600
OAUTH_TICKET_TTL = 120
OAUTH_BIND_TTL = 300


def _oauth_gc():
    """清理过期的 state / ticket / 绑定票据"""
    now = time.monotonic()
    with _OAUTH_LOCK:
        for store, ttl in (
            (_OAUTH_STATES, OAUTH_STATE_TTL),
            (_OAUTH_TICKETS, OAUTH_TICKET_TTL),
            (_OAUTH_BINDS, OAUTH_BIND_TTL),
        ):
            for key in [k for k, value in store.items() if now - value["created"] > ttl]:
                store.pop(key, None)


def _anticraft_config() -> tuple:
    settings = db.get_settings()
    return (
        (settings.get("anticraft_base") or "").strip().rstrip("/"),
        (settings.get("anticraft_client_id") or "").strip(),
        (settings.get("anticraft_client_secret") or "").strip(),
    )


def _anticraft_origins() -> list:
    raw = db.get_settings().get("anticraft_origins") or ""
    return [part.strip().rstrip("/") for part in raw.split(",") if part.strip()]


def _anticraft_grants_admin(user_info: dict, username: str) -> bool:
    """判断这个 anticraft 账号是不是管理员。

    - 密码登录走的是 anticraft 站内 `/api/login`，响应里带 `role`，直接用；
    - OAuth 绑定的开放接口目前只回 id/username/nickname/avatar_url/created_at（**没有角色**），
      所以退回到可配置名单 `settings.anticraft_admin_users`（逗号分隔用户名）；
    - 将来开放接口若补上 role / is_admin / is_staff，会优先采用接口值。
    """
    for key in ("role", "is_admin", "is_staff"):
        if key in (user_info or {}):
            raw = user_info[key]
            if raw is True:
                return True
            text = str(raw).strip().lower()
            if text in ("admin", "true", "1", "yes"):
                return True
            if text in ("user", "false", "0", "no"):
                return False
    names = [
        name.strip().lower()
        for name in (db.get_settings().get("anticraft_admin_users") or "").split(",")
        if name.strip()
    ]
    return bool(username) and username.strip().lower() in names


def _promote_if_anticraft_admin(user: dict, user_info: dict) -> dict:
    """anticraft 管理员 → 本地 admin。**只提升不降级**：本地已有的管理员不会因为 anticraft 侧不是管理员被撤权。"""
    if not user:
        return user
    if user.get("role") == "user" and _anticraft_grants_admin(user_info, user.get("username", "")):
        db.set_user_role(user["id"], "admin")
        logger.info("anticraft 侧为管理员，本地账号已提升为 admin：%s", user["username"])
        return db.get_user_by_id(user["id"]) or user
    return user


def _oauth_fail(origin, message: str):
    """授权失败：带 origin 时回前端回调页显示中文错误，否则退化为 JSON"""
    if origin:
        return RedirectResponse(f"{origin}/login/anticraft/callback?error={quote(message)}", status_code=302)
    return JSONResponse({"detail": message}, status_code=400)


@app.get("/api/oauth/anticraft/status")
def anticraft_oauth_status():
    """登录页用：是否已配置绑定应用（公开接口，不泄露任何密钥）"""
    base, client_id, client_secret = _anticraft_config()
    return {"enabled": bool(base and client_id and client_secret), "base": base}


@app.get("/api/oauth/anticraft/start")
def anticraft_oauth_start(origin: str = "", return_to: str = "/", bind_ticket: str = ""):
    """发起授权：校验来源白名单 → 生成一次性 state → 302 到 anticraft 授权页。

    bind_ticket 非空时是「已登录用户绑定 anticraft」：state 里记下要绑到哪个本地账号。
    """
    base, client_id, client_secret = _anticraft_config()
    if not (base and client_id and client_secret):
        raise HTTPException(
            status_code=503,
            detail="尚未配置 anticraft 绑定应用：请管理员在 anticraft 后台登记本应用，再把 client_id / client_secret 填进「打印设置」",
        )
    origin = (origin or "").strip().rstrip("/")
    if origin not in _anticraft_origins():
        raise HTTPException(status_code=400, detail=f"来源 {origin or '(空)'} 不在允许列表内（设置项 anticraft_origins）")

    bind_user_id = None
    if bind_ticket:
        _oauth_gc()
        with _OAUTH_LOCK:
            record = _OAUTH_BINDS.pop((bind_ticket or "").strip(), None)
        if not record:
            raise HTTPException(status_code=400, detail="绑定票据无效或已过期，请回到「我的配置」重试")
        bind_user_id = record["user_id"]

    redirect_uri = f"{origin}/api/oauth/anticraft/callback"
    state = secrets.token_urlsafe(24)
    _oauth_gc()
    with _OAUTH_LOCK:
        if len(_OAUTH_STATES) > 1000:       # 防御性：被反复调用刷爆内存时整体清空（最坏只是让在途授权重来一次）
            _OAUTH_STATES.clear()
        _OAUTH_STATES[state] = {
            "origin": origin, "return_to": return_to or "/",
            "bind_user_id": bind_user_id, "created": time.monotonic(),
        }
    logger.info(
        "发起 anticraft 授权：redirect_uri=%s%s",
        redirect_uri, f"（绑定到本地用户 #{bind_user_id}）" if bind_user_id else "",
    )
    query = urllib.parse.urlencode({"client_id": client_id, "redirect_uri": redirect_uri, "state": state})
    return RedirectResponse(f"{base}/bind?{query}", status_code=302)


@app.get("/api/oauth/anticraft/callback")
def anticraft_oauth_callback(code: str = "", state: str = "", error: str = ""):
    """anticraft 授权回跳：一次性 state 校验 → 授权码换令牌 → 绑定/创建本地账号 → 回前端回调页"""
    _oauth_gc()
    with _OAUTH_LOCK:
        record = _OAUTH_STATES.pop(state or "", None)      # pop 保证 state 只能使用一次
    if not record:
        return _oauth_fail(None, "授权会话已失效，请重新点击「用 anticraft 登录」")
    origin = record["origin"]
    if error:
        logger.info("用户取消 anticraft 授权：%s", error)
        return _oauth_fail(origin, "你取消了 anticraft 授权")
    if not code:
        return _oauth_fail(origin, "未收到授权码，请重试")

    base, client_id, client_secret = _anticraft_config()
    try:
        status, data = _anticraft_request(
            f"{base}/api/open/token",
            {"client_id": client_id, "client_secret": client_secret, "code": code},
        )
    except (urllib.error.URLError, OSError, ValueError) as exc:
        logger.warning("换取 anticraft 令牌失败：%s", exc)
        return _oauth_fail(origin, "无法连接 anticraft 服务，请稍后重试")
    if status != 200:
        return _oauth_fail(origin, str(data.get("detail") or f"换取访问令牌失败（HTTP {status}）"))

    info = data.get("user") or {}
    try:
        anticraft_id = int(info.get("id"))
    except (TypeError, ValueError):
        return _oauth_fail(origin, "anticraft 未返回用户 ID，无法绑定账号")
    username = str(info.get("username") or "").strip()
    if not username:
        return _oauth_fail(origin, "anticraft 未返回用户名，无法绑定账号")

    user = db.get_user_by_anticraft_id(anticraft_id)
    auto_registered = False
    bind_user_id = record.get("bind_user_id")
    if bind_user_id:
        # 「我的配置 → 绑定 anticraft 账号」：绑到当前登录的本地账号，不新建、不改用户名
        owner = db.get_user_by_anticraft_id(anticraft_id)
        if owner and owner["id"] != bind_user_id:
            return _oauth_fail(
                origin,
                f"该 anticraft 账号已绑定到 AntiPrint 账号「{owner['username']}」，请先在其账号里解绑",
            )
        user = db.get_user_by_id(bind_user_id)
        if not user:
            return _oauth_fail(origin, "本地账号不存在，请重新登录后再试")
        db.bind_anticraft(bind_user_id, anticraft_id)
        user = db.get_user_by_id(bind_user_id) or user
        logger.info("anticraft 绑定成功：本地 %s ↔ anticraft#%s", user["username"], anticraft_id)
    elif user is None:
        existing = db.get_user_by_name(username)
        if existing:
            if (existing.get("source") or "local") == "anticraft":
                db.bind_anticraft(existing["id"], anticraft_id)     # 早期密码模式建的账号：补上 ID 绑定
                user = db.get_user_by_id(existing["id"])
                logger.info("anticraft 授权：补齐绑定 %s ↔ anticraft#%s", username, anticraft_id)
            else:
                return _oauth_fail(origin, "该用户名已被 AntiPrint 本地账号占用，请用 AntiPrint 密码登录，或联系管理员")
        else:
            # 自动创建：不落任何可用本地密码（随机占位），只能通过 anticraft 授权登录
            user = db.create_user(
                username, auth.hash_password(secrets.token_urlsafe(32)), "user", "anticraft", anticraft_id
            )
            auto_registered = True
            logger.info("anticraft 授权：自动创建 AntiPrint 账号 %s（anticraft#%s）", username, anticraft_id)
    elif user.get("username") != username:
        # anticraft 侧改了用户名：按 anticraft_id 认定是同一个人，本地保留原名（避免撞唯一键）
        logger.info("anticraft 用户名已变更：本地 %s ↔ anticraft %s（按 anticraft_id 识别）", user["username"], username)

    ticket = secrets.token_urlsafe(24)
    user = _promote_if_anticraft_admin(user, info)      # anticraft 管理员 → 本地 admin
    with _OAUTH_LOCK:
        _OAUTH_TICKETS[ticket] = {
            "user_id": user["id"], "auto_registered": auto_registered,
            "bound": bool(bind_user_id), "created": time.monotonic(),
        }
    logger.info(
        "anticraft 授权%s：%s（%s）",
        "绑定" if bind_user_id else "登录", user["username"],
        "自动建号" if auto_registered else ("已绑定" if bind_user_id else "已有账号"),
    )
    return RedirectResponse(f"{origin}/login/anticraft/callback?ticket={ticket}", status_code=302)


@app.post("/api/oauth/anticraft/exchange")
def anticraft_oauth_exchange(body: TicketBody):
    """前端回调页用一次性 ticket 换本地登录态（ticket 2 分钟内有效且只能用一次）"""
    _oauth_gc()
    with _OAUTH_LOCK:
        record = _OAUTH_TICKETS.pop((body.ticket or "").strip(), None)
    if not record:
        raise HTTPException(status_code=400, detail="登录票据无效或已过期，请重新登录")
    user = db.get_user_by_id(record["user_id"])
    if not user:
        raise HTTPException(status_code=400, detail="账号不存在，请重新登录")
    return {
        "token": auth.create_token(user),
        "user": _public_user(user),
        "auto_registered": bool(record.get("auto_registered")),
        "bound": bool(record.get("bound")),
    }


# ── 任务：提交 / 查询 ──

@app.post("/api/jobs")
def create_job(
    address: str = Form(default=""),
    note: str = Form(default=""),
    delivery_mode: str = Form(default=""),
    copies: str = Form(default="1"),
    settings: str = Form(default=""),
    paper: str = Form(default=""),
    pages: str = Form(default=""),
    nup: str = Form(default=""),
    scale: str = Form(default=""),
    files: list[UploadFile] = File(default=[]),
    user: dict = Depends(auth.get_current_user),
):
    """提交打印任务（multipart）：配送单必填地址，取件单可留空；1~5 个 PDF/图片，单文件 ≤10MB。

    delivery_mode 为空时取用户配置里的 default_delivery（默认「配送」）。
    """
    profile = db.get_user_by_id(user["id"]) or {}
    mode = (delivery_mode or "").strip() or (profile.get("default_delivery") or constants.DELIVER)
    if mode not in constants.DELIVERY_MODES:
        raise HTTPException(status_code=400, detail="配送方式只能是「配送」或「取件」")

    address = (address or "").strip()
    if mode == constants.DELIVER and not address:
        raise HTTPException(status_code=400, detail="选择配送时请填写配送地址")
    if len(address) > 255:
        raise HTTPException(status_code=400, detail="配送地址过长（最多 255 字）")
    note = (note or "").strip()
    if len(note) > 500:
        raise HTTPException(status_code=400, detail="备注过长（最多 500 字）")

    try:
        copies_value = int((str(copies or "1").strip() or "1"))
    except ValueError:
        raise HTTPException(status_code=400, detail="份数必须是整数")
    if not 1 <= copies_value <= constants.PRINT_COPIES_MAX:
        raise HTTPException(status_code=400, detail=f"份数需在 1~{constants.PRINT_COPIES_MAX} 之间")
    options = _build_print_options(paper, pages, nup, scale)
    options["copies"] = copies_value
    # 每个文件可以有自己的打印设置：settings 是 JSON 数组，顺序与 files 一一对应；
    # 某一项为空对象时该文件沿用任务级默认（上面的 options）。
    file_settings: list[dict] = []
    if (settings or "").strip():
        try:
            raw_settings = json.loads(settings)
        except ValueError:
            raise HTTPException(status_code=400, detail="打印设置格式不正确")
        if not isinstance(raw_settings, list):
            raise HTTPException(status_code=400, detail="打印设置格式不正确")
        seen_options: dict[str, dict] = {}
        for item in raw_settings:
            if not isinstance(item, dict):
                raise HTTPException(status_code=400, detail="打印设置格式不正确")
            key = json.dumps(item, sort_keys=True, ensure_ascii=False)
            if key not in seen_options:
                one = _build_print_options(
                    str(item.get("paper") or ""), str(item.get("pages") or ""),
                    str(item.get("nup") or ""), str(item.get("scale") or ""),
                )
                raw_copies = item.get("copies")
                if raw_copies in (None, ""):
                    file_copies = copies_value          # 该文件没单独填份数 → 用任务级默认
                else:
                    try:
                        file_copies = int(str(raw_copies))
                    except ValueError:
                        raise HTTPException(status_code=400, detail="份数必须是整数")
                if not 1 <= file_copies <= constants.PRINT_COPIES_MAX:
                    raise HTTPException(status_code=400, detail=f"份数需在 1~{constants.PRINT_COPIES_MAX} 之间")
                one["copies"] = file_copies
                seen_options[key] = one
            file_settings.append(seen_options[key])

    uploads = [f for f in (files or []) if (f.filename or "").strip()]
    if not uploads:
        raise HTTPException(status_code=400, detail="请至少上传一个文件")
    if len(uploads) > config.MAX_FILES:
        raise HTTPException(status_code=400, detail=f"最多上传 {config.MAX_FILES} 个文件")

    # 先落到临时目录（此时还没有 job_id），建库成功后再原子改名为 uploads/<job_id>/
    tmp_dir = config.UPLOAD_DIR / "_tmp" / uuid.uuid4().hex
    tmp_dir.mkdir(parents=True, exist_ok=True)
    saved: list[dict] = []
    seen: set[str] = set()
    try:
        for index, item in enumerate(uploads):
            original = Path(item.filename).name.strip()[:255] or "未命名"
            suffix = Path(original).suffix.lower()
            if suffix in constants.DANGEROUS_EXT:
                raise HTTPException(status_code=400, detail=f"文件 {original} 类型不允许上传（{suffix}）")
            if suffix not in constants.UPLOAD_EXT:
                raise HTTPException(
                    status_code=400,
                    detail="只支持 PDF / 图片 / Word / PPT（.pdf/.png/.jpg/.jpeg/.docx/.doc/.pptx/.ppt）",
                )
            content = b""
            size = 0
            while True:
                chunk = item.file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > config.MAX_FILE_SIZE:
                    raise HTTPException(
                        status_code=400,
                        detail=f"文件 {original} 超过大小限制（{config.MAX_FILE_MB}MB）",
                    )
                content += chunk
            if size == 0:
                raise HTTPException(status_code=400, detail=f"文件 {original} 内容为空")
            digest = hashlib.sha256(content).hexdigest()
            if digest in seen:
                continue    # 同一任务内内容重复的文件只保留一份
            seen.add(digest)
            stored_name = f"{digest[:16]}{suffix}"
            (tmp_dir / stored_name).write_bytes(content)
            if suffix in constants.OFFICE_EXT:
                # Word/PPT 先转 PDF（内容寻址缓存，提交页预览过的文件这里直接命中）。
                # 转换失败就整单 400：不然任务会一路通过审核，最后卡在代理那里打不出来。
                try:
                    convert.convert_to_pdf(tmp_dir / stored_name, convert.converted_path(digest))
                except convert.ConvertError as exc:
                    convert.drop_cached(digest)
                    raise HTTPException(status_code=400, detail=f"文件 {original} 转换失败：{exc}")
            saved.append({
                "filename": original,
                "stored_name": stored_name,
                "size": size,
                "sha256": digest,
                # 该文件自己的打印设置（没传 settings 时为空，代理回落到任务级默认）
                "print_options": (
                    json.dumps(file_settings[index], ensure_ascii=False)
                    if index < len(file_settings) and file_settings[index] else None
                ),
            })
        if not saved:
            raise HTTPException(status_code=400, detail="没有有效文件可提交")

        # 计费：管理员/root、anticraft 账号、白名单免费；其余按「张数 × 单价」扣余额。
        # 张数按「实际打印页数 ÷ 每张页数 × 份数」算（Office 用转换后的 PDF 页数）。
        billable_files = [
            {
                "path": str(
                    convert.converted_path(item["sha256"])
                    if Path(item["stored_name"]).suffix.lower() in constants.OFFICE_EXT
                    else tmp_dir / item["stored_name"]
                ),
                "is_pdf": Path(item["stored_name"]).suffix.lower() == ".pdf"
                or Path(item["stored_name"]).suffix.lower() in constants.OFFICE_EXT,
                "copies": (
                    (file_settings[index] or {}).get("copies")
                    if index < len(file_settings) and file_settings[index]
                    else None
                )
                or copies_value
                or 1,
                "options": (
                    file_settings[index]
                    if index < len(file_settings) and file_settings[index]
                    else options
                ),
            }
            for index, item in enumerate(saved)
        ]
        sheets, amount = billing.estimate(billable_files)
        # 注意：依赖注入给的是 JWT 里的用户（只有 id/username/role），
        # 免费判定还要看 source（anticraft），所以必须按 id 重新取一次库里的行
        billing_user = db.get_user_by_id(user["id"]) or user
        charge = Decimal("0.00") if billing.is_free(billing_user) else amount
        try:
            job = db.create_job(
                user["id"], address, note, saved, mode, copies_value,
                json.dumps(options, ensure_ascii=False),
                charge=charge,
            )
        except db.InsufficientBalance as exc:
            # 余额不足：不建单、不扣钱，交给前端弹「付款码（暂未实现）」
            raise HTTPException(
                status_code=402,
                detail={
                    "code": "insufficient_balance",
                    "message": f"余额不足：本单需 {exc.needed} 元（{sheets} 张 × {billing.price_text()}），当前余额 {exc.balance} 元",
                    "cost": str(exc.needed),
                    "balance": str(exc.balance),
                    "sheets": sheets,
                },
            )
        dest_dir = config.UPLOAD_DIR / str(job["id"])
        # 任务号来自自增主键，正常不会重名；但历史上出现过（把本机 uploads 传上服务器）
        # 残留同名目录，导致 rename 报 Errno 39 Directory not empty。残留目录不属于任何任务，清掉再落盘。
        if dest_dir.exists():
            logger.warning("uploads/%s 已存在（历史残留目录），清理后重新落盘", job["id"])
            shutil.rmtree(dest_dir, ignore_errors=True)
        try:
            os.rename(tmp_dir, dest_dir)
        except OSError as exc:
            db.delete_job(job["id"])    # 回滚：不留没有文件的任务
            logger.error("任务 #%s 文件落盘失败：%s", job["id"], exc)
            raise HTTPException(status_code=500, detail="文件保存失败，请重试")
        logger.info(
            "用户 %s 提交任务 #%s（%s 个文件，%s，份数 %s，任务级设置 %s，逐文件设置 %s 条，地址：%s）",
            user["username"], job["id"], len(saved), mode, copies_value, options, len(file_settings), address or "（取件）",
        )
        logger.info("任务 #%s 计费：%s 张，扣 %s 元（余额 %s）", job["id"], sheets, charge, db.get_balance(user["id"]))
        return {
            "job": _job_payload(db.get_job(job["id"])),
            "charge": str(charge),
            "balance": str(db.get_balance(user["id"])),
        }
    except HTTPException:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        logger.exception("提交任务失败：%s", exc)
        raise HTTPException(status_code=500, detail="提交失败，请稍后重试")


@app.get("/api/jobs/mine")
def my_jobs(user: dict = Depends(auth.get_current_user)):
    """我的任务（倒序，含文件列表）"""
    return {"jobs": [_job_payload(j) for j in db.list_jobs(user["id"])]}


@app.get("/api/jobs")
def all_jobs(user: dict = Depends(auth.require_admin)):
    """管理端任务队列 + 代理列表 + 代理在线状态"""
    agents = db.list_agents()
    return {"jobs": [_job_payload(j) for j in db.list_jobs()], "agents": agents, "agent_online": _agent_online(agents)}


@app.get("/api/jobs/{job_id}")
def job_detail(job_id: int, user: dict = Depends(auth.get_current_user)):
    return {"job": _job_payload(_load_job_for(job_id, user))}


@app.get("/api/jobs/{job_id}/files/{file_id}")
def job_file(job_id: int, file_id: int, download: int = 0, user: dict = Depends(auth.get_current_user)):
    """预览/下载（本人或管理员）：默认 inline（Office 给转换后的 PDF），?download=1 强制 attachment 给原文件"""
    job = _load_job_for(job_id, user)
    row = _find_file(job, file_id)
    if not row:
        raise HTTPException(status_code=404, detail="文件不存在")
    return _file_response(job_id, row, download=bool(download))


@app.post("/api/preview/office")
async def preview_office(file: UploadFile = File(...), user: dict = Depends(auth.get_current_user)):
    """提交页预览：把还没提交的 Word/PPT 转成 PDF 返回（内容寻址缓存，提交时命中同一份，不再转第二次）

    校验口径与正式上传一致（自己的登录即可用，不落库、不建任务）。
    """
    original = Path(file.filename or "").name.strip()[:255] or "未命名"
    suffix = Path(original).suffix.lower()
    if suffix in constants.DANGEROUS_EXT:
        raise HTTPException(status_code=400, detail=f"文件 {original} 类型不允许上传（{suffix}）")
    if suffix not in constants.OFFICE_EXT:
        raise HTTPException(status_code=400, detail="该接口只转换 Word / PPT（.docx/.doc/.pptx/.ppt）")
    content = await file.read(config.MAX_FILE_SIZE + 1)     # 多读 1 字节用于判超限
    if len(content) > config.MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail=f"文件 {original} 超过大小限制（{config.MAX_FILE_MB}MB）")
    if not content:
        raise HTTPException(status_code=400, detail=f"文件 {original} 内容为空")
    try:
        pdf_path, _ = convert.convert_bytes(content, original)
    except convert.ConvertError as exc:
        raise HTTPException(status_code=400, detail=f"文件 {original} 转换失败：{exc}")
    logger.info("用户 %s 预览转换：%s → %s", user["username"], original, pdf_path.name)
    headers = {
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": _content_disposition("inline", f"{Path(original).stem}.pdf"),
    }
    return FileResponse(str(pdf_path), media_type="application/pdf", headers=headers)


# ── 任务：审核与流转（每次流转都写 print_jobs_logs）──

@app.post("/api/jobs/{job_id}/approve")
def approve(job_id: int, user: dict = Depends(auth.require_admin)):
    """通过审核：待审核 / 打印失败 → 已通过"""
    job = _load_job_for(job_id, user)
    if job["status"] not in (constants.S_PENDING, constants.S_FAILED):
        raise HTTPException(status_code=400, detail=f"当前状态「{job['status']}」不能通过审核")
    ok = db.set_status(
        job_id, constants.S_APPROVED, user["username"],
        remark="管理员通过审核", from_status=job["status"], print_error=None,
    )
    if not ok:
        raise HTTPException(status_code=409, detail="任务状态已变化，请刷新后重试")
    return {"job": _job_payload(db.get_job(job_id))}


@app.post("/api/jobs/{job_id}/reject")
def reject(job_id: int, body: RejectBody, user: dict = Depends(auth.require_admin)):
    """驳回：仅待审核可驳回，理由必填"""
    reason = (body.reason or "").strip()
    if not reason:
        raise HTTPException(status_code=400, detail="请填写驳回理由")
    job = _load_job_for(job_id, user)
    if job["status"] != constants.S_PENDING:
        raise HTTPException(status_code=400, detail=f"当前状态「{job['status']}」不能驳回")
    ok = db.set_status(
        job_id, constants.S_REJECTED, user["username"],
        remark=reason, from_status=job["status"], reject_reason=reason[:500],
    )
    if not ok:
        raise HTTPException(status_code=409, detail="任务状态已变化，请刷新后重试")
    refunded = db.refund_job(job_id, "驳回退费", user["username"])
    if refunded:
        logger.info("任务 #%s 驳回，退回 %s 元", job_id, refunded)
    return {"job": _job_payload(db.get_job(job_id)), "refunded": str(refunded)}


@app.post("/api/jobs/{job_id}/resubmit")
def resubmit(job_id: int, user: dict = Depends(auth.get_current_user)):
    """重新提交：仅本人、且仅已驳回 → 待审核（清空驳回理由）"""
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    if job["user_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="只有提交人本人可以重新提交")
    if job["status"] != constants.S_REJECTED:
        raise HTTPException(status_code=400, detail=f"当前状态「{job['status']}」不能重新提交")
    ok = db.set_status(
        job_id, constants.S_PENDING, user["username"],
        remark="驳回后重新提交", from_status=job["status"], reject_reason=None,
    )
    if not ok:
        raise HTTPException(status_code=409, detail="任务状态已变化，请刷新后重试")
    return {"job": _job_payload(db.get_job(job_id))}


@app.post("/api/jobs/{job_id}/retry")
def retry(job_id: int, user: dict = Depends(auth.require_admin)):
    """重试：打印失败 → 已通过（清空错误信息，重新入队等代理领取）"""
    job = _load_job_for(job_id, user)
    if job["status"] != constants.S_FAILED:
        raise HTTPException(status_code=400, detail=f"当前状态「{job['status']}」不能重试")
    ok = db.set_status(
        job_id, constants.S_APPROVED, user["username"],
        remark="管理员重试打印", from_status=job["status"], print_error=None,
    )
    if not ok:
        raise HTTPException(status_code=409, detail="任务状态已变化，请刷新后重试")
    return {"job": _job_payload(db.get_job(job_id))}


@app.post("/api/jobs/{job_id}/withdraw")
def withdraw(job_id: int, user: dict = Depends(auth.get_current_user)):
    """提交人撤回自己的任务：仅「待审核 / 已通过」（还没出纸）可撤回，撤回到「已撤回」。"""
    job = _load_job_for(job_id, user)
    if user["role"] not in ("admin", "root") and job["user_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="只能撤回自己的任务")
    if job["status"] not in constants.USER_WITHDRAWABLE:
        raise HTTPException(status_code=400, detail=f"当前状态「{job['status']}」不能撤回（已开始打印或已结束）")
    ok = db.set_status(
        job_id, constants.S_WITHDRAWN, user["username"],
        remark="提交人撤回任务", from_status=job["status"],
    )
    if not ok:
        raise HTTPException(status_code=409, detail="任务状态已变化（可能已被打印代理领取），请刷新后重试")
    refunded = db.refund_job(job_id, "撤回退费", user["username"])
    if refunded:
        logger.info("任务 #%s 撤回，退回 %s 元", job_id, refunded)
    logger.info("用户 %s 撤回任务 #%s", user["username"], job_id)
    return {
        "job": _job_payload(db.get_job(job_id)),
        "refunded": str(refunded),
        "balance": str(db.get_balance(user["id"])),
    }


@app.post("/api/jobs/{job_id}/reprint")
def reprint(job_id: int, user: dict = Depends(auth.require_admin)):
    """管理员「重新打印」：把已出纸/已结束的任务重新入队（回到「已通过」），清掉上次的打印痕迹。"""
    job = _load_job_for(job_id, user)
    if job["status"] not in constants.ADMIN_REPRINTABLE:
        raise HTTPException(status_code=400, detail=f"当前状态「{job['status']}」不能重新打印")
    ok = db.set_status(
        job_id, constants.S_APPROVED, user["username"],
        remark="管理员重新打印", from_status=job["status"],
        print_error=None, printed_at=None, finished_at=None, agent_id=None,
    )
    if not ok:
        raise HTTPException(status_code=409, detail="任务状态已变化，请刷新后重试")
    logger.info("管理员 %s 重新打印任务 #%s", user["username"], job_id)
    return {"job": _job_payload(db.get_job(job_id))}


@app.post("/api/jobs/{job_id}/advance")
def advance(job_id: int, body: AdvanceBody, user: dict = Depends(auth.require_admin)):
    """打印完成后的交接流转（管理员在任务队列里勾选）：

    已打印 → 待配送（仅配送单）/ 待取件（仅取件单）→ 已完成。
    目标状态与当前状态由 constants.HANDOVER_NEXT 约束，配送单不能进「待取件」，反之亦然。
    """
    target = (body.to or "").strip()
    job = _load_job_for(job_id, user)
    allowed = constants.HANDOVER_NEXT.get(job["status"]) or {}
    if target not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"当前状态「{job['status']}」不能流转到「{target or '(空)'}」",
        )
    required_mode = allowed[target]
    if required_mode and job.get("delivery_mode") != required_mode:
        raise HTTPException(
            status_code=400,
            detail=f"该任务是「{job.get('delivery_mode')}」单，不能标记为「{target}」",
        )
    extra = {"finished_at": datetime.now()} if target == constants.S_DONE else None
    ok = db.set_status(
        job_id, target, user["username"],
        remark=f"管理员标记为{target}", from_status=job["status"], **(extra or {}),
    )
    if not ok:
        raise HTTPException(status_code=409, detail="任务状态已变化，请刷新后重试")
    logger.info("管理员 %s 将任务 #%s 标记为「%s」", user["username"], job_id, target)
    return {"job": _job_payload(db.get_job(job_id))}


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: int, user: dict = Depends(auth.require_admin)):
    """删除任务及其上传文件目录（管理员）；Office 转换缓存没别的任务引用时一起清掉"""
    job = _load_job_for(job_id, user)
    # 没出过纸就退钱（已驳回/已撤回的 charge 早已清零，refund_job 是无操作）
    refunded = Decimal("0")
    if job["status"] in (
        constants.S_PENDING, constants.S_APPROVED, constants.S_REJECTED, constants.S_WITHDRAWN,
    ):
        refunded = db.refund_job(job_id, "删除退费", user["username"])
    db.delete_job(job_id)
    shutil.rmtree(config.UPLOAD_DIR / str(job_id), ignore_errors=True)
    for item in job.get("files", []):
        digest = item.get("sha256")
        if digest and not db.sha256_in_use(digest):
            convert.drop_cached(digest)
    logger.info("管理员 %s 删除任务 #%s（退费 %s 元）", user["username"], job_id, refunded)
    return {"ok": True, "refunded": str(refunded)}


# ── 设置（admin）──

@app.get("/api/settings")
def get_settings(user: dict = Depends(auth.require_admin)):
    """设置 + 代理状态；敏感项（anticraft_client_secret）只回掩码，不回明文"""
    agents = db.list_agents()
    return {"settings": _masked_settings(), "agents": agents, "agent_online": _agent_online(agents)}


@app.post("/api/settings")
def update_settings(body: SettingsBody, user: dict = Depends(auth.require_admin)):
    """更新启动器 / 打印机 / 份数 / 干跑开关（只记改了哪些键，不记值）"""
    updates = {}
    if body.launcher is not None:
        updates["launcher"] = str(body.launcher).strip()[:64]
    if body.printer_name is not None:
        updates["printer_name"] = str(body.printer_name).strip()[:255]
    if body.copies is not None:
        raw = str(body.copies).strip()
        if not raw.isdigit() or not 1 <= int(raw) <= 99:
            raise HTTPException(status_code=400, detail="份数需为 1~99 的整数")
        updates["copies"] = str(int(raw))
    if body.dry_run is not None:
        updates["dry_run"] = "1" if str(body.dry_run).strip().lower() in ("1", "true", "yes", "on") else "0"
    if body.cover_page is not None:
        updates["cover_page"] = "1" if str(body.cover_page).strip().lower() in ("1", "true", "yes", "on") else "0"
    if body.print_price is not None:
        try:
            updates["print_price"] = str(billing.parse_price(body.print_price))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    if body.free_users is not None:
        raw = str(body.free_users).replace("，", ",").replace("；", ",").replace(";", ",").replace(" ", "").strip(",")
        if len(raw) > 500:
            raise HTTPException(status_code=400, detail="白名单过长（最多 500 字）")
        updates["free_users"] = raw
    if body.anticraft_base is not None:
        value = str(body.anticraft_base).strip().rstrip("/")
        if value and not value.startswith(("http://", "https://")):
            raise HTTPException(status_code=400, detail="anticraft 服务地址需以 http:// 或 https:// 开头")
        updates["anticraft_base"] = value[:255]
    if body.anticraft_client_id is not None:
        updates["anticraft_client_id"] = str(body.anticraft_client_id).strip()[:128]
    if body.anticraft_client_secret is not None:
        # 前端回显的是掩码，原样提交时视为「不修改」，避免把掩码写进库
        secret = str(body.anticraft_client_secret).strip()
        if secret and secret != SECRET_MASK:
            updates["anticraft_client_secret"] = secret[:255]
    if body.anticraft_origins is not None:
        origins = ",".join(part.strip().rstrip("/") for part in str(body.anticraft_origins).split(",") if part.strip())
        updates["anticraft_origins"] = origins[:512]
    if body.anticraft_admin_users is not None:
        names = ",".join(part.strip() for part in str(body.anticraft_admin_users).split(",") if part.strip())
        updates["anticraft_admin_users"] = names[:512]
    if updates:
        db.set_settings(updates)
    logger.info("管理员 %s 更新设置：%s", user["username"], "、".join(sorted(updates)) or "无变更")
    return {"settings": _masked_settings()}


@app.post("/api/settings/rotate-agent-token")
def rotate_agent_token(user: dict = Depends(auth.require_admin)):
    """轮换代理令牌（旧令牌立即失效，代理需更新配置后重启）"""
    token = secrets.token_hex(16)
    db.set_settings({"agent_token": token})
    logger.info("管理员 %s 轮换了打印代理令牌", user["username"])   # 不打印令牌本身
    return {"agent_token": token}


class AgentLinkBody(BaseModel):
    """代理连接开关：true = 连接（默认），false = 断开"""
    connected: bool


@app.post("/api/settings/agent-link")
def set_agent_link(body: AgentLinkBody, user: dict = Depends(auth.require_admin)):
    """断开 / 重新连接打印代理。

    断开后代理的注册、心跳、领取、下载、回报一律 403（代理会记一条日志并继续轮询，
    重连后自动续上）；期间已通过的任务只是排队等待，不会被领取。
    """
    db.set_settings({"agent_enabled": "1" if body.connected else "0"})
    logger.info("管理员 %s %s了打印代理连接", user["username"], "恢复" if body.connected else "断开")
    agents = db.list_agents()
    return {"settings": _masked_settings(), "agents": agents, "agent_online": _agent_online(agents)}


# ── 静态托管：生产由 FastAPI 单进程托管前端 dist ──

@app.exception_handler(404)
async def not_found(request: Request, exc):
    """未匹配的非 /api 路径回退 index.html（SPA 路由用）"""
    index_file = config.DIST_DIR / "index.html"
    if request.method in ("GET", "HEAD") and not request.url.path.startswith("/api") and index_file.exists():
        return FileResponse(index_file)
    detail = getattr(exc, "detail", None) or "请求的资源不存在"
    return JSONResponse({"detail": detail}, status_code=404)


if config.DIST_DIR.exists():
    app.mount("/", StaticFiles(directory=str(config.DIST_DIR), html=True), name="frontend")
else:
    @app.get("/")
    def index():
        return JSONResponse({
            "ok": False,
            "detail": "前端尚未构建（frontend/dist 不存在），请先构建前端；后端可用性见 /api/health",
        })


if __name__ == "__main__":
    uvicorn.run(app, host=config.HOST, port=config.PORT, reload=False)
