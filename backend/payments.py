# payments.py — 支付宝充值（电脑网站支付）+ 本地 mock
#
# 配置读 backend/payment_config.json（已 gitignore），环境变量可覆盖：
#   ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY / ALIPAY_PUBLIC_KEY
#   ALIPAY_GATEWAY / ALIPAY_NOTIFY_URL / ALIPAY_RETURN_URL
#   PAYMENT_ENABLED / PAYMENT_MOCK
#
# 说明：
#   1. 真实支付使用支付宝官方「电脑网站支付」（alipay.trade.page.pay），
#      用户在支付宝收银台扫码；支付结果以异步 notify 或主动查单为准。
#   2. 没有配置商户凭据时可用 mock 模式（PAYMENT_MOCK=1）在本地跑通充值流程。
#   3. 个人无营业执照的官方限额约单笔 50 元、单日 1000 元，因此充值档位限制 1~50 元。

import base64
import json
import logging
import os
from decimal import Decimal, InvalidOperation
from pathlib import Path

import config

LOG = logging.getLogger("antiprint.payments")

CONFIG_FILE = config.BASE_DIR / "payment_config.json"
DEFAULT_GATEWAY = "https://openapi.alipay.com/gateway.do"
DEFAULT_NOTIFY_URL = "https://print.anticraft.top/api/pay/notify/alipay"
DEFAULT_RETURN_URL = "https://print.anticraft.top/balance"

MIN_AMOUNT = Decimal("1.00")
MAX_AMOUNT = Decimal("50.00")
RECHARGE_AMOUNTS = [10, 20, 30, 50]

TRADE_SUCCESS = ("TRADE_SUCCESS", "TRADE_FINISHED")


def _truthy(value) -> bool:
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def load_config() -> dict:
    """读支付配置；文件缺失时返回禁用状态。环境变量优先级更高。"""
    raw = {}
    if CONFIG_FILE.exists():
        try:
            raw = json.loads(CONFIG_FILE.read_text(encoding="utf-8-sig"))
        except (json.JSONDecodeError, OSError) as exc:
            LOG.warning("payment_config.json 读取失败：%s", exc)
            raw = {}
    if not isinstance(raw, dict):
        raw = {}

    cfg = {
        "enabled": _truthy(raw.get("enabled", False)),
        "mock": _truthy(raw.get("mock", False)),
        "app_id": str(raw.get("app_id") or "").strip(),
        "private_key": str(raw.get("private_key") or "").strip(),
        "private_key_path": str(raw.get("private_key_path") or "").strip(),
        "alipay_public_key": str(raw.get("alipay_public_key") or "").strip(),
        "public_key_path": str(raw.get("public_key_path") or "").strip(),
        "gateway": str(raw.get("gateway") or DEFAULT_GATEWAY).strip(),
        "notify_url": str(raw.get("notify_url") or DEFAULT_NOTIFY_URL).strip(),
        "return_url": str(raw.get("return_url") or DEFAULT_RETURN_URL).strip(),
    }
    if os.environ.get("PAYMENT_ENABLED") is not None:
        cfg["enabled"] = _truthy(os.environ["PAYMENT_ENABLED"])
    if os.environ.get("PAYMENT_MOCK") is not None:
        cfg["mock"] = _truthy(os.environ["PAYMENT_MOCK"])
    for key, env in (
        ("app_id", "ALIPAY_APP_ID"),
        ("private_key", "ALIPAY_PRIVATE_KEY"),
        ("private_key_path", "ALIPAY_PRIVATE_KEY_PATH"),
        ("alipay_public_key", "ALIPAY_PUBLIC_KEY"),
        ("public_key_path", "ALIPAY_PUBLIC_KEY_PATH"),
        ("gateway", "ALIPAY_GATEWAY"),
        ("notify_url", "ALIPAY_NOTIFY_URL"),
        ("return_url", "ALIPAY_RETURN_URL"),
    ):
        if os.environ.get(env):
            cfg[key] = os.environ[env].strip()
    return cfg


def is_mock() -> bool:
    return load_config()["mock"]


def is_enabled() -> bool:
    cfg = load_config()
    if cfg["mock"]:
        return True
    has_private = bool(cfg["private_key"] or cfg["private_key_path"])
    has_public = bool(cfg["alipay_public_key"] or cfg["public_key_path"])
    return bool(cfg["enabled"] and cfg["app_id"] and has_private and has_public)


def _read_key_file(path: str) -> str:
    if not path:
        return ""
    try:
        return Path(path).read_text(encoding="utf-8").strip()
    except OSError as exc:
        LOG.warning("读取密钥文件失败 %s：%s", path, exc)
        return ""


def _private_key_raw(cfg: dict) -> str:
    return cfg["private_key"] or _read_key_file(cfg["private_key_path"])


def _public_key_raw(cfg: dict) -> str:
    return cfg["alipay_public_key"] or _read_key_file(cfg["public_key_path"])


def public_config() -> dict:
    return {
        "enabled": is_enabled(),
        "mock": is_mock(),
        "channel": "alipay",
        "amounts": RECHARGE_AMOUNTS,
        "min_amount": str(MIN_AMOUNT),
        "max_amount": str(MAX_AMOUNT),
    }


