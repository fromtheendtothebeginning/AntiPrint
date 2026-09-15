# agent_api.py — 打印代理接口（设备令牌 X-Agent-Token 鉴权，独立于用户 JWT）
# 代理协议：注册 → 心跳（顺带取配置）→ 轮询领取 → 下载文件 → 回报结果。

import hmac
import json
import logging
import mimetypes
import os
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import config
import constants
import convert
import cover
import db

logger = logging.getLogger("antiprint.agent")

router = APIRouter(prefix="/api/agent", tags=["打印代理"])


class AgentReport(BaseModel):
    """代理注册/心跳上报内容"""
    name: str = ""
    version: str | None = None
    printers: list[str] = Field(default_factory=list)
    launcher: str | None = None


class ResultBody(BaseModel):
    """打印结果回报"""
    ok: bool = False
    error: str | None = None


def agent_enabled() -> bool:
    """代理连接开关：管理员在管理设置里「断开连接」后为 False（值存 settings.agent_enabled）"""
    return str(db.get_settings().get("agent_enabled", "1")).strip() != "0"


def require_agent(x_agent_token: str = Header(default="")) -> bool:
    """代理鉴权依赖：X-Agent-Token 必须与 settings.agent_token 一致，否则 401；
    管理员断开连接后（agent_enabled='0'）一律 403，代理会记日志并继续轮询，重连后自动续上。"""
    expected = db.get_settings().get("agent_token") or ""
    if not expected or not hmac.compare_digest(x_agent_token or "", expected):
        raise HTTPException(status_code=401, detail="打印代理令牌无效")
    if not agent_enabled():
        raise HTTPException(status_code=403, detail="打印代理已被管理员断开连接，请在「管理设置」里重新连接")
    return True


def _upsert_report(body: AgentReport):
    """把上报内容落库（注册/心跳共用）"""
    name = (body.name or "").strip()[:64]
    if not name:
        raise HTTPException(status_code=400, detail="代理名称不能为空")
    printers = [str(item)[:128] for item in (body.printers or [])][:20]
    agent = db.upsert_agent(
        name,
        (body.version or "").strip()[:32] or None,
        printers,
        (body.launcher or "").strip()[:255] or None,
    )
    return agent


def _parse_options(raw) -> dict:
    """把 print_options 的 JSON 文本解析成 dict（老任务没有该字段时返回空 dict）"""
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _job_payload(job):
    """代理视角的任务结构（文件给下载 url 不给本地路径；打印设置解析成 dict 供拼命令行）"""
    if not job:
        return None
    return {
        "id": job["id"],
        # 任务信息页（封面页）：代理先把它打一张，再打下面的文件
        "cover_url": f"/api/agent/jobs/{job['id']}/cover.pdf",
        "address": job["address"],
        "note": job["note"],
        "copies": job["copies"],
        "print_options": _parse_options(job.get("print_options")),
        "files": [
            {
                "id": item["id"],
                "filename": item["filename"],
                # Office（Word/PPT）下载到的是转换后的 PDF，代理按这个名字存盘并打印（后缀必须是 .pdf）
                "print_name": (
                    f"{Path(item['filename']).stem}.pdf" if convert.is_office(item["filename"]) else item["filename"]
                ),
                "size": item["size"],
                "url": f"/api/agent/jobs/{job['id']}/files/{item['id']}",
                "print_options": _parse_options(item.get("print_options")),
            }
            for item in job.get("files", [])
        ],
    }


# 上面的 files 循环里补上每个文件的打印设置（文件级优先，任务级作兜底，代理自己决定优先级）


@router.post("/register")
def register(body: AgentReport, _: bool = Depends(require_agent)):
    """代理启动时注册（按 name upsert，刷新 last_seen）"""
    agent = _upsert_report(body)
    logger.info(
        "打印代理注册：%s（版本 %s，本机打印机 %s 台）",
        agent["name"], agent.get("version") or "未知", len(agent.get("printers") or []),
    )
    return {"ok": True, "agent": agent}


