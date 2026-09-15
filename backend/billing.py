# billing.py — 打印计费：单价、免费名单判定、按「张数」算钱
#
# 规则（2026-09-15 按需求定）：
#   免费账号：管理员/root、anticraft 账号（users.source='anticraft'）、白名单（settings.free_users）
#   其余账号按「张数 × 单价」扣余额；单价存 settings.print_price（默认 0.1 元/张）
#   张数 = Σ 每个文件 ceil(实际打印页数 / 每张页数) × 份数（Word/PPT 按转换后的 PDF 页数算）
# 金额一律用 Decimal（精确到分），避免浮点误差把钱算歪。

import logging
import re
import zlib
from decimal import Decimal, InvalidOperation, ROUND_CEILING

import db

LOG = logging.getLogger("antiprint.billing")

DEFAULT_PRICE = "0.1"
PRICE_MIN = Decimal("0")
PRICE_MAX = Decimal("100")          # 单张上限：防手滑写成 1000 元/张
CENT = Decimal("0.01")


def unit_price() -> Decimal:
    """当前单价（元/张）；库里值非法时回落到默认 0.1"""
    raw = str(db.get_settings().get("print_price") or DEFAULT_PRICE).strip()
    try:
        price = Decimal(raw).quantize(CENT)
    except (InvalidOperation, ValueError):
        LOG.warning("print_price 取值非法（%r），回落到 %s", raw, DEFAULT_PRICE)
        return Decimal(DEFAULT_PRICE)
    if price < PRICE_MIN or price > PRICE_MAX:
        LOG.warning("print_price 超出范围（%s），回落到 %s", price, DEFAULT_PRICE)
        return Decimal(DEFAULT_PRICE)
    return price


def parse_price(raw) -> Decimal:
    """校验管理端提交的单价：0 ~ 100 元，最多两位小数；非法抛 ValueError（中文原因）"""
    text = str(raw if raw is not None else "").strip()
    if not text:
        raise ValueError("单价不能为空")
    try:
        price = Decimal(text)
    except (InvalidOperation, ValueError):
        raise ValueError("单价必须是数字，例如 0.1")
    if price.is_nan() or price.is_infinite():
        raise ValueError("单价必须是数字，例如 0.1")
    if price < PRICE_MIN or price > PRICE_MAX:
        raise ValueError(f"单价需在 0 ~ {PRICE_MAX} 元之间")
    return price.quantize(CENT)


def free_user_names() -> set[str]:
    """白名单（用户名集合）：settings.free_users，逗号/中文逗号/分号/空格分隔"""
    raw = str(db.get_settings().get("free_users") or "")
    return {name.strip() for name in re.split(r"[,，;；\s]+", raw) if name.strip()}


def free_reason(user: dict) -> str:
    """这个账号为什么免费；要计费返回空串"""
    if not user:
        return ""
    if user.get("role") in ("admin", "root"):
        return "管理员账号免打印费" if user.get("role") == "admin" else "超级管理员账号免打印费"
    if (user.get("source") or "local") == "anticraft":
        return "anticraft 账号免打印费"
    if (user.get("username") or "") in free_user_names():
        return "在免费白名单里"
    return ""


def is_free(user: dict) -> bool:
    return bool(free_reason(user))


# ── PDF 页数 ──

_PAGE_RE = re.compile(rb"/Type\s*/Page[^s]")
_STREAM_RE = re.compile(rb"stream\r?\n(.*?)endstream", re.S)


def count_pdf_pages(path) -> int:
    """数 PDF 页数：先数明文里的 /Type /Page，数不到再把 Flate 压缩的流解开数一遍。

    PDF 1.5+ 常把页对象塞进对象流（ObjStm），所以不能只看明文。
    解析不了时返回 1（宁可少收一点，也不要因为数不出页数就报错拦住用户）。
    """
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except OSError as exc:
        LOG.warning("读取 PDF 失败，按 1 页计费：%s", exc)
        return 1
    found = len(_PAGE_RE.findall(data))
    if found:
        return found
    for match in _STREAM_RE.finditer(data):
        raw = match.group(1).strip()
        try:
            raw = zlib.decompress(raw)
        except zlib.error:
            continue
        found += len(_PAGE_RE.findall(raw))
        if found:
            break
    return found or 1


def count_range_pages(spec: str, total: int) -> int:
    """页面范围（如 "1-3,5"）里一共选了多少页；空/非法就按全部页数"""
    spec = (spec or "").strip()
    if not spec or total <= 0:
        return total
    total_count = 0
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            start, _, end = part.partition("-")
            try:
                start = int(start) if start.strip() else 1
                end = int(end) if end.strip() else total
            except ValueError:
                return total
            if start > end:
                start, end = end, start
            start = max(1, start)
            end = min(total, end)
            total_count += max(0, end - start + 1)
        else:
            try:
                page = int(part)
            except ValueError:
                return total
            if 1 <= page <= total:
                total_count += 1
    return total_count or total


def pages_per_sheet(options: dict | None) -> int:
    """每张纸排几页（nup 形如 "2,2" = 2 行 × 2 列）；不合法按 1"""
    raw = str((options or {}).get("nup") or "").strip()
    if not raw:
        return 1
    try:
        rows, cols = (int(part) or 1 for part in raw.split(",", 1))
    except ValueError:
        return 1
    return max(1, rows) * max(1, cols)


def estimate(job_files: list[dict]) -> tuple[int, Decimal]:
    """按已落盘的文件算 (张数, 金额)。

    job_files 每项：{path（可打印的 PDF 或图片路径）, filename, is_pdf, copies, options}
    Word/PPT 传进来的是转换后的 PDF 路径（is_pdf=True）。
    """
    sheets = 0
    for item in job_files:
        copies = max(1, int(item.get("copies") or 1))
        if item.get("is_pdf"):
            total = count_pdf_pages(item["path"])
            pages = count_range_pages(str((item.get("options") or {}).get("pages") or ""), total)
        else:
            pages = 1                                   # 一张图片算一页
        per_sheet = pages_per_sheet(item.get("options"))
        sheets += max(1, -(-pages // per_sheet)) * copies
    amount = (Decimal(sheets) * unit_price()).quantize(CENT, rounding=ROUND_CEILING)
    return sheets, amount


def price_text() -> str:
    """单价的展示文本：0.10 元/张 → "0.1 元/张"（去掉多余的 0）"""
    text = f"{unit_price():.2f}".rstrip("0").rstrip(".")
    return f"{text or '0'} 元/张"
