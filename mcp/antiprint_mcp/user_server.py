"""AntiPrint 用户端 MCP Server。

把 https://print.anticraft.top 的用户接口暴露成 MCP 工具，供 Claude Desktop / Cursor / Trae 等
客户端直接调用（查余额、看我的任务、提交打印、撤回、充值）。

与「管理端」共用同一份配置（环境变量优先，其次 ~/.antiprint-mcp.json）：
    ANTIPRINT_BASE_URL   站点地址，默认 https://print.anticraft.top
    ANTIPRINT_TOKEN      网站生成的长期 API 令牌（ap_ 开头）

同一个令牌，角色决定能做什么：普通账号只能操作自己的任务与余额；
管理端工具在 `antiprint-mcp`（server.py），用户端工具在 `antiprint-user-mcp`。
"""

from mcp.server.fastmcp import FastMCP

from antiprint_mcp.server import _api, _job_brief, _submit_print_job

mcp = FastMCP("AntiPrint 用户端")


def _job_list(jobs: list[dict], status: str, limit: int) -> dict:
    """按状态过滤并截断，避免把整库任务全塞给模型。"""
    wanted = (status or "").strip()
    if wanted:
        jobs = [job for job in jobs if job.get("status") == wanted]
    count = max(1, min(int(limit), 100))
    return {
        "total": len(jobs),
        "jobs": [_job_brief(job) for job in jobs[:count]],
    }


# ── 身份 ──

@mcp.tool()
def whoami() -> dict:
    """查看当前令牌对应的账号与角色（确认令牌是否有效）。"""
    return _api("GET", "/api/me")


# ── 余额 ──

@mcp.tool()
def my_balance() -> dict:
    """我的余额：余额、是否计费、单价、充值开关与赠送比例、最近 50 条扣费/退费流水。"""
    return _api("GET", "/api/balance")


# ── 我的任务 ──

@mcp.tool()
def list_my_jobs(status: str = "", limit: int = 20) -> dict:
    """列出我提交的打印任务（倒序）。

    status 留空=全部，可选：待支付 / 待审核 / 已通过 / 打印中 / 已打印 / 待配送 /
    待取件 / 已完成 / 已驳回 / 打印失败 / 已撤回。
    """
    data = _api("GET", "/api/jobs/mine")
    return _job_list(data.get("jobs") or [], status, limit)


@mcp.tool()
def get_my_job(job_id: int) -> dict:
    """查看我某个任务的详情（状态、地址、备注、驳回理由、打印错误、文件与扣费）。"""
    data = _api("GET", f"/api/jobs/{int(job_id)}")
    return data.get("job") or data


@mcp.tool()
def withdraw_my_job(job_id: int) -> dict:
    """撤回我自己的任务（仅「待支付 / 待审核 / 已通过」，还没出纸），已扣费用自动退回。"""
    return _api("POST", f"/api/jobs/{int(job_id)}/withdraw")


# ── 提交打印 ──

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
    """提交一个打印任务：读取本机文件并上传（PDF / 图片 / Word / PPT，单个 ≤10MB，最多 5 个）。

    提交时按「张数 × 单价」从余额自动扣费，任务立刻进入「待审核」队列；
    免费账号（白名单 / anticraft / 管理员）不扣费。
    delivery_mode：「配送」需要填写 address；留空取我的默认配送方式。
    pay_mode：balance=余额支付（默认，提交即扣费）；instant=支付宝即时付款（返回 pay_url 给用户扫码/打开）。
    paper / pages / nup / scale 留空用打印机默认。
    """
    return _submit_print_job(
        file_paths, delivery_mode, address, copies, note, pay_mode, paper, pages, nup, scale,
    )


# ── 充值 ──

@mcp.tool()
def recharge(amount: str) -> dict:
    """创建支付宝充值订单（金额如 "10"），返回 pay_url 给用户付款；付款后用 check_recharge 查状态。"""
    text = str(amount or "").strip()
    if not text:
        raise RuntimeError("请填写充值金额，例如 recharge(\"10\")")
    return _api("POST", "/api/pay/recharge", json={"amount": text})


@mcp.tool()
def check_recharge(out_trade_no: str) -> dict:
    """查询充值订单状态（支付成功后后端会自动入账，余额见 balance 字段）。"""
    order = (out_trade_no or "").strip()
    if not order:
        raise RuntimeError("请传订单号 out_trade_no（recharge 返回的那个）")
    return _api("GET", f"/api/pay/orders/{order}")


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
