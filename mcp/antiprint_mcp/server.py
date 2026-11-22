"""AntiPrint 管理端 MCP Server。

把 https://print.anticraft.top 的管理接口暴露成 MCP 工具，供 Claude Desktop / Cursor / Trae 等
客户端直接调用（提交打印、管理任务队列、审核、交接、用户与设置）。

配置（环境变量优先，其次 ~/.antiprint-mcp.json）：
    ANTIPRINT_BASE_URL   站点地址，默认 https://print.anticraft.top
    ANTIPRINT_TOKEN      网站生成的长期 API 令牌（ap_ 开头），管理员账号生成才有管理权限

    ~/.antiprint-mcp.json 示例：{"base_url": "https://print.anticraft.top", "token": "ap_xxx"}
"""

import json
import mimetypes
import os
from pathlib import Path

import httpx
from mcp.server.fastmcp import FastMCP

DEFAULT_BASE_URL = "https://print.anticraft.top"

# 与后端 constants.UPLOAD_EXT / config.MAX_FILE_SIZE 保持一致
ALLOWED_EXT = {".pdf", ".png", ".jpg", ".jpeg", ".docx", ".doc", ".pptx", ".ppt"}
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_FILES = 5

mcp = FastMCP("AntiPrint 管理端")


def _config() -> tuple[str, str]:
    """读配置：环境变量 > ~/.antiprint-mcp.json > 默认值。"""
    cfg = {}
    path = Path(os.environ.get("ANTIPRINT_MCP_CONFIG", "~/.antiprint-mcp.json")).expanduser()
    if path.is_file():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8-sig"))
            if isinstance(loaded, dict):
                cfg = loaded
        except (OSError, ValueError):
            cfg = {}
    base_url = (os.environ.get("ANTIPRINT_BASE_URL") or cfg.get("base_url") or DEFAULT_BASE_URL).rstrip("/")
    token = (os.environ.get("ANTIPRINT_TOKEN") or cfg.get("token") or "").strip()
    return base_url, token


def _api(method: str, path: str, **kwargs):
    """调用 AntiPrint REST 接口；失败抛中文 RuntimeError（MCP 会作为工具错误回给模型）。"""
    base_url, token = _config()
    if not token:
        raise RuntimeError("未配置 ANTIPRINT_TOKEN：先在网站 /api/tokens 生成一个管理员 API 令牌")
    headers = {"Authorization": "Bearer " + token}
    try:
        response = httpx.request(method, base_url + path, headers=headers, timeout=30, **kwargs)
    except httpx.HTTPError as exc:
        raise RuntimeError(f"连接 AntiPrint 失败：{exc}")
    if response.status_code >= 400:
        try:
            detail = response.json().get("detail") or response.text
        except ValueError:
            detail = response.text
        raise RuntimeError(f"接口返回 {response.status_code}：{detail}")
    return response.json()


def _job_brief(job: dict) -> dict:
    """任务摘要：列表用，避免把大字段全塞给模型。"""
    return {
        "id": job.get("id"),
        "status": job.get("status"),
        "user": job.get("username") or job.get("user_id"),
        "copies": job.get("copies"),
        "charge": job.get("charge"),
        "pay_method": job.get("pay_method"),
        "delivery_mode": job.get("delivery_mode"),
        "print_options": job.get("print_options"),
        "created_at": job.get("created_at"),
        "files": [
            {"filename": item.get("filename"), "size": item.get("size")}
            for item in (job.get("files") or [])
        ],
    }


# ── 身份 ──

@mcp.tool()
def whoami() -> dict:
    """查看当前令牌对应的账号与角色（确认是否有管理权限）。"""
    return _api("GET", "/api/me")


# ── 任务队列 ──

@mcp.tool()
def list_jobs(status: str = "", limit: int = 20) -> dict:
    """列出打印任务（管理端队列，倒序）。

    status 留空=全部，可选：待审核 / 已通过 / 打印中 / 已打印 / 待配送 / 待取件 /
    已完成 / 已驳回 / 打印失败 / 已撤回。同时返回打印代理是否在线。
    """
    data = _api("GET", "/api/jobs")
    jobs = data.get("jobs") or []
    if status.strip():
        jobs = [job for job in jobs if job.get("status") == status.strip()]
    return {
        "agent_online": data.get("agent_online"),
        "agents": data.get("agents") or [],
        "total": len(jobs),
        "jobs": [_job_brief(job) for job in jobs[: max(1, min(int(limit), 100))]],
    }


@mcp.tool()
def get_job(job_id: int) -> dict:
    """查看单个任务详情（地址、备注、驳回理由、打印错误、文件与扣费）。"""
    return _api("GET", f"/api/jobs/{int(job_id)}")