def validate_amount(raw) -> Decimal:
    """校验充值金额：1.00 ~ 50.00 元，最多两位小数。"""
    try:
        amount = Decimal(str(raw if raw is not None else "").strip()).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        raise ValueError("充值金额必须是数字")
    if amount < MIN_AMOUNT or amount > MAX_AMOUNT:
        raise ValueError(f"单笔充值金额需在 {MIN_AMOUNT} ~ {MAX_AMOUNT} 元之间")
    return amount


def _private_key_pem(raw: str) -> str:
    """把私钥规范成 PKCS#1 PEM（支付宝 SDK 需要 RSA PRIVATE KEY）。"""
    from Crypto.PublicKey import RSA

    text = raw.strip().replace("\\n", "\n")
    if "BEGIN" in text:
        key = RSA.import_key(text)
    else:
        try:
            key = RSA.import_key("-----BEGIN RSA PRIVATE KEY-----\n" + text + "\n-----END RSA PRIVATE KEY-----")
        except ValueError:
            key = RSA.import_key("-----BEGIN PRIVATE KEY-----\n" + text + "\n-----END PRIVATE KEY-----")
    return key.export_key(pkcs=1).decode()


def _public_key_pem(raw: str) -> str:
    """把支付宝公钥规范成 SPKI PEM（BEGIN PUBLIC KEY）。"""
    from Crypto.PublicKey import RSA

    text = raw.strip().replace("\\n", "\n")
    if "BEGIN" in text:
        key = RSA.import_key(text)
    else:
        key = RSA.import_key("-----BEGIN PUBLIC KEY-----\n" + text + "\n-----END PUBLIC KEY-----")
    return key.export_key().decode()


def _client(cfg: dict):
    from alipay.aop.api.AlipayClientConfig import AlipayClientConfig
    from alipay.aop.api.DefaultAlipayClient import DefaultAlipayClient

    client_config = AlipayClientConfig()
    client_config.server_url = cfg["gateway"]
    client_config.app_id = cfg["app_id"]
    client_config.app_private_key = _private_key_pem(_private_key_raw(cfg))
    client_config.alipay_public_key = _public_key_pem(_public_key_raw(cfg))
    client_config.sign_type = "RSA2"
    client_config.charset = "utf-8"
    return DefaultAlipayClient(client_config)


def create_pay(order: dict) -> dict:
    """为订单生成支付地址；mock 模式返回本地模拟支付页。"""
    cfg = load_config()
    if cfg["mock"]:
        return {"pay_url": f"/api/pay/mock/{order['out_trade_no']}", "mock": True}
    if not is_enabled():
        raise RuntimeError("支付宝支付未配置")

    from alipay.aop.api.domain.AlipayTradePagePayModel import AlipayTradePagePayModel
    from alipay.aop.api.request.AlipayTradePagePayRequest import AlipayTradePagePayRequest

    request = AlipayTradePagePayRequest()
    request.notify_url = cfg["notify_url"]
    request.return_url = cfg["return_url"]
    model = AlipayTradePagePayModel()
    model.out_trade_no = order["out_trade_no"]
    model.total_amount = f"{Decimal(str(order['amount'])):.2f}"
    model.subject = "AntiPrint 余额充值"
    model.product_code = "FAST_INSTANT_TRADE_PAY"
    model.timeout_express = "30m"
    request.biz_model = model
    return {"pay_url": _client(cfg).page_execute(request, "GET"), "mock": False}


def verify_notify(params: dict) -> dict | None:
    """验签支付宝异步通知；成功返回参数，失败返回 None。"""
    cfg = load_config()
    if cfg["mock"] or not is_enabled():
        return None
    sign = params.get("sign") or ""
    if not sign:
        return None
    content = "&".join(
        f"{key}={value}" for key, value in sorted(params.items()) if key not in ("sign", "sign_type")
    )
    try:
        from Crypto.Hash import SHA256
        from Crypto.PublicKey import RSA
        from Crypto.Signature import pkcs1_15

        public_key = RSA.import_key(_public_key_pem(_public_key_raw(cfg)))
        pkcs1_15.new(public_key).verify(SHA256.new(content.encode("utf-8")), base64.b64decode(sign))
    except (ValueError, TypeError, KeyError) as exc:
        LOG.warning("支付宝通知验签失败：%s", exc)
        return None
    if params.get("app_id") and params["app_id"] != cfg["app_id"]:
        LOG.warning("支付宝通知 app_id 不匹配：%s", params.get("app_id"))
        return None
    # trade_status 由接口层处理：成功入账，关闭/等待中的通知也要回 success 停止重试
    return params


def query_trade(out_trade_no: str) -> dict | None:
    """主动查单（回调丢失时的兜底）；未配置或查询失败返回 None。"""
    cfg = load_config()
    if cfg["mock"] or not is_enabled():
        return None
    from alipay.aop.api.domain.AlipayTradeQueryModel import AlipayTradeQueryModel
    from alipay.aop.api.request.AlipayTradeQueryRequest import AlipayTradeQueryRequest

    request = AlipayTradeQueryRequest()
    model = AlipayTradeQueryModel()
    model.out_trade_no = out_trade_no
    request.biz_model = model
    try:
        response = _client(cfg).execute(request)
    except Exception as exc:      # SDK 的网络/解析异常不应影响页面轮询
        LOG.warning("支付宝查单失败 %s：%s", out_trade_no, exc)
        return None
    if not getattr(response, "is_success", lambda: False)():
        return None
    return {
        "trade_status": getattr(response, "trade_status", None),
        "trade_no": getattr(response, "trade_no", None),
        "total_amount": getattr(response, "total_amount", None),
    }
