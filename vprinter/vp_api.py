# vp_api.py — AntiPrint 网站客户端：登录（本站 / anticraft）+ 提交打印任务
#
# 只依赖 requests（与打印代理一致）。令牌缓存进配置文件：网站登录接口有
# 10 次/分钟/IP 的限速，每次打印都登录会把限速打满；JWT 本身 24 小时有效。

from __future__ import annotations

import base64
import json
import time
from pathlib import Path

import requests

from vp_config import LOG, load_config, save_config

LOGIN_TIMEOUT = 15      # 登录/查询类请求超时（秒）
UPLOAD_TIMEOUT = 120    # 上传任务（含服务端转 PDF）超时（秒）
REFRESH_MARGIN = 600    # 令牌剩余有效期不足 10 分钟就提前续期


class ApiError(Exception):
    """接口报错：status=HTTP 状态码（网络异常时为 0），detail=服务端 detail 或错误说明"""

    def __init__(self, status: int, detail, message: str = ""):
        super().__init__(message or str(detail))
        self.status = status
        self.detail = detail
        self.message = message or _detail_text(detail)

    @property
    def code(self) -> str:
        """402 余额不足时服务端给的是对象，里面带 code"""
        if isinstance(self.detail, dict):
            return str(self.detail.get("code") or "")
        return ""

    @property
    def is_retryable(self) -> bool:
        """网络抖动 / 服务端 5xx 可以重试；4xx 重试没意义（除非是令牌过期，由调用方处理）"""
        return self.status == 0 or self.status >= 500


def _detail_text(detail) -> str:
    if isinstance(detail, dict):
        return str(detail.get("message") or detail)
    return str(detail or "")


def _jwt_exp(token: str) -> float:
    """解出 JWT 的 exp（只做 base64 解码，不校验签名）；解析不了返回 0"""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload).decode("utf-8"))
        return float(data.get("exp") or 0)
    except (IndexError, ValueError, TypeError):
        return 0.0


class Client:
    """一个网站账号的客户端；令牌缓存在配置文件里，跨进程复用"""

    def __init__(self, cfg: dict | None = None):
        self.cfg = cfg or load_config()
        self.session = requests.Session()
        self._profile: dict = {}      # 个人配置缓存（默认配送方式/地址），一次登录只取一遍

    # -------------------------------------------------- 基础请求

    @property
    def server(self) -> str:
        return str(self.cfg.get("server") or "").rstrip("/")

    def _request(self, method: str, path: str, token: str = "", timeout: int = LOGIN_TIMEOUT, **kwargs):
        url = f"{self.server}{path}"
        headers = kwargs.pop("headers", {}) or {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            resp = self.session.request(method, url, headers=headers, timeout=timeout, **kwargs)
        except requests.RequestException as exc:
            raise ApiError(0, str(exc), f"连不上服务器 {self.server}：{exc}") from exc
        if resp.status_code >= 400:
            try:
                detail = resp.json().get("detail")
            except ValueError:
                detail = resp.text[:200]
            raise ApiError(resp.status_code, detail)
        try:
            return resp.json()
        except ValueError:
            raise ApiError(resp.status_code, "返回内容不是 JSON", "服务器返回了非 JSON 内容")

    # -------------------------------------------------- 登录 / 令牌

    def health(self) -> dict:
        return self._request("GET", "/api/health")

    def login(self) -> str:
        """用账号密码换令牌；auth_mode=anticraft 时走 anticraft 账号校验接口"""
        username = str(self.cfg.get("username") or "").strip()
        password = str(self.cfg.get("password") or "")
        if not username or not password:
            raise ApiError(0, "未配置账号", "请先在配置界面填写用户名和密码")
        path = "/api/login/anticraft" if self.cfg.get("auth_mode") == "anticraft" else "/api/login"
        data = self._request("POST", path, json={"username": username, "password": password}, timeout=LOGIN_TIMEOUT)
        token = str(data.get("token") or "")
        if not token:
            raise ApiError(0, "登录未返回令牌", "登录失败：服务器没有返回令牌")
        self.cfg["token"] = token
        self.cfg["token_at"] = time.time()
        self.cfg["token_user"] = str((data.get("user") or {}).get("username") or username)
        self._profile = {}
        save_config(self.cfg)
        LOG.info("登录成功：%s（%s）", self.cfg["token_user"], path)
        return token

    def token(self, force: bool = False) -> str:
        """拿一个可用令牌：缓存有效就用缓存，不然重新登录"""
        cached = str(self.cfg.get("token") or "")
        if cached and not force:
            exp = _jwt_exp(cached)
            if not exp or exp - time.time() > REFRESH_MARGIN:
                return cached
        return self.login()

    # -------------------------------------------------- 业务接口

    def me(self, token: str) -> dict:
        return self._request("GET", "/api/me", token=token)

    def balance(self, token: str) -> dict:
        return self._request("GET", "/api/balance", token=token)

    def profile(self, token: str) -> dict:
        return self._request("GET", "/api/profile", token=token)

    def profile_cached(self, token: str) -> dict:
        """个人配置（默认配送方式 / 默认地址）：一次登录只取一遍，省掉每次打印一次请求"""
        if not self._profile:
            self._profile = self.profile(token).get("profile") or {}
        return self._profile

    def submit_job(
        self,
        pdf: Path,
        token: str,
        *,
        filename: str,
        delivery_mode: str = "",
        address: str = "",
        note: str = "",
        copies: int = 1,
    ) -> dict:
        """把一份 PDF 提交成网站上的打印任务（走和网页提交页同一个接口）"""
        data = {"copies": str(max(1, min(99, int(copies or 1))))}
        if delivery_mode in ("配送", "取件"):
            data["delivery_mode"] = delivery_mode
        if address.strip():
            data["address"] = address.strip()
        if note.strip():
            data["note"] = note.strip()
        with pdf.open("rb") as handle:
            files = {"files": (filename, handle, "application/pdf")}
            return self._request(
                "POST", "/api/jobs", token=token, timeout=UPLOAD_TIMEOUT, data=data, files=files
            )