@router.post("/heartbeat")
def heartbeat(body: AgentReport, _: bool = Depends(require_agent)):
    """心跳：刷新在线状态并下发服务端配置（断网时由代理本机 config.json 兜底）"""
    _upsert_report(body)
    settings = db.get_settings()
    return {
        "ok": True,
        "config": {
            "launcher": settings["launcher"],
            "printer_name": settings["printer_name"],
            "copies": settings["copies"],
            "dry_run": settings["dry_run"],
        },
    }


@router.post("/claim")
def claim(_: bool = Depends(require_agent)):
    """原子领取一个「已通过」任务；没有待打印任务时返回 {"job": null}"""
    agents = db.list_agents()
    agent_id = agents[0]["id"] if agents else None   # 令牌全局唯一，取最近心跳的代理作为领取者
    job = db.claim_next_job(agent_id)
    if job:
        logger.info("代理领取任务 #%s（文件 %s 个）", job["id"], len(job.get("files") or []))
    return {"job": _job_payload(job)}


@router.get("/jobs/{job_id}/cover.pdf")
def download_cover(job_id: int, _: bool = Depends(require_agent)):
    """任务信息页 PDF（每次请求重新生成，好让「打印时间」是当下的）"""
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    try:
        path = cover.render(job)
    except convert.ConvertError as exc:
        raise HTTPException(status_code=500, detail=f"生成任务信息页失败：{exc}")
    filename = f"任务信息-{job_id}.pdf"
    return FileResponse(
        str(path),
        media_type="application/pdf",
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": f"attachment; filename=\"cover-{job_id}.pdf\"; filename*=UTF-8''{quote(filename)}",
        },
    )


@router.get("/jobs/{job_id}/files/{file_id}")
def download(job_id: int, file_id: int, _: bool = Depends(require_agent)):
    """代理下载待打印文件（一律 attachment；路径由 DB stored_name 拼接并防目录穿越）

    Office（Word/PPT）给的是**转换后的 PDF**（与 claim 里的 print_name 一致），
    代理直接交给 SumatraPDF 打印，不需要自己转换。
    """
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    row = next((item for item in job.get("files", []) if item["id"] == file_id), None)
    if not row:
        raise HTTPException(status_code=404, detail="文件不存在")
    path = config.upload_path(job_id, row["stored_name"])
    if not path or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="文件不存在")
    filename = row["filename"] or "file"
    if convert.is_office(filename):
        try:
            pdf_path, filename = convert.pdf_for(path, filename, row.get("sha256"))
        except convert.ConvertError as exc:
            raise HTTPException(status_code=500, detail=f"转换失败，无法打印：{exc}")
        path = str(pdf_path)
        media_type = "application/pdf"
    else:
        media_type = mimetypes.guess_type(row["stored_name"])[0] or "application/octet-stream"
    fallback = filename.encode("ascii", "ignore").decode().replace('"', "") or "file"
    headers = {
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename)}",
    }
    return FileResponse(path, media_type=media_type, headers=headers)


@router.post("/jobs/{job_id}/result")
def report_result(job_id: int, body: ResultBody, _: bool = Depends(require_agent)):
    """代理回报打印结果：ok=true → 已打印；ok=false → 打印失败（错误摘要入库）"""
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    if job["status"] != constants.S_PRINTING:
        raise HTTPException(status_code=400, detail=f"任务当前状态为「{job['status']}」，不接受打印结果上报")
    error = (body.error or "").strip()
    if not body.ok and not error:
        error = "打印失败（代理未返回具体错误）"
    updated = db.finish_job(job_id, body.ok, error or None)
    if updated is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    logger.info("任务 #%s 回报结果：%s", job_id, updated["status"])
    return {"ok": True, "status": updated["status"]}
