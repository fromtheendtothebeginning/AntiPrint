# auth.py — 密码哈希与 JWT 令牌 / 登录鉴权依赖
# 复用 D:\anticraft\index 的模式：SHA-256 预哈希 → bcrypt（绕过 72 字节限制，直接 import bcrypt，不用 passlib）
# 与 pyjwt HS256 24h（不用 python-jose，避免 C 扩展编译）。

import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, Header, HTTPException
from jwt import PyJWTError

# 生产环境必须通过环境变量 SECRET_KEY 注入随机密钥；缺省值只够本机开发用，
# 一旦上服务器仍用缺省值，任何人都能伪造 JWT。
SECRET_KEY = os.environ.get("SECRET_KEY", "antiprint-dev-secret")
ALGORITHM = "HS256"
TOKEN_TTL_HOURS = 24


def _prehash(password: str) -> bytes:
    """SHA-256 → bytes，绕过 bcrypt 72 字节上限"""
    return hashlib.sha256((password or "").encode("utf-8")).hexdigest().encode()


def hash_password(password: str) -> str:
    """明文 → SHA-256 预哈希 → bcrypt 哈希"""
    return bcrypt.hashpw(_prehash(password), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    """校验密码：用同一 salt 重算哈希后 hmac.compare_digest 常量时间比较；非法哈希返回 False"""
    try:
        candidate = bcrypt.hashpw(_prehash(password), (hashed or "").encode()).decode()
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(candidate, hashed)


def create_token(user: dict) -> str:
    """签发 24 小时有效 JWT，payload：sub（用户 id 字符串）/ username / role / exp"""
    expire = datetime.now(timezone.utc) + timedelta(hours=TOKEN_TTL_HOURS)
    payload = {
        "sub": str(user["id"]),
        "username": user["username"],
        "role": user["role"],
        "exp": expire,
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str):
    """解码 JWT；签名错误/过期/格式非法统一返回 None"""
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except PyJWTError:
        return None


# ── 长期 API 令牌（MCP / 脚本）：ap_ 前缀 + 32 字节随机串，库里只存 sha256 ──

API_TOKEN_PREFIX = "ap_"


def hash_api_token(plain: str) -> str:
    return hashlib.sha256((plain or "").encode("utf-8")).hexdigest()


def generate_api_token() -> tuple[str, str, str]:
    """生成令牌：返回 (明文, sha256, 展示前缀)。明文只在生成时返回一次。"""
    plain = API_TOKEN_PREFIX + secrets.token_urlsafe(32)
    return plain, hash_api_token(plain), plain[:12]


def _user_from_api_token(token: str) -> dict | None:
    """按令牌查用户（角色取库里最新值）；无效/已撤销返回 None。

    db 模块级 import 了 auth，这里必须延迟导入，避免循环依赖。
    """
    import db

    row = db.get_user_by_api_token(hash_api_token(token))
    if not row:
        return None
    try:
        db.touch_api_token(row["token_id"])
    except Exception:       # 记录使用时间失败不影响鉴权
        pass
    return {"id": row["id"], "username": row["username"], "role": row.get("role") or "user"}


def get_current_user(authorization: str = Header(default="")) -> dict:
    """FastAPI 依赖：Bearer 支持两种凭证，失败一律 401。

    - ap_ 开头：长期 API 令牌（MCP / 脚本），查 api_tokens 表；
    - 其他：24 小时 JWT（网页登录）。
    """
    token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    if not token:
        raise HTTPException(status_code=401, detail="未登录或登录已过期")
    if token.startswith(API_TOKEN_PREFIX):
        user = _user_from_api_token(token)
        if not user:
            raise HTTPException(status_code=401, detail="API 令牌无效或已撤销")
        return user
    payload = decode_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="未登录或登录已过期")
    try:
        user_id = int(payload.get("sub"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=401, detail="无效的登录凭证")
    return {
        "id": user_id,
        "username": payload.get("username", ""),
        "role": payload.get("role", "user"),
    }


def user_from_token(token: str) -> dict | None:
    """把一个凭证字符串解析成用户（ap_ 长期令牌或 JWT）；无效返回 None。

    WebSocket 等不走 Header 依赖的场景用它自己做鉴权。
    """
    if not token:
        return None
    if token.startswith(API_TOKEN_PREFIX):
        return _user_from_api_token(token)
    payload = decode_token(token)
    if not payload:
        return None
    try:
        user_id = int(payload.get("sub"))
    except (TypeError, ValueError):
        return None
    return {
        "id": user_id,
        "username": payload.get("username", ""),
        "role": payload.get("role", "user"),
    }


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    """管理员依赖：admin 或 root 均可（root 是超集）"""
    if user.get("role") not in ("admin", "root"):
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user


def require_root(user: dict = Depends(get_current_user)) -> dict:
    """超级管理员依赖：只有 role=root 能过（用户管理、角色变更等敏感操作）"""
    if user.get("role") != "root":
        raise HTTPException(status_code=403, detail="需要超级管理员权限")
    return user
