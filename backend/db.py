# db.py — MySQL 存储层（仅用标准 pymysql：DictCursor + 手动事务）
# 约定：多步写操作一律走 tx() 事务；表结构以 TABLES 为唯一来源，建表与补列共用，避免旧库漏列。

import json
import os
import secrets
from contextlib import contextmanager
from datetime import date, datetime
from decimal import Decimal

import pymysql

import auth
import config
from constants import DELIVER, S_APPROVED, S_FAILED, S_PENDING, S_PRINTED, S_PRINTING

# ── 表结构（列名/类型/默认值严格固定）──
# 建表与 run_migrations 共用同一份定义：CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，
# 新增列只需加在这里，run_migrations 会自动 ALTER TABLE 补上（index 反复踩过漏列的坑）。
TABLES = {
    "users": [
        ("id", "INT AUTO_INCREMENT PRIMARY KEY"),
        ("username", "VARCHAR(64) NOT NULL UNIQUE"),
        ("password_hash", "VARCHAR(255) NOT NULL"),
        ("role", "VARCHAR(16) NOT NULL DEFAULT 'user'"),
        ("source", "VARCHAR(16) NOT NULL DEFAULT 'local'"),
        ("anticraft_id", "INT NULL"),
        ("default_address", "VARCHAR(255) NULL"),
        ("default_delivery", "VARCHAR(8) NOT NULL DEFAULT '配送'"),
        ("created_at", "DATETIME NOT NULL"),
    ],
    "print_jobs": [
        ("id", "INT AUTO_INCREMENT PRIMARY KEY"),
        ("user_id", "INT NOT NULL"),
        ("status", f"VARCHAR(16) NOT NULL DEFAULT '{S_PENDING}'"),
        ("address", "VARCHAR(255) NOT NULL"),
        ("note", "VARCHAR(500) NULL"),
        ("reject_reason", "VARCHAR(500) NULL"),
        ("print_error", "VARCHAR(500) NULL"),
        ("agent_id", "INT NULL"),
        ("copies", "INT NOT NULL DEFAULT 1"),
        ("delivery_mode", "VARCHAR(8) NOT NULL DEFAULT '配送'"),
        ("print_options", "VARCHAR(255) NULL"),
        ("claimed_at", "DATETIME NULL"),
        ("printed_at", "DATETIME NULL"),
        ("finished_at", "DATETIME NULL"),
        ("created_at", "DATETIME NOT NULL"),
        ("updated_at", "DATETIME NOT NULL"),
    ],
    "print_job_files": [
        ("id", "INT AUTO_INCREMENT PRIMARY KEY"),
        ("job_id", "INT NOT NULL"),
        ("filename", "VARCHAR(255) NOT NULL"),
        ("stored_name", "VARCHAR(255) NOT NULL"),
        ("size", "INT NOT NULL"),
        ("sha256", "CHAR(64) NOT NULL"),
        ("created_at", "DATETIME NOT NULL"),
    ],
    "print_jobs_logs": [
        ("id", "INT AUTO_INCREMENT PRIMARY KEY"),
        ("job_id", "INT NOT NULL"),
        ("actor", "VARCHAR(64) NOT NULL"),
        ("from_status", "VARCHAR(16) NULL"),
        ("to_status", "VARCHAR(16) NOT NULL"),
        ("remark", "VARCHAR(500) NULL"),
        ("created_at", "DATETIME NOT NULL"),
    ],
    "agents": [
        ("id", "INT AUTO_INCREMENT PRIMARY KEY"),
        ("name", "VARCHAR(64) NOT NULL UNIQUE"),
        ("version", "VARCHAR(32) NULL"),
        ("printers", "TEXT NULL"),
        ("launcher", "VARCHAR(255) NULL"),
        ("last_seen", "DATETIME NULL"),
        ("created_at", "DATETIME NOT NULL"),
    ],
    "settings": [
        ("k", "VARCHAR(64) PRIMARY KEY"),
        ("v", "TEXT"),
    ],
}

