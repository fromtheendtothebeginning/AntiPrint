"""生成 agent/config.json（临时脚本）：从服务端设置里取代理令牌写入本机配置。

先用干跑模式（dry_run=True）验证链路，真实打印前再改成 False。
"""
import json
import pathlib
import sys

import requests

BASE = "http://127.0.0.1:8301"
ROOT = pathlib.Path(__file__).resolve().parent.parent

login = requests.post(f"{BASE}/api/login", json={"username": "admin", "password": "admin123"}, timeout=10)
login.raise_for_status()
token = login.json()["token"]

settings = requests.get(
    f"{BASE}/api/settings", headers={"Authorization": "Bearer " + token}, timeout=10
).json()["settings"]

cfg = {
    "server": BASE,
    "agent_token": settings["agent_token"],
    "name": "print-agent-1",
    "launcher": settings.get("launcher", "sumatra"),
    "printer_name": settings.get("printer_name", "HP LaserJet Professional P1106"),
    "copies": int(settings.get("copies", 1) or 1),
    "dry_run": settings.get("dry_run", "0") in ("1", "true", "yes", "on"),
    "poll_interval": 5,
    "sumatra_path": r"C:\Users\86133\AppData\Local\SumatraPDF\SumatraPDF.exe",
}
out = ROOT / "agent" / "config.json"
out.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"已写入 {out}：launcher={cfg['launcher']} printer={cfg['printer_name']} dry_run={cfg['dry_run']} 令牌长度={len(cfg['agent_token'])}")
sys.exit(0)
