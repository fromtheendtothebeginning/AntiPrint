# downloads.py — 「虚拟打印机」页面的安装包清单
#
# 安装包放在 backend/data/downloads/ 里（部署时由 deploy/pack.sh 上传，见那里的说明）；
# 开发期也认仓库根的 dist/（本地刚打完包就能下载，不用先拷进 data）。gitignore 已排除这两处。
#
# 只暴露白名单里的文件名模式，接口按 id 取文件 —— 不接调用方给的路径，天然没有路径穿越。

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import config

# 页面上按顺序显示的平台；available=False 的只显示「暂未开放」
PACKAGES = [
    {
        "id": "windows-x64",
        "label": "Windows（x86-64）",
        "arch": "x86-64",
        "requirements": "Windows 10 / 11 64 位",
        "note": "解压即用，单文件 exe；不需要安装 Python",
        "pattern": "AntiPrintVPrinter-*.zip",
        "exclude": ("-macos", "-linux"),      # 同一个 dist 目录里可能同时放着其它平台的包
        "available": True,
    },
    {
        "id": "macos",
        "label": "macOS（Intel / Apple Silicon）",
        "arch": "x86-64 / arm64",
        "requirements": "macOS 12 及以上",
        "note": "需要装 CUPS 队列；安装包要单独构建（PyInstaller 不能交叉编译）",
        "pattern": "AntiPrintVPrinter-*-macos.zip",
        "exclude": (),
        "available": False,
    },
    {
        "id": "linux",
        "label": "Linux（x86-64）",
        "arch": "x86-64",
        "requirements": "装了 CUPS 的发行版",
        "note": "需要装 CUPS 队列；安装包要单独构建",
        "pattern": "AntiPrintVPrinter-*-linux.zip",
        "exclude": (),
        "available": False,
    },
]

_search_dirs = (config.DOWNLOADS_DIR, config.BASE_DIR.parent / "dist")
_sha_cache: dict[tuple[str, float, int], str] = {}


def _newest(pattern: str, exclude: tuple[str, ...]) -> Path | None:
    """按文件名模式找最新的一个包（先看 data/downloads，再看仓库 dist/）"""
    for folder in _search_dirs:
        if not folder.is_dir():
            continue
        candidates = [
            path for path in folder.glob(pattern)
            if path.is_file() and not any(tag in path.name for tag in exclude)
        ]
        if candidates:
            return max(candidates, key=lambda path: path.stat().st_mtime)
    return None


def _sha256(path: Path) -> str:
    """安装包指纹（23MB 读一遍约 40ms，按 路径+mtime+大小 缓存，不重复算）"""
    key = (str(path), path.stat().st_mtime, path.stat().st_size)
    if key not in _sha_cache:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        _sha_cache.clear()
        _sha_cache[key] = digest.hexdigest()
    return _sha_cache[key]


def _version_of(name: str) -> str:
    """AntiPrintVPrinter-1.0.0.zip → 1.0.0"""
    stem = name[len("AntiPrintVPrinter-"):] if name.startswith("AntiPrintVPrinter-") else name
    return stem.split(".zip")[0].split("-")[0]


def describe() -> list[dict]:
    """给前端的安装包清单（不暴露服务器上的真实路径）"""
    items = []
    for spec in PACKAGES:
        path = _newest(spec["pattern"], spec["exclude"]) if spec["available"] else None
        ready = bool(path)
        item = {
            "id": spec["id"],
            "label": spec["label"],
            "arch": spec["arch"],
            "requirements": spec["requirements"],
            "note": spec["note"],
            "open": spec["available"],            # 是否已经开放下载
            "ready": ready,                       # 服务器上有没有这个包
            "filename": path.name if path else "",
            "version": _version_of(path.name) if path else "",
            "size": path.stat().st_size if path else 0,
            "sha256": _sha256(path) if path else "",
            "updated_at": int(path.stat().st_mtime) if path else 0,
        }
        items.append(item)
    return items


def find(package_id: str) -> tuple[Path, dict] | None:
    """按 id 取安装包；未开放 / 服务器上还没放包时返回 None"""
    spec = next((item for item in PACKAGES if item["id"] == package_id and item["available"]), None)
    if not spec:
        return None
    path = _newest(spec["pattern"], spec["exclude"])
    return (path, spec) if path else None


def human_size(size: int) -> str:
    if size >= 1024 * 1024:
        return f"{size / 1048576:.1f} MB"
    if size >= 1024:
        return f"{size / 1024:.0f} KB"
    return f"{size} B"