USER_FIELDS = (
    "id", "username", "password_hash", "role", "source", "anticraft_id",
    "default_address", "default_delivery", "created_at",
)
JOB_FIELDS = (
    "id", "user_id", "username", "status", "address", "note", "reject_reason", "print_error",
    "agent_id", "copies", "delivery_mode", "print_options", "claimed_at", "printed_at", "finished_at",
    "created_at", "updated_at",
)
FILE_FIELDS = ("id", "job_id", "filename", "stored_name", "size", "sha256", "created_at")
AGENT_FIELDS = ("id", "name", "version", "printers", "launcher", "last_seen", "created_at")

# settings 缺失键的默认值（agent_token 单独处理：必须落库，否则每次重启都会变）
SETTINGS_DEFAULTS = {
    "launcher": config.DEFAULT_LAUNCHER,
    "printer_name": config.DEFAULT_PRINTER,
    "copies": "1",
    "dry_run": "0",
    "anticraft_base": "https://anticraft.top",
    "anticraft_client_id": "",
    "anticraft_client_secret": "",
    # anticraft 管理员用户名（逗号分隔）：这些账号用 anticraft 登录/绑定时本地直接给 admin
    # （anticraft 开放接口目前不返回角色，只能用名单；接口将来若回 role/is_admin 会优先采用）
    "anticraft_admin_users": "",
    # 允许发起授权的来源（Origin 白名单，逗号分隔），必须与 anticraft 后台登记的回调地址前缀一致
    "anticraft_origins": "http://127.0.0.1:8301,http://localhost:8301,http://localhost:3010,http://127.0.0.1:3010",
}


# ── 连接与事务 ──

def get_conn(database=config.DB):
    """新建连接：默认连 config.DB；database=None 时不指定库（建库用）。"""
    kwargs = dict(config.DB_CONFIG)
    kwargs["autocommit"] = False
    if database is not None:
        kwargs["database"] = database
    return pymysql.connect(**kwargs)


@contextmanager
def tx():
    """事务上下文：正常提交，异常回滚，最后关闭连接。"""
    conn = get_conn()
    try:
        cur = conn.cursor(pymysql.cursors.DictCursor)
        try:
            yield cur
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()
    finally:
        conn.close()


# ── 建库 / 建表 / 补列 / 播种 ──

def ensure_database():
    """建库：不指定默认库连接，CREATE DATABASE IF NOT EXISTS（utf8mb4）。"""
    conn = get_conn(database=None)
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"CREATE DATABASE IF NOT EXISTS `{config.DB}` DEFAULT CHARACTER SET utf8mb4"
            )
        conn.commit()
    finally:
        conn.close()


def init_db():
    """建表（若不存在）——列定义来自 TABLES 表结构定义。"""
    with tx() as cur:
        for table, columns in TABLES.items():
            ddl = ", ".join(f"`{name}` {definition}" for name, definition in columns)
            cur.execute(
                f"CREATE TABLE IF NOT EXISTS `{table}` ({ddl}) "
                "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
            )


def run_migrations():
    """对已存在的旧表补列（CREATE TABLE IF NOT EXISTS 不会给旧表加列）。"""
    with tx() as cur:
        for table, columns in TABLES.items():
            for name, definition in columns:
                if name == "id":
                    continue    # 主键列不参与补列
                cur.execute(
                    "SELECT COUNT(*) AS n FROM information_schema.COLUMNS "
                    "WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s AND COLUMN_NAME=%s",
                    (config.DB, table, name),
                )
                if cur.fetchone()["n"] == 0:
                    cur.execute(f"ALTER TABLE `{table}` ADD COLUMN `{name}` {definition}")


