# realtime.py — 管理端实时推送（WebSocket 广播）
#
# 用途：手机 App 常驻前台服务 + WebSocket，新任务进入「待审核」时立即弹系统通知。
# 只在单进程 uvicorn 下工作（本项目就是单进程），不需要 Redis。

import asyncio
import json
import logging

from fastapi import WebSocket

LOG = logging.getLogger("antiprint.realtime")


class AdminHub:
    """管理端 WebSocket 连接集合；同步路由通过 call_soon_threadsafe 广播。"""

    def __init__(self):
        self._clients: set[WebSocket] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop):
        """启动时绑定事件循环（FastAPI 的 lifespan 里调用）。"""
        self._loop = loop

    async def serve(self, websocket: WebSocket):
        """接管一条已鉴权的连接，直到客户端断开。"""
        await websocket.accept()
        self._clients.add(websocket)
        LOG.info("管理端实时连接建立（当前 %s 条）", len(self._clients))
        try:
            while True:
                # 客户端心跳（文本/字节都行），收到即忽略；断开时抛异常退出
                await websocket.receive_text()
        except Exception:
            pass
        finally:
            self._clients.discard(websocket)
            LOG.info("管理端实时连接断开（当前 %s 条）", len(self._clients))

    def broadcast(self, event: dict):
        """线程安全广播：可在同步路由（线程池）里直接调用。"""
        if not self._clients or not self._loop or self._loop.is_closed():
            return
        self._loop.call_soon_threadsafe(lambda: asyncio.create_task(self._send(event)))

    async def _send(self, event: dict):
        text = json.dumps(event, ensure_ascii=False, default=str)
        dead = []
        for websocket in list(self._clients):
            try:
                await websocket.send_text(text)
            except Exception:
                dead.append(websocket)
        for websocket in dead:
            self._clients.discard(websocket)


HUB = AdminHub()


def job_pending_event(job: dict) -> dict:
    """「新任务待审核」事件：只带 App 通知需要的字段，避免泄露整单信息。"""
    return {
        "type": "job_pending",
        "job": {
            "id": job.get("id"),
            "username": job.get("username"),
            "delivery_mode": job.get("delivery_mode"),
            "charge": job.get("charge"),
            "created_at": job.get("created_at"),
            "files": [item.get("filename") for item in (job.get("files") or [])],
        },
    }