@mcp.tool()
def approve_job(job_id: int) -> dict:
    """通过审核：待审核 / 打印失败 → 已通过（进入打印队列等代理领取）。"""
    return _api("POST", f"/api/jobs/{int(job_id)}/approve")


@mcp.tool()
def reject_job(job_id: int, reason: str) -> dict:
    """驳回待审核任务（理由必填）；扣过的钱会自动退回（余额或支付宝原路）。"""
    text = (reason or "").strip()
    if not text:
        raise RuntimeError("驳回理由不能为空")
    return _api("POST", f"/api/jobs/{int(job_id)}/reject", json={"reason": text})


@mcp.tool()
def retry_job(job_id: int) -> dict:
    """重试打印失败的任务：打印失败 → 已通过（重新入队）。"""
    return _api("POST", f"/api/jobs/{int(job_id)}/retry")


@mcp.tool()
def reprint_job(job_id: int) -> dict:
    """重新打印：把已打印/待配送/待取件/已完成/打印失败的任务重新入队（已通过）。"""
    return _api("POST", f"/api/jobs/{int(job_id)}/reprint")


@mcp.tool()
def advance_job(job_id: int, to: str) -> dict:
    """打印完成后的交接流转：已打印 →「待配送」或「待取件」，再 →「已完成」。

    配送单不能进待取件，取件单不能进待配送（服务端会校验）。
    """
    target = (to or "").strip()
    if target not in ("待配送", "待取件", "已完成"):
        raise RuntimeError("to 只能是：待配送 / 待取件 / 已完成")
    return _api("POST", f"/api/jobs/{int(job_id)}/advance", json={"to": target})


@mcp.tool()
def withdraw_job(job_id: int) -> dict:
    """管理员代用户撤回任务（未出纸前）：待支付/待审核/已通过 → 已撤回，并自动退费。"""
    return _api("POST", f"/api/jobs/{int(job_id)}/withdraw")


@mcp.tool()
def delete_job(job_id: int) -> dict:
    """删除任务及其上传文件（不可恢复）；未出纸的任务会先自动退费。"""
    return _api("DELETE", f"/api/jobs/{int(job_id)}")


# ── 提交打印（管理端同样能直接提交，走同一条计费 + 审核队列）──

def _prepare_upload(file_paths: list[str]) -> list[tuple]:
    """把本地路径读成 multipart 文件段；先做后缀 / 大小 / 数量校验，错误信息给中文。"""
    paths = [str(item).strip() for item in (file_paths or []) if str(item).strip()]
    if not paths:
        raise RuntimeError("请至少传一个本地文件路径（file_paths）")
    if len(paths) > MAX_FILES:
        raise RuntimeError(f"最多 {MAX_FILES} 个文件")
    parts = []
    for raw in paths:
        path = Path(raw).expanduser()
        if not path.is_file():
            raise RuntimeError(f"文件不存在：{raw}")
        suffix = path.suffix.lower()
        if suffix not in ALLOWED_EXT:
            raise RuntimeError(f"不支持的文件类型：{path.name}（只收 PDF / 图片 / Word / PPT）")
        size = path.stat().st_size
        if size > MAX_FILE_BYTES:
            raise RuntimeError(f"文件超过 10MB：{path.name}")
        if size == 0:
            raise RuntimeError(f"文件是空的：{path.name}")
        parts.append((
            "files",
            (path.name, path.read_bytes(), mimetypes.guess_type(path.name)[0] or "application/octet-stream"),
        ))
    return parts


def _submit_print_job(
    file_paths: list[str],
    delivery_mode: str = "",
    address: str = "",
    copies: int = 1,
    note: str = "",
    pay_mode: str = "balance",
    paper: str = "",
    pages: str = "",
    nup: str = "",
    scale: str = "",
) -> dict:
    """提交打印任务的公共实现：两端 MCP 共用（扣费与入队都由服务端完成）。"""
    mode = (delivery_mode or "").strip()
    if mode and mode not in ("配送", "取件"):
        raise RuntimeError("delivery_mode 只能是「配送」或「取件」")
    if mode == "配送" and not (address or "").strip():
        raise RuntimeError("选择配送时请填写配送地址 address")
    pay = (pay_mode or "balance").strip().lower()
    if pay not in ("balance", "instant"):
        raise RuntimeError("pay_mode 只能是 balance（余额支付，提交即扣费）或 instant（即时付款）")
    try:
        copies_value = int(copies)
    except (TypeError, ValueError):
        raise RuntimeError("copies 必须是整数")
    if not 1 <= copies_value <= 99:
        raise RuntimeError("copies 需在 1~99 之间")

    data = {"copies": str(copies_value), "pay_mode": pay}
    for key, value in (
        ("delivery_mode", mode),
        ("address", (address or "").strip()),
        ("note", (note or "").strip()),
        ("paper", (paper or "").strip()),
        ("pages", (pages or "").strip()),
        ("nup", (nup or "").strip()),
        ("scale", (scale or "").strip()),
    ):
        if value:
            data[key] = value

    result = _api("POST", "/api/jobs", data=data, files=_prepare_upload(file_paths))
    job = result.get("job") or {}
    result["summary"] = (
        f"任务 #{job.get('id')} 已提交，当前状态「{job.get('status')}」，"
        f"本单费用 {result.get('charge')} 元，余额 {result.get('balance')} 元"
    )
    return result