def seed_admin():
    """无 admin 用户时创建 admin/admin123（ADMIN_PASSWORD 可覆盖）；并确保设置默认值与代理令牌已生成。"""
    if get_user_by_name("admin") is None:
        password = os.environ.get("ADMIN_PASSWORD", "admin123")
        create_user("admin", auth.hash_password(password), "admin")
    get_settings()      # 补齐 settings 默认值，并首次生成 agent_token 落库


# ── 行转换 ──

def _plain(value):
    """datetime/Decimal → JSON 友好类型"""
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat(timespec="seconds")
    return value


def _row(row, fields):
    return {k: _plain(row[k]) for k in fields if k in row}


# ── users ──

def create_user(username, password_hash, role="user", source="local", anticraft_id=None):
    """创建用户，返回用户 dict（含 id）。

    source: local（AntiPrint 自建）/ anticraft（anticraft 授权绑定或密码登录自动创建）；
    anticraft_id: anticraft 用户唯一 ID（授权码模式按它关联本地账号，用户名可改）。
    """
    with tx() as cur:
        cur.execute(
            "INSERT INTO users (username, password_hash, role, source, anticraft_id, created_at) "
            "VALUES (%s,%s,%s,%s,%s,NOW())",
            (username, password_hash, role, source, anticraft_id),
        )
        user_id = cur.lastrowid
    return get_user_by_id(user_id)


def get_user_by_anticraft_id(anticraft_id):
    """按 anticraft 用户 ID 取本地账号（授权登录的主键，用户名变了也能认出来）。"""
    with tx() as cur:
        cur.execute("SELECT * FROM users WHERE anticraft_id=%s", (anticraft_id,))
        row = cur.fetchone()
    return _row(row, USER_FIELDS) if row else None


def bind_anticraft(user_id, anticraft_id):
    """把本地账号绑定到 anticraft 用户 ID（重复授权不报错，直接覆盖为最新 ID）。"""
    with tx() as cur:
        cur.execute(
            "UPDATE users SET anticraft_id=%s, source='anticraft' WHERE id=%s",
            (anticraft_id, user_id),
        )


def set_user_password(user_id, password_hash):
    """更新密码哈希（anticraft 密码登录时同步为 anticraft 侧的密码，保证两者一致）。"""
    with tx() as cur:
        cur.execute("UPDATE users SET password_hash=%s WHERE id=%s", (password_hash, user_id))


def set_user_role(user_id, role):
    """设置用户角色（用于 root 提拔/降级，以及 anticraft 管理员自动提权）。"""
    with tx() as cur:
        cur.execute("UPDATE users SET role=%s WHERE id=%s", (role, user_id))


def list_users():
    """用户列表（按注册顺序），带各自任务数，供用户管理页使用。"""
    with tx() as cur:
        cur.execute(
            "SELECT u.id, u.username, u.role, u.source, u.anticraft_id, u.created_at, "
            "  (SELECT COUNT(*) FROM print_jobs j WHERE j.user_id = u.id) AS job_count "
            "FROM users u ORDER BY u.id"
        )
        return [_plain(row) for row in cur.fetchall()]


def set_user_profile(user_id, default_address, default_delivery):
    """保存用户配置：默认配送地址与默认配送方式（提交页据此预填）。"""
    with tx() as cur:
        cur.execute(
            "UPDATE users SET default_address=%s, default_delivery=%s WHERE id=%s",
            (default_address or None, default_delivery, user_id),
        )


def unbind_anticraft(user_id, password_hash):
    """解除 anticraft 绑定，同时设置本地密码。

    授权建号的账号没有可用本地密码，若只清绑定会直接把自己锁在门外，
    因此解绑必须同时落一个新密码（由接口层要求用户填写）。
    """
    with tx() as cur:
        cur.execute(
            "UPDATE users SET anticraft_id=NULL, source='local', password_hash=%s WHERE id=%s",
            (password_hash, user_id),
        )


