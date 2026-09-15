# config.py — 全局配置：数据库连接 / 上传限制 / 目录 / 监听地址
# 数据库凭据默认读 backend/db_config.json（已 gitignore），环境变量 MYSQL_* 优先（部署用）。

import json
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DB_CONFIG_FILE = BASE_DIR / "db_config.json"
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"      # 上传文件落盘根目录：uploads/<job_id>/<stored_name>
CONVERTED_DIR = DATA_DIR / "converted"  # Office 转 PDF 缓存：converted/<sha256>.pdf（内容寻址，见 convert.py）
AVATAR_DIR = DATA_DIR / "avatars"      # 用户头像：avatars/<user_id>-<时间戳>.<扩展名>（换头像即换文件名，天然免缓存）
COVER_DIR = DATA_DIR / "covers"        # 任务信息页（封面页）的中间产物与 PDF：covers/job-<id>-<时间>.pdf
LOG_DIR = BASE_DIR / "log"             # 日志目录：log/server.log
DIST_DIR = BASE_DIR.parent / "frontend" / "dist"   # 前端构建产物（生产由 FastAPI 静态托管）

# 监听地址：本机回环；生产由 nginx 反代到 127.0.0.1:8301
HOST = "127.0.0.1"
PORT = 8301

VERSION = "0.1.0"

# 上传限制：单文件 10MB、单任务最多 5 个文件
MAX_FILE_MB = 10
MAX_FILE_SIZE = MAX_FILE_MB * 1024 * 1024
MAX_FILES = 5

# Office（Word/PPT）转 PDF 的单次超时（秒）：LibreOffice 首次启动较慢，给足余量
CONVERT_TIMEOUT = 180

# 默认库名（可用 MYSQL_DB 或 db_config.json 的 db 字段覆盖）
DEFAULT_DB = "antiprint"

# 代理心跳在 90 秒内视为在线
AGENT_ONLINE_SECONDS = 90

# settings 表缺失键的默认值（下发给打印代理）
DEFAULT_LAUNCHER = "sumatra"
DEFAULT_PRINTER = "HP LaserJet Professional P1106"

# 开发期允许的前端跨域来源（Vite 3010）
CORS_ORIGINS = ["http://localhost:3010", "http://127.0.0.1:3010"]

# 目录在导入时创建，避免 pythonw 下写日志/上传时目录不存在
LOG_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
CONVERTED_DIR.mkdir(parents=True, exist_ok=True)
AVATAR_DIR.mkdir(parents=True, exist_ok=True)
COVER_DIR.mkdir(parents=True, exist_ok=True)


def _load_db_config():
    """读 db_config.json（utf-8-sig 兼容 BOM）；文件缺失/损坏时退回本机默认值。"""
    raw = {}
    if DB_CONFIG_FILE.exists():
        try:
            raw = json.loads(DB_CONFIG_FILE.read_text(encoding="utf-8-sig"))
        except (json.JSONDecodeError, OSError):
            raw = {}
    if not isinstance(raw, dict):
        raw = {}
    return {
        "host": os.environ.get("MYSQL_HOST", raw.get("host", "127.0.0.1")),
        "port": int(os.environ.get("MYSQL_PORT", raw.get("port", 3306))),
        "user": os.environ.get("MYSQL_USER", raw.get("user", "root")),
        "password": os.environ.get("MYSQL_PASSWORD", raw.get("password", "")),
        "db": os.environ.get("MYSQL_DB") or raw.get("db") or DEFAULT_DB,
    }


_cfg = _load_db_config()

# PyMySQL 连接参数（charset 固定 utf8mb4 以支持中文状态与文件名）
DB_CONFIG = {
    "host": _cfg["host"],
    "port": _cfg["port"],
    "user": _cfg["user"],
    "password": _cfg["password"],
    "charset": "utf8mb4",
    "connect_timeout": 5,
}

DB = _cfg["db"]


def upload_path(job_id, stored_name):
    """拼接上传文件的绝对路径并校验未越出 uploads/<job_id>/（防目录穿越）。

    路径只允许由数据库里的 stored_name 拼接；非法（含路径分隔符或越界）返回 None。
    """
    stored_name = str(stored_name or "")
    if not stored_name or os.path.basename(stored_name) != stored_name:
        return None
    job_dir = os.path.realpath(os.path.join(str(UPLOAD_DIR), str(job_id)))
    path = os.path.realpath(os.path.join(job_dir, stored_name))
    if os.path.dirname(path) != job_dir:
        return None
    return path
