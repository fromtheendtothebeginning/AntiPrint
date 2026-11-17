# sms.py — 短信验证码（阿里云短信）与频控
#
# 配置读 backend/sms_config.json（已 gitignore），环境变量可覆盖：
#   SMS_ENABLED / SMS_MOCK / SMS_ACCESS_KEY_ID / SMS_ACCESS_KEY_SECRET
#   SMS_SIGN_NAME / SMS_TEMPLATE_CODE / SMS_REGION
#
# 未配置或 mock 模式时不真的发短信，只在日志里打印验证码（本地联调用）。

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

import config

LOG = logging.getLogger("antiprint.sms")

CONFIG_FILE = config.BASE_DIR / "sms_config.json"
CODE_TTL_SECONDS = 10 * 60          # 验证码 10 分钟有效
RESEND_SECONDS = 60                 # 同一手机号 60 秒内只能发一次
DAILY_PER_PHONE = 10                # 每个手机号每天最多 10 条
DAILY_PER_IP = 50                   # 每个 IP 每天最多 50 条
MAX_ATTEMPTS = 5                    # 同一条验证码最多试 5 次

PHONE_RE = re.compile(r"^1[3-9]\d{9}$")
_PHONE_FIX = re.compile(r"[\s\-()]")


def _truthy(value) -> bool:
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def normalize_phone(raw) -> str | None:
    """把输入规范成 11 位大陆手机号；不合法返回 None。"""
    text = _PHONE_FIX.sub("", str(raw or ""))
    if text.startswith("+86"):
        text = text[3:]
    elif text.startswith("86") and len(text) == 13:
        text = text[2:]
    return text if PHONE_RE.match(text) else None