def get_user_by_name(username):
    with tx() as cur:
        cur.execute("SELECT * FROM users WHERE username=%s", (username,))
        row = cur.fetchone()
    return _row(row, USER_FIELDS) if row else None


def get_user_by_id(user_id):
    with tx() as cur:
        cur.execute("SELECT * FROM users WHERE id=%s", (user_id,))
        row = cur.fetchone()
    return _row(row, USER_FIELDS) if row else None


# ── print_jobs / print_job_files / print_jobs_logs ──

def _load_files(cur, job_ids):
    """批量取任务文件，返回 {job_id: [file, ...]}"""
    if not job_ids:
        return {}
    placeholders = ",".join(["%s"] * len(job_ids))
    cur.execute(
        f"SELECT * FROM print_job_files WHERE job_id IN ({placeholders}) ORDER BY id ASC",
        tuple(job_ids),
    )
    grouped = {}
    for row in cur.fetchall():
        grouped.setdefault(row["job_id"], []).append(_row(row, FILE_FIELDS))
    return grouped


def create_job(user_id, address, note, files, delivery_mode=DELIVER, copies=1, print_options=None):
    """创建打印任务：写 print_jobs + print_job_files + 一条建单日志。

    files 为已落盘的元数据列表：[{filename, stored_name, size, sha256}, ...]
    delivery_mode: 配送 / 取件（取件时 address 可为空串）
    copies: 份数（同时写进 copies 列与 print_options，代理侧直接用 print_options 拼命令行）
    print_options: 打印设置的 JSON 文本（双面/纸张/页面范围/每面页数/缩放），可为 None
    """
    with tx() as cur:
        cur.execute(
            "INSERT INTO print_jobs (user_id, status, address, note, copies, delivery_mode, print_options, created_at, updated_at) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())",
            (user_id, S_PENDING, address, note or None, copies, delivery_mode, print_options),
        )
        job_id = cur.lastrowid
        for item in files:
            cur.execute(
                "INSERT INTO print_job_files (job_id, filename, stored_name, size, sha256, created_at) "
                "VALUES (%s,%s,%s,%s,%s,NOW())",
                (job_id, item["filename"], item["stored_name"], item["size"], item["sha256"]),
            )
        cur.execute("SELECT username FROM users WHERE id=%s", (user_id,))
        row = cur.fetchone()
        actor = row["username"] if row else f"user:{user_id}"
        cur.execute(
            "INSERT INTO print_jobs_logs (job_id, actor, from_status, to_status, remark, created_at) "
            "VALUES (%s,%s,%s,%s,%s,NOW())",
            (job_id, actor[:64], None, S_PENDING, "创建任务"),
        )
    return get_job(job_id)


def list_jobs(user_id=None):
    """任务列表（倒序）；每个任务带 files 列表。user_id 为空返回全部（管理员用）。

    JOIN users 带上提交人用户名，管理页「提交人」列直接展示（username 可为空：用户被删）。
    """
    with tx() as cur:
        if user_id is None:
            cur.execute(
                "SELECT j.*, u.username FROM print_jobs j LEFT JOIN users u ON u.id=j.user_id "
                "ORDER BY j.id DESC"
            )
        else:
            cur.execute(
                "SELECT j.*, u.username FROM print_jobs j LEFT JOIN users u ON u.id=j.user_id "
                "WHERE j.user_id=%s ORDER BY j.id DESC",
                (user_id,),
            )
        jobs = [_row(row, JOB_FIELDS) for row in cur.fetchall()]
        files = _load_files(cur, [job["id"] for job in jobs])
    for job in jobs:
        job["files"] = files.get(job["id"], [])
    return jobs


def get_job(job_id):
    """单个任务（含 files 与提交人用户名），不存在返回 None。"""
    with tx() as cur:
        cur.execute(
            "SELECT j.*, u.username FROM print_jobs j LEFT JOIN users u ON u.id=j.user_id WHERE j.id=%s",
            (job_id,),
        )
        row = cur.fetchone()
        if not row:
            return None
        job = _row(row, JOB_FIELDS)
        job["files"] = _load_files(cur, [job["id"]]).get(job["id"], [])
    return job


