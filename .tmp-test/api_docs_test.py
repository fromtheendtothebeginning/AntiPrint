# -*- coding: utf-8 -*-
"""API 文档 + 虚拟打印机安装包下载的接口用例（临时脚本，不算交付代码）。

跑法： backend\\.venv\\Scripts\\python.exe .tmp-test\\api_docs_test.py
（需要后端跑在 8301；管理员令牌走 .tmp-test/.admin-token.json 缓存，登录限速 10 次/分钟）

覆盖：
  1. 文档：未登录 401、登录可读、出厂默认、admin 才能改、改完持久化、超长 400、清空=恢复默认
  2. 下载：清单三个平台（只开 windows-x64）、未登录 401、未开放 404、下载字节与 sha256/大小一致
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import api_docs        # noqa: E402   （读出厂文档原文做对比）
import config          # noqa: E402

BASE = "http://127.0.0.1:8301"
CACHE = ROOT / ".tmp-test" / ".admin-token.json"

PASS = 0
FAIL = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
    else:
        FAIL += 1
    print(("  [OK  ] " if ok else "  [FAIL] ") + name + (f" — {detail}" if detail else ""))


def req(method: str, path: str, token: str = "", **kwargs):
    headers = kwargs.pop("headers", {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    resp = requests.request(method, BASE + path, headers=headers, timeout=60, **kwargs)
    try:
        return resp.status_code, resp.json()
    except ValueError:
        return resp.status_code, {}


def login(username: str, password: str) -> str:
    code, data = req("POST", "/api/login", json={"username": username, "password": password})
    assert code == 200, f"登录失败：{code} {data}"
    return data["token"]


def admin_token() -> str:
    """优先用缓存（避免限速），失效再用 admin/admin123 登一次"""
    try:
        token = json.loads(CACHE.read_text(encoding="utf-8")).get("token") or ""
        if token and req("GET", "/api/settings", token)[0] == 200:
            return token
    except (OSError, ValueError):
        pass
    token = login("admin", "admin123")
    CACHE.write_text(json.dumps({"token": token, "ts": int(time.time() * 1000)}), encoding="utf-8")
    return token


print("== 1. API 文档 ==")
ADMIN = admin_token()

code, _ = req("GET", "/api/docs/api")
check("未登录读文档 → 401（文档只给登录用户看）", code == 401, f"HTTP {code}")

# 普通用户：注册一个（登录限速 10 次/分钟，用例里只登两次）
tag = str(int(time.time()))[-6:]
UNAME = f"doc{tag}"
code, data = req("POST", "/api/register", json={"username": UNAME, "password": "Test123456"})
if code != 200:
    code, data = req("POST", "/api/login", json={"username": UNAME, "password": "Test123456"})
USER = data["token"]
code, other = req("GET", "/api/settings", ADMIN)
user_id = next((u["id"] for u in other.get("users", []) if u.get("username") == UNAME), 0) if code == 200 else 0

# 先确保处于「出厂文档」状态
req("PUT", "/api/docs/api", ADMIN, json={"content": ""})

code, data = req("GET", "/api/docs/api", USER)
check("登录用户能读文档", code == 200 and bool(data.get("content")), f"HTTP {code}")
check("没改过时标成「出厂文档」", data.get("custom") is False, f"custom={data.get('custom')}")
check("出厂文档就是 api_docs.DEFAULT_DOCS 那份", data.get("content") == api_docs.DEFAULT_DOCS.strip(),
      f"{len(data.get('content') or '')} 字")
check("出厂文档里含打印 API 的提交接口与 Python 示例",
      "POST /api/jobs" in data["content"] and "requests" in data["content"])

code, _ = req("PUT", "/api/docs/api", USER, json={"content": "# 普通用户改的"})
check("普通用户改文档 → 403（只有管理员能动）", code == 403, f"HTTP {code}")

marker = f"# 管理员改的文档 {tag}\n\n这是一行测试内容。"
code, data = req("PUT", "/api/docs/api", ADMIN, json={"content": marker})
check("管理员改文档成功", code == 200 and data.get("custom") is True, f"HTTP {code}")
check("返回里带上更新者与时间", bool(data.get("updated_by")) and bool(data.get("updated_at")),
      f"{data.get('updated_by')} @ {data.get('updated_at')}")

code, again = req("GET", "/api/docs/api", USER)
check("改完立刻持久化（普通用户读到的是新版本）", again.get("content") == marker, again.get("content", "")[:40])

code, _ = req("PUT", "/api/docs/api", ADMIN, json={"content": "x" * 200_001})
check("超长文档 → 400", code == 400, f"HTTP {code}")

code, data = req("PUT", "/api/docs/api", ADMIN, json={"content": "   "})
check("传空 = 恢复出厂文档", code == 200 and data.get("custom") is False
      and data.get("content") == api_docs.DEFAULT_DOCS.strip(), f"custom={data.get('custom')}")

print("\n== 2. 虚拟打印机安装包 ==")
code, _ = req("GET", "/api/downloads")
check("未登录看清单 → 401", code == 401, f"HTTP {code}")

code, data = req("GET", "/api/downloads", USER)
packages = {item["id"]: item for item in (data.get("packages") or [])}
check("清单返回三个平台", code == 200 and set(packages) == {"windows-x64", "macos", "linux"}, str(list(packages)))
win = packages.get("windows-x64", {})
check("windows-x64 已开放且服务器上有包", win.get("open") is True and win.get("ready") is True,
      f"open={win.get('open')} ready={win.get('ready')} {win.get('filename')}")
check("windows-x64 报出文件名/版本/大小/指纹",
      win.get("filename", "").endswith(".zip") and bool(win.get("version"))
      and win.get("size", 0) > 1024 * 1024 and len(win.get("sha256") or "") == 64,
      f"{win.get('filename')} v{win.get('version')} {win.get('size_text')} sha256={str(win.get('sha256'))[:12]}…")
check("macOS / Linux 仍是「暂未开放」", not packages["macos"]["open"] and not packages["linux"]["open"],
      f"macos.open={packages['macos']['open']} linux.open={packages['linux']['open']}")
check("清单里没有服务器路径（不给调用方任何路径信息）",
      not any("/" in str(item.get("filename") or "") or "\\" in str(item.get("filename") or "")
              for item in packages.values()))

code, _ = req("GET", "/api/downloads/windows-x64")
check("未登录下载 → 401", code == 401, f"HTTP {code}")
code, data = req("GET", "/api/downloads/linux", USER)
check("下载未开放的平台 → 404", code == 404, f"HTTP {code} {data.get('detail')}")
code, data = req("GET", "/api/downloads/../etc/passwd", USER)
check("乱写 id（含路径穿越）→ 404，不会去读别的文件", code == 404, f"HTTP {code}")

resp = requests.get(f"{BASE}/api/downloads/windows-x64", headers={"Authorization": f"Bearer {USER}"}, timeout=180)
body = resp.content
check("下载 windows-x64 → 200 且是 zip（PK 头）", resp.status_code == 200 and body[:4] == b"PK\x03\x04",
      f"HTTP {resp.status_code} {len(body)} 字节")
check("下载字节数 = 清单里报的大小", len(body) == win.get("size"), f"{len(body)} vs {win.get('size')}")
check("下载内容的 sha256 = 清单里的指纹",
      hashlib.sha256(body).hexdigest() == win.get("sha256"),
      hashlib.sha256(body).hexdigest()[:16] + "…")
check("响应头带了附件文件名与 no-store",
      "attachment" in (resp.headers.get("Content-Disposition") or "")
      and resp.headers.get("Cache-Control") == "no-store",
      resp.headers.get("Content-Disposition", "")[:60])

local_zip = next(iter(sorted((config.BASE_DIR.parent / "dist").glob("AntiPrintVPrinter-*.zip"),
                            key=lambda p: p.stat().st_mtime, reverse=True)), None)
if local_zip:
    check("服务器给的就是仓库 dist 里那个包（本地开发期走 dist 目录）",
          len(body) == local_zip.stat().st_size, f"{local_zip.name} {local_zip.stat().st_size} 字节")

print(f"\n结果：{PASS} 项通过，{FAIL} 项失败")
sys.exit(1 if FAIL else 0)
