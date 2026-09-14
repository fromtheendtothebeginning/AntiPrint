# auth.py — 密码哈希与 JWT 令牌 / 登录鉴权依赖
# 复用 D:\anticraft\index 的模式：SHA-256 预哈希 → bcrypt（绕过 72 字节限制，直接 import bcrypt，不用 passlib）
# 与 pyjwt HS256 24h（不用 python-jose，避免 C 扩展编译）。

import hashlib
import hmac
import os
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


def get_current_user(authorization: str = Header(default="")) -> dict:
    """FastAPI 依赖：从 Authorization: Bearer <token> 解析当前用户；失败一律 401"""
    token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    payload = decode_token(token) if token else None
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


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    """管理员依赖：非 admin 返回 403"""
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user