def set_status(job_id, to_status, actor, remark=None, from_status=None, **fields):
    """状态流转（必须写 print_jobs_logs 留痕），并维护 updated_at。

    - from_status 非空时作为乐观锁：仅当前状态一致才更新（防并发重复操作）；
    - 额外关键字字段（reject_reason / print_error / finished_at，值为 None 表示清空）与状态同事务更新；
    - 返回是否更新成功（任务不存在或状态不符返回 False）。
    """
    allowed = {"reject_reason", "print_error", "finished_at"}
    with tx() as cur:
        cur.execute("SELECT status FROM print_jobs WHERE id=%s", (job_id,))
        row = cur.fetchone()
        if not row:
            return False
        if from_status is not None and row["status"] != from_status:
            return False
        sets = ["status=%s", "updated_at=NOW()"]
        params = [to_status]
        for key, value in fields.items():
            if key in allowed:
                sets.append(f"`{key}`=%s")
                params.append(value)
        cur.execute(f"UPDATE print_jobs SET {', '.join(sets)} WHERE id=%s", params + [job_id])
        cur.execute(
            "INSERT INTO print_jobs_logs (job_id, actor, from_status, to_status, remark, created_at) "
            "VALUES (%s,%s,%s,%s,%s,NOW())",
            (job_id, str(actor)[:64], row["status"], to_status, (remark or "")[:500] or None),
        )
    return True


def _agent_actor(cur, agent_id):
    """流转日志的操作者：agent:<名称>（未注册则记 agent）"""
    if agent_id:
        cur.execute("SELECT name FROM agents WHERE id=%s", (agent_id,))
        row = cur.fetchone()
        if row:
            return f"agent:{row['name']}"[:64]
    return "agent"


def claim_next_job(agent_id=None):
    """原子领取最早的一个「已通过」任务（防多代理重复打印）。

    先取候选 id，再用带 status='已通过' 条件的 UPDATE 抢占：影响行数 1 才算领到，
    0 表示已被别的代理领走 → 返回 None。成功后写流转日志并回读任务（含 files）。
    """
    with tx() as cur:
        cur.execute("SELECT id FROM print_jobs WHERE status=%s ORDER BY id LIMIT 1", (S_APPROVED,))
        row = cur.fetchone()
        if not row:
            return None
        job_id = row["id"]
        cur.execute(
            "UPDATE print_jobs SET status=%s, agent_id=%s, claimed_at=NOW(), updated_at=NOW() "
            "WHERE id=%s AND status=%s",
            (S_PRINTING, agent_id, job_id, S_APPROVED),
        )
        if cur.rowcount != 1:
            return None
        cur.execute(
            "INSERT INTO print_jobs_logs (job_id, actor, from_status, to_status, remark, created_at) "
            "VALUES (%s,%s,%s,%s,%s,NOW())",
            (job_id, _agent_actor(cur, agent_id), S_APPROVED, S_PRINTING, "打印代理领取任务"),
        )
    return get_job(job_id)