def load_config() -> dict:
    raw = {}
    if CONFIG_FILE.exists():
        try:
            raw = json.loads(CONFIG_FILE.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as exc:
            LOG.warning("sms_config.json 读取失败：%s", exc)
            raw = {}
    if not isinstance(raw, dict):
        raw = {}
    cfg = {
        "enabled": _truthy(os.environ.get("SMS_ENABLED", raw.get("enabled", False))),
        "mock": _truthy(os.environ.get("SMS_MOCK", raw.get("mock", True))),
        "access_key_id": str(os.environ.get("SMS_ACCESS_KEY_ID") or raw.get("access_key_id") or "").strip(),
        "access_key_secret": str(os.environ.get("SMS_ACCESS_KEY_SECRET") or raw.get("access_key_secret") or "").strip(),
        "sign_name": str(os.environ.get("SMS_SIGN_NAME") or raw.get("sign_name") or "").strip(),
        "template_code": str(os.environ.get("SMS_TEMPLATE_CODE") or raw.get("template_code") or "").strip(),
        "region": str(os.environ.get("SMS_REGION") or raw.get("region") or "cn-hangzhou").strip(),
    }
    return cfg


def is_ready() -> bool:
    """是否真的能发短信（关闭 mock 且四项凭据齐全）。"""
    cfg = load_config()
    if cfg["mock"]:
        return True
    return bool(
        cfg["enabled"] and cfg["access_key_id"] and cfg["access_key_secret"]
        and cfg["sign_name"] and cfg["template_code"]
    )


def _aliyun_send(cfg: dict, phone: str, code: str):
    """阿里云 Dysmsapi SendSms（RPC 签名，GET，标准库实现，不引 SDK）。"""
    params = {
        "AccessKeyId": cfg["access_key_id"],
        "Action": "SendSms",
        "Format": "JSON",
        "PhoneNumbers": phone,
        "RegionId": cfg["region"] or "cn-hangzhou",
        "SignName": cfg["sign_name"],
        "SignatureMethod": "HMAC-SHA1",
        "SignatureNonce": uuid.uuid4().hex,
        "SignatureVersion": "1.0",
        "TemplateCode": cfg["template_code"],
        "TemplateParam": json.dumps({"code": code}, separators=(",", ":")),
        "Timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "Version": "2017-05-25",
    }

    def enc(value) -> str:
        return urllib.parse.quote(str(value), safe="~")

    canonical = "&".join(f"{enc(key)}={enc(params[key])}" for key in sorted(params))
    string_to_sign = "GET&%2F&" + enc(canonical)
    signature = base64.b64encode(
        hmac.new((cfg["access_key_secret"] + "&").encode(), string_to_sign.encode(), hashlib.sha1).digest()
    ).decode()
    url = f"https://dysmsapi.aliyuncs.com/?Signature={enc(signature)}&{canonical}"

    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            body = response.read().decode("utf-8", "replace")
    except urllib.error.URLError as exc:
        raise RuntimeError(f"短信网关不可达：{exc}")
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        raise RuntimeError("短信网关返回了无法解析的内容")
    if data.get("Code") != "OK":
        raise RuntimeError(f"短信发送失败：{data.get('Message') or data.get('Code')}")


def send_code(phone: str, code: str) -> dict:
    """真的发验证码；mock 模式返回 mock=True 并写日志。"""
    cfg = load_config()
    if cfg["mock"]:
        LOG.info("[SMS MOCK] 手机号 %s 的验证码：%s", phone, code)
        return {"mock": True}
    if not is_ready():
        raise RuntimeError("短信服务尚未配置（需要 AccessKey、签名与模板）")
    _aliyun_send(cfg, phone, code)
    return {"mock": False}


# ── 验证码与频控（单进程内存；重启后已发出的码失效）──

_LOCK = threading.Lock()
_CODES: dict[str, dict] = {}
_SENT_AT: dict[str, float] = {}
_PHONE_DAILY: dict[tuple[str, str], int] = {}
_IP_DAILY: dict[tuple[str, str], int] = {}


def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def issue_code(phone: str, ip: str = "") -> bool:
    """生成并发送验证码；返回是否 mock 模式。频控不通过抛 RuntimeError（中文原因）。"""
    now = time.time()
    today = _today()
    with _LOCK:
        last = _SENT_AT.get(phone, 0)
        if now - last < RESEND_SECONDS:
            raise RuntimeError(f"发送太频繁，请 {int(RESEND_SECONDS - (now - last)) + 1} 秒后再试")
        phone_key = (phone, today)
        if _PHONE_DAILY.get(phone_key, 0) >= DAILY_PER_PHONE:
            raise RuntimeError("该手机号今天获取验证码次数已达上限")
        if ip:
            ip_key = (ip, today)
            if _IP_DAILY.get(ip_key, 0) >= DAILY_PER_IP:
                raise RuntimeError("当前网络获取验证码次数已达上限")

    code = f"{secrets.randbelow(1000000):06d}"
    result = send_code(phone, code)     # 网络调用放在锁外

    with _LOCK:
        _CODES[phone] = {"code": code, "expires": now + CODE_TTL_SECONDS, "attempts": 0}
        _SENT_AT[phone] = now
        _PHONE_DAILY[(phone, today)] = _PHONE_DAILY.get((phone, today), 0) + 1
        if ip:
            _IP_DAILY[(ip, today)] = _IP_DAILY.get((ip, today), 0) + 1
        # 顺手清理过期的日计数，避免无限增长
        if len(_PHONE_DAILY) > 5000:
            for key in [k for k in _PHONE_DAILY if k[1] != today]:
                _PHONE_DAILY.pop(key, None)
            for key in [k for k in _IP_DAILY if k[1] != today]:
                _IP_DAILY.pop(key, None)
    return bool(result.get("mock"))


def verify_code(phone: str, code: str) -> bool:
    """校验验证码；成功后立即作废。"""
    with _LOCK:
        entry = _CODES.get(phone)
        if not entry:
            return False
        if time.time() > entry["expires"]:
            _CODES.pop(phone, None)
            return False
        entry["attempts"] += 1
        if entry["attempts"] > MAX_ATTEMPTS:
            _CODES.pop(phone, None)
            return False
        if not hmac.compare_digest(str(entry["code"]), str(code or "").strip()):
            return False
        _CODES.pop(phone, None)
        return True


def mock_hint() -> bool:
    """当前是否 mock 模式（接口回给前端，用于提示「验证码看服务器日志」）。"""
    return load_config()["mock"]