@mcp.tool()
def submit_print_job(
    file_paths: list[str],
    delivery_mode: str = "",
    address: str = "",
    copies: int = 1,
    note: str = "",
    pay_mode: str = "balance",
    paper: str = "",
    pages: str = "",
    nup: str = "",
    scale: str = "",
) -> dict:
    """用当前账号提交一个打印任务（读取本机文件上传，自动扣费并进入审核队列）。

    管理员 / root / 免费白名单账号不扣余额，普通账号按「张数 × 单价」自动扣减；
    提交成功后任务立刻进入「待审核」队列，审核通过后由打印代理出纸。
    file_paths：本机文件路径列表（PDF / 图片 / Word / PPT，单个 ≤10MB，最多 5 个）。
    delivery_mode：「配送」必须填 address；留空取我的默认配送方式。
    pay_mode：balance=余额支付（默认，提交即扣费）；instant=支付宝即时付款（返回 pay_url）。
    paper / pages / nup / scale 留空用打印机默认。
    """
    return _submit_print_job(
        file_paths, delivery_mode, address, copies, note, pay_mode, paper, pages, nup, scale,
    )


# ── 用户 ──

@mcp.tool()
def list_users() -> dict:
    """用户列表（管理员可见）：角色、余额、来源、任务数。"""
    return _api("GET", "/api/users")


@mcp.tool()
def adjust_balance(user_id: int, delta: str, note: str = "") -> dict:
    """管理员调账：delta 为正=加钱、为负=扣钱（元，最多两位小数，单次 ≤ 10000）。"""
    return _api(
        "POST", f"/api/users/{int(user_id)}/balance",
        json={"delta": str(delta), "note": (note or "").strip() or None},
    )


@mcp.tool()
def set_user_role(user_id: int, role: str) -> dict:
    """修改角色（仅 root）：role 只能是 user 或 admin；不能改自己和 root。"""
    target = (role or "").strip()
    if target not in ("user", "admin"):
        raise RuntimeError("role 只能是 user 或 admin")
    return _api("POST", f"/api/users/{int(user_id)}/role", json={"role": target})


@mcp.tool()
def delete_user(user_id: int) -> dict:
    """删除账号（不可恢复）：要求余额为 0，且不能删自己或 root。"""
    return _api("DELETE", f"/api/users/{int(user_id)}")


# ── 设置与打印代理 ──

@mcp.tool()
def get_settings() -> dict:
    """读系统设置与打印代理状态（单价、赠送比例、白名单、打印机、代理是否在线）。"""
    return _api("GET", "/api/settings")


@mcp.tool()
def update_settings(
    print_price: str | None = None,
    free_users: str | None = None,
    copies: int | None = None,
    printer_name: str | None = None,
    dry_run: bool | None = None,
    cover_page: bool | None = None,
) -> dict:
    """修改系统设置（只传要改的字段）。

    print_price：每张单价（元，如 "0.15"）；free_users：免费白名单用户名（逗号分隔）；
    copies：默认份数 1~99；printer_name：代理侧打印机名；
    dry_run：true=只生成不打印（调试用）；cover_page：true=出纸前打任务信息页。
    """
    payload = {}
    if print_price is not None:
        payload["print_price"] = str(print_price)
    if free_users is not None:
        payload["free_users"] = str(free_users)
    if copies is not None:
        payload["copies"] = int(copies)
    if printer_name is not None:
        payload["printer_name"] = str(printer_name)
    if dry_run is not None:
        payload["dry_run"] = bool(dry_run)
    if cover_page is not None:
        payload["cover_page"] = bool(cover_page)
    if not payload:
        raise RuntimeError("没有要修改的设置项")
    return _api("POST", "/api/settings", json=payload)


@mcp.tool()
def set_agent_connected(connected: bool) -> dict:
    """断开 / 恢复打印代理：断开后代理不再领取任务（任务只是排队），恢复后自动续上。"""
    return _api("POST", "/api/settings/agent-link", json={"connected": bool(connected)})


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