def finish_job(job_id, ok, error=None):
    """代理回报打印结果：成功 → 已打印（写 printed_at、清 print_error）；
    失败 → 打印失败（print_error 记错误摘要，remark 同步写入日志）。返回任务 dict。"""
    with tx() as cur:
        cur.execute("SELECT status, agent_id FROM print_jobs WHERE id=%s", (job_id,))
        row = cur.fetchone()
        if not row:
            return None
        actor = _agent_actor(cur, row["agent_id"])
        remark = (error or "").strip()[:500] or None
        if ok:
            cur.execute(
                "UPDATE print_jobs SET status=%s, printed_at=NOW(), print_error=NULL, updated_at=NOW() "
                "WHERE id=%s",
                (S_PRINTED, job_id),
            )
            cur.execute(
                "INSERT INTO print_jobs_logs (job_id, actor, from_status, to_status, remark, created_at) "
                "VALUES (%s,%s,%s,%s,%s,NOW())",
                (job_id, actor, row["status"], S_PRINTED, remark or "打印成功"),
            )
        else:
            message = remark or "打印失败（代理未返回错误详情）"
            cur.execute(
                "UPDATE print_jobs SET status=%s, print_error=%s, updated_at=NOW() WHERE id=%s",
                (S_FAILED, message, job_id),
            )
            cur.execute(
                "INSERT INTO print_jobs_logs (job_id, actor, from_status, to_status, remark, created_at) "
                "VALUES (%s,%s,%s,%s,%s,NOW())",
                (job_id, actor, row["status"], S_FAILED, message),
            )
    return get_job(job_id)


def delete_job(job_id):
    """删除任务及其文件记录与流转日志（上传目录由调用方清理）。"""
    with tx() as cur:
        cur.execute("DELETE FROM print_jobs WHERE id=%s", (job_id,))
        cur.execute("DELETE FROM print_job_files WHERE job_id=%s", (job_id,))
        cur.execute("DELETE FROM print_jobs_logs WHERE job_id=%s", (job_id,))


# ── agents ──

def _row_agent(row):
    data = _row(row, AGENT_FIELDS)
    raw = data.get("printers")
    try:
        data["printers"] = json.loads(raw) if raw else []
    except (json.JSONDecodeError, TypeError):
        data["printers"] = []
    if not isinstance(data["printers"], list):
        data["printers"] = []
    return data


def upsert_agent(name, version=None, printers=None, launcher=None):
    """注册/心跳：按 name 插入或更新并刷新 last_seen，返回代理 dict。"""
    printers_json = json.dumps(list(printers or []), ensure_ascii=False)[:4000]
    with tx() as cur:
        cur.execute(
            "INSERT INTO agents (name, version, printers, launcher, last_seen, created_at) "
            "VALUES (%s,%s,%s,%s,NOW(),NOW()) "
            "ON DUPLICATE KEY UPDATE version=VALUES(version), printers=VALUES(printers), "
            "launcher=VALUES(launcher), last_seen=VALUES(last_seen)",
            (name, version, printers_json, launcher),
        )
        cur.execute("SELECT * FROM agents WHERE name=%s", (name,))
        row = cur.fetchone()
    return _row_agent(row) if row else None


def list_agents():
    """代理列表：最近心跳在前（代理令牌全局唯一，claim 取第一个作为操作者）。"""
    with tx() as cur:
        cur.execute("SELECT * FROM agents ORDER BY last_seen IS NULL, last_seen DESC, id DESC")
        return [_row_agent(row) for row in cur.fetchall()]


# ── settings（k/v 字符串）──

def get_settings():
    """全部设置：缺失键用默认值补齐（agent_token 首次生成后落库，保证稳定不变）。"""
    with tx() as cur:
        cur.execute("SELECT k, v FROM settings")
        data = {row["k"]: row["v"] for row in cur.fetchall()}
    missing = {}
    for key, default in SETTINGS_DEFAULTS.items():
        if not data.get(key):
            data[key] = default
            missing[key] = default
    if not data.get("agent_token"):
        token = secrets.token_hex(16)
        data["agent_token"] = token
        missing["agent_token"] = token
    if missing:
        set_settings(missing)   # 只补写缺失项，不覆盖已有配置
    return data


def set_settings(values):
    """批量写设置（存在则覆盖）。"""
    with tx() as cur:
        for key, value in (values or {}).items():
            cur.execute(
                "INSERT INTO settings (k, v) VALUES (%s,%s) ON DUPLICATE KEY UPDATE v=VALUES(v)",
                (str(key)[:64], None if value is None else str(value)),
            )
