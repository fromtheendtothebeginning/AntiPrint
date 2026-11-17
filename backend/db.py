# db.py — MySQL 存储层（仅用标准 pymysql：DictCursor + 手动事务）
# 约定：多步写操作一律走 tx() 事务；表结构以 TABLES 为唯一来源，建表与补列共用，避免旧库漏列。

import json
import logging
import os
import secrets
from contextlib import contextmanager
from datetime import date, datetime
from decimal import Decimal

import pymysql

import auth
import config
from constants import DELIVER, S_APPROVED, S_FAILED, S_PENDING, S_PRINTED, S_PRINTING, S_UNPAID

LOG = logging.getLogger("antiprint.db")

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
        # 头像文件名（空 = 用首字母占位）；文件在 data/avatars/ 下
        ("avatar", "VARCHAR(255) NULL"),
        # 账户余额（元）：计费账号提交任务时扣、驳回/撤回时退；DECIMAL 精确到分，避免浮点误差
        ("balance", "DECIMAL(10,2) NOT NULL DEFAULT 0"),
        # 绑定手机号（短信验证通过才写入；注册必填，老账号补绑后才能提交任务）
        ("phone", "VARCHAR(32) NULL"),
        ("phone_verified_at", "DATETIME NULL"),
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
        # 本单实际扣掉的金额（元，0 = 免费账号或已退费）：退费后清零，是「这单花了多少钱」的唯一凭据
        ("charge", "DECIMAL(10,2) NOT NULL DEFAULT 0"),
        # 支付方式：balance = 余额扣费；alipay = 即时付款（支付宝）
        ("pay_method", "VARCHAR(16) NOT NULL DEFAULT 'balance'"),
        # 即时付款对应的 payment_orders.id（余额支付为空）
        ("payment_order_id", "INT NULL"),
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
        ("print_options", "VARCHAR(255) NULL"),
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
    # 余额流水：每次扣费/退费/管理员调账都记一条，供「我的余额」页与对账使用
    "balance_logs": [
        ("id", "INT AUTO_INCREMENT PRIMARY KEY"),
        ("user_id", "INT NOT NULL"),
        ("delta", "DECIMAL(10,2) NOT NULL"),            # 正数=入账（退费/调账），负数=出账（扣费）
        ("balance_after", "DECIMAL(10,2) NOT NULL"),    # 变动后余额（便于对账，不用重算）
        ("reason", "VARCHAR(64) NOT NULL"),             # 打印扣费 / 驳回退费 / 撤回退费 / 管理员调整
        ("job_id", "INT NULL"),
        ("actor", "VARCHAR(64) NULL"),                  # 管理员调账时记是谁操作的
        ("created_at", "DATETIME NOT NULL"),
    ],
    # 充值订单：支付宝电脑网站支付下单后写一条；回调/主动查单确认后入账。
    # status: pending（待支付）/ paid（已支付并入账）/ closed（超时关闭）/ failed（支付失败）
    "payment_orders": [
        ("id", "INT AUTO_INCREMENT PRIMARY KEY"),
        ("out_trade_no", "VARCHAR(64) NOT NULL UNIQUE"),
        ("user_id", "INT NOT NULL"),
        ("amount", "DECIMAL(10,2) NOT NULL"),
        # 订单用途：recharge = 余额充值；job = 打印任务即时付款
        ("purpose", "VARCHAR(16) NOT NULL DEFAULT 'recharge'"),
        ("job_id", "INT NULL"),
        # 实际入账金额（充值含赠送；任务付款等于 amount）；老订单为空时按 amount 处理
        ("credit_amount", "DECIMAL(10,2) NULL"),
        ("channel", "VARCHAR(16) NOT NULL DEFAULT 'alipay'"),
        ("status", "VARCHAR(16) NOT NULL DEFAULT 'pending'"),
        ("provider_txn_id", "VARCHAR(64) NULL"),
        # 支付宝退款状态：'' = 未退款；refunded = 已退款；failed = 退款失败
        ("refund_status", "VARCHAR(16) NOT NULL DEFAULT ''"),
        ("refunded_at", "DATETIME NULL"),
        ("paid_at", "DATETIME NULL"),
        ("created_at", "DATETIME NOT NULL"),
        ("updated_at", "DATETIME NOT NULL"),
    ],
    # 长期 API 令牌（给 MCP / 脚本用）：只存 sha256，明文仅生成时返回一次；
    # 认证时按用户当前角色鉴权，撤销后立即失效。
    "api_tokens": [
        ("id", "INT AUTO_INCREMENT PRIMARY KEY"),
        ("user_id", "INT NOT NULL"),
        ("name", "VARCHAR(64) NOT NULL"),
        ("token_hash", "CHAR(64) NOT NULL UNIQUE"),
        ("prefix", "VARCHAR(16) NOT NULL"),
        ("created_at", "DATETIME NOT NULL"),
        ("last_used_at", "DATETIME NULL"),
        ("revoked_at", "DATETIME NULL"),
    ],
    "settings": [
        ("k", "VARCHAR(64) PRIMARY KEY"),
        ("v", "TEXT"),
    ],
}

USER_FIELDS = (
    "id", "username", "password_hash", "role", "source", "anticraft_id",
    "default_address", "default_delivery", "balance", "avatar", "phone", "phone_verified_at", "created_at",
)
JOB_FIELDS = (
    "id", "user_id", "username", "status", "address", "note", "reject_reason", "print_error",
    "agent_id", "copies", "delivery_mode", "print_options", "claimed_at", "printed_at", "finished_at",
    "charge", "pay_method", "payment_order_id", "created_at", "updated_at",
)
FILE_FIELDS = ("id", "job_id", "filename", "stored_name", "size", "sha256", "print_options", "created_at")
AGENT_FIELDS = ("id", "name", "version", "printers", "launcher", "last_seen", "created_at")
PAYMENT_FIELDS = (
    "id", "out_trade_no", "user_id", "amount", "purpose", "job_id", "credit_amount",
    "channel", "status", "provider_txn_id", "refund_status", "refunded_at",
    "paid_at", "created_at", "updated_at",
)

# settings 缺失键的默认值（agent_token 单独处理：必须落库，否则每次重启都会变）
SETTINGS_DEFAULTS = {
    "launcher": config.DEFAULT_LAUNCHER,
    "printer_name": config.DEFAULT_PRINTER,
    "copies": "1",
    "dry_run": "0",
    # 打印代理连接开关：'1' = 正常（默认），'0' = 管理员在管理设置里「断开连接」，
    # 此时代理的注册/心跳/领取/下载/回报一律 403（见 agent_api.require_agent），恢复后自动续上
    "agent_enabled": "1",
    # 每张（A4 纸）打印单价，元；计费账号提交任务时按 张数 × 单价 扣余额
    "print_price": "0.15",
    # 充值赠送比例（百分比）：50 = 充 10 元到账 15 元；0 = 不赠送
    "recharge_bonus_percent": "50",
    # 免费打印白名单（用户名，逗号分隔）：管理员/root、anticraft 账号、名单内账号不扣费
    "free_users": "",
    # 每次出纸前先打一张「任务信息页」（提交人/文件/地址/提交与打印时间），'1' = 打（默认）
    "cover_page": "1",
    "anticraft_base": "https://anticraft.top",
    "anticraft_client_id": "",
    "anticraft_client_secret": "",
    # anticraft 管理员用户名（逗号分隔）：这些账号用 anticraft 登录/绑定时本地直接给 admin
    # （anticraft 开放接口目前不返回角色，只能用名单；接口将来若回 role/is_admin 会优先采用）
    "anticraft_admin_users": "",
    # 允许发起授权的来源（Origin 白名单，逗号分隔），必须与 anticraft 后台登记的回调地址前缀一致
    "anticraft_origins": "http://127.0.0.1:8301,http://localhost:8301,http://localhost:3010,http://127.0.0.1:3010",
    # 「API 文档」页的正文（Markdown）：空 = 用 api_docs.DEFAULT_DOCS 那份出厂文档
    "api_docs_md": "",
    "api_docs_updated_at": "",
    "api_docs_updated_by": "",
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

def create_user(username, password_hash, role="user", source="local", anticraft_id=None, phone=None):
    """创建用户，返回用户 dict（含 id）。

    source: local（AntiPrint 自建）/ anticraft（anticraft 授权绑定或密码登录自动创建）；
    anticraft_id: anticraft 用户唯一 ID（授权码模式按它关联本地账号，用户名可改）；
    phone: 已通过短信验证的手机号（注册接口在调用前校验验证码）。
    """
    phone = (phone or "").strip() or None
    with tx() as cur:
        cur.execute(
            "INSERT INTO users (username, password_hash, role, source, anticraft_id, phone, phone_verified_at, created_at) "
            "VALUES (%s,%s,%s,%s,%s,%s,IF(%s IS NULL, NULL, NOW()),NOW())",
            (username, password_hash, role, source, anticraft_id, phone, phone),
        )
        user_id = cur.lastrowid
    return get_user_by_id(user_id)


def get_user_by_phone(phone):
    """按手机号取账号（绑定唯一性校验用；空号返回 None）。"""
    if not phone:
        return None
    with tx() as cur:
        cur.execute("SELECT * FROM users WHERE phone=%s", (phone,))
        row = cur.fetchone()
    return _row(row, USER_FIELDS) if row else None


def set_user_phone(user_id, phone):
    """绑定/更换手机号（接口层已校验短信验证码）。"""
    with tx() as cur:
        cur.execute(
            "UPDATE users SET phone=%s, phone_verified_at=NOW() WHERE id=%s",
            (phone, user_id),
        )


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
    """用户列表（按注册顺序），带各自任务数与**余额**，供用户管理页使用。"""
    with tx() as cur:
        cur.execute(
            "SELECT u.id, u.username, u.role, u.source, u.anticraft_id, u.balance, u.phone, "
            "  u.phone_verified_at, u.created_at, "
            "  (SELECT COUNT(*) FROM print_jobs j WHERE j.user_id = u.id) AS job_count "
            "FROM users u ORDER BY u.id"
        )
        return [_plain(row) for row in cur.fetchall()]


def set_user_avatar(user_id, avatar):
    """记录头像文件名（None/空串 = 清掉头像，回到首字母占位）"""
    with tx() as cur:
        cur.execute("UPDATE users SET avatar=%s WHERE id=%s", (avatar or None, user_id))


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


class InsufficientBalance(RuntimeError):
    """余额不足：调用方映射成 402 并提示付款（付款码待实现）"""
    def __init__(self, needed, balance):
        self.needed = needed
        self.balance = balance
        super().__init__(f"余额不足：需要 {needed} 元，当前 {balance} 元")


def create_job(
    user_id, address, note, files, delivery_mode=DELIVER, copies=1,
    print_options=None, charge=0, status=S_PENDING, pay_method="balance", deduct=True,
):
    """创建打印任务：写 print_jobs + print_job_files + 一条建单日志。

    pay_method='balance' 且 deduct=True 时，charge > 0 会在同一事务里扣余额；
    pay_method='alipay'（即时付款）时由调用方传 deduct=False，不扣余额，任务先落「待支付」，
    支付成功后再由支付回调改成「待审核」。
    """
    charge = Decimal(str(charge or 0)).quantize(Decimal("0.01"))
    deduct = bool(deduct) and pay_method == "balance"
    with tx() as cur:
        balance_after = None
        if charge > 0 and deduct:
            cur.execute(
                "UPDATE users SET balance = balance - %s WHERE id=%s AND balance >= %s",
                (charge, user_id, charge),
            )
            if cur.rowcount == 0:
                cur.execute("SELECT balance FROM users WHERE id=%s", (user_id,))
                row = cur.fetchone()
                raise InsufficientBalance(charge, (row["balance"] if row else Decimal("0")))
            cur.execute("SELECT balance FROM users WHERE id=%s", (user_id,))
            balance_after = cur.fetchone()["balance"]
        cur.execute(
            "INSERT INTO print_jobs (user_id, status, address, note, copies, delivery_mode, print_options, charge, pay_method, created_at, updated_at) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())",
            (user_id, status, address, note or None, copies, delivery_mode, print_options, charge, pay_method),
        )
        job_id = cur.lastrowid
        for item in files:
            cur.execute(
                "INSERT INTO print_job_files (job_id, filename, stored_name, size, sha256, print_options, created_at) "
                "VALUES (%s,%s,%s,%s,%s,%s,NOW())",
                (
                    job_id, item["filename"], item["stored_name"], item["size"], item["sha256"],
                    item.get("print_options"),
                ),
            )
        cur.execute("SELECT username FROM users WHERE id=%s", (user_id,))
        row = cur.fetchone()
        actor = row["username"] if row else f"user:{user_id}"
        cur.execute(
            "INSERT INTO print_jobs_logs (job_id, actor, from_status, to_status, remark, created_at) "
            "VALUES (%s,%s,%s,%s,%s,NOW())",
            (job_id, actor[:64], None, status, "创建任务（即时付款待支付）" if pay_method == "alipay" else "创建任务"),
        )
        if charge > 0 and deduct:
            cur.execute(
                "INSERT INTO balance_logs (user_id, delta, balance_after, reason, job_id, actor, created_at) "
                "VALUES (%s,%s,%s,%s,%s,%s,NOW())",
                (user_id, -charge, balance_after, "打印扣费", job_id, actor[:64]),
            )
    return get_job(job_id)


def add_balance(user_id, delta, reason, actor=None, job_id=None):
    """加/减余额并写一条流水（退费、管理员调账都走它）。

    返回 (是否成功, 变动后余额)；余额不足（扣成负数）时返回 (False, 当前余额) 且不写流水。
    """
    delta = Decimal(str(delta or 0)).quantize(Decimal("0.01"))
    if delta == 0:
        return True, get_balance(user_id)
    with tx() as cur:
        if delta < 0:
            cur.execute(
                "UPDATE users SET balance = balance + %s WHERE id=%s AND balance >= %s",
                (delta, user_id, -delta),
            )
        else:
            cur.execute("UPDATE users SET balance = balance + %s WHERE id=%s", (delta, user_id))
        if cur.rowcount == 0:
            cur.execute("SELECT balance FROM users WHERE id=%s", (user_id,))
            row = cur.fetchone()
            return False, (row["balance"] if row else Decimal("0"))
        cur.execute("SELECT balance FROM users WHERE id=%s", (user_id,))
        balance_after = cur.fetchone()["balance"]
        cur.execute(
            "INSERT INTO balance_logs (user_id, delta, balance_after, reason, job_id, actor, created_at) "
            "VALUES (%s,%s,%s,%s,%s,%s,NOW())",
            (user_id, delta, balance_after, reason[:64], job_id, (actor or None) and actor[:64]),
        )
    return True, balance_after


def get_balance(user_id):
    """当前余额（元，Decimal；用户不存在返回 0）"""
    with tx() as cur:
        cur.execute("SELECT balance FROM users WHERE id=%s", (user_id,))
        row = cur.fetchone()
    return row["balance"] if row else Decimal("0")


class RefundError(RuntimeError):
    """退款失败（如支付宝原路退款接口报错），由接口层转成中文提示。"""


def refund_job(job_id, reason, actor=None):
    """把某任务已支付的钱退回去；没付过钱则返回 0。

    - 余额支付：charge 清零 + 加回余额 + 记流水；
    - 即时付款：调用支付宝原路退款，成功后 charge 清零并标记订单已退款。

    重复调用不会重复退款（charge 已为 0 就什么都不做）。
    """
    job = get_job(job_id)
    if not job:
        return Decimal("0")
    charge = Decimal(str(job.get("charge") or 0)).quantize(Decimal("0.01"))
    if charge <= 0:
        return Decimal("0")
    if (job.get("pay_method") or "balance") == "alipay":
        return _refund_alipay_job(job, charge, reason, actor)

    with tx() as cur:
        cur.execute("SELECT user_id, charge FROM print_jobs WHERE id=%s FOR UPDATE", (job_id,))
        row = cur.fetchone()
        if not row:
            return Decimal("0")
        charge = Decimal(str(row["charge"] or 0)).quantize(Decimal("0.01"))
        if charge <= 0:
            return Decimal("0")
        user_id = row["user_id"]
        cur.execute("UPDATE print_jobs SET charge=0, updated_at=NOW() WHERE id=%s", (job_id,))
        cur.execute("UPDATE users SET balance = balance + %s WHERE id=%s", (charge, user_id))
        cur.execute("SELECT balance FROM users WHERE id=%s", (user_id,))
        balance_after = cur.fetchone()["balance"]
        cur.execute(
            "INSERT INTO balance_logs (user_id, delta, balance_after, reason, job_id, actor, created_at) "
            "VALUES (%s,%s,%s,%s,%s,%s,NOW())",
            (user_id, charge, balance_after, reason[:64], job_id, (actor or None) and actor[:64]),
        )
    return charge


def _refund_alipay_job(job, charge, reason, actor):
    """即时付款任务走支付宝原路退款（网络调用在事务外，避免长时间持锁）。"""
    import payments      # 延迟导入，避免 db ↔ payments 的模块级循环依赖

    with tx() as cur:
        cur.execute(
            "SELECT * FROM payment_orders WHERE job_id=%s AND purpose='job' AND status='paid' "
            "ORDER BY id DESC LIMIT 1",
            (job["id"],),
        )
        order = cur.fetchone()
    if not order:
        raise RefundError("未找到该任务的支付宝支付记录，无法原路退款")
    if (order.get("refund_status") or "") == "refunded":
        with tx() as cur:
            cur.execute("UPDATE print_jobs SET charge=0, updated_at=NOW() WHERE id=%s", (job["id"],))
        return Decimal("0")

    try:
        payments.refund_trade(order["out_trade_no"], charge, out_request_no=f"JOB{job['id']}")
    except Exception as exc:
        LOG.warning("任务 #%s 支付宝退款失败：%s", job["id"], exc)
        raise RefundError(f"支付宝退款失败：{exc}")

    with tx() as cur:
        cur.execute("SELECT charge FROM print_jobs WHERE id=%s FOR UPDATE", (job["id"],))
        row = cur.fetchone()
        if not row:
            return Decimal("0")
        current = Decimal(str(row["charge"] or 0)).quantize(Decimal("0.01"))
        if current <= 0:
            return Decimal("0")
        cur.execute("UPDATE print_jobs SET charge=0, updated_at=NOW() WHERE id=%s", (job["id"],))
        cur.execute(
            "UPDATE payment_orders SET refund_status='refunded', refunded_at=NOW(), updated_at=NOW() WHERE id=%s",
            (order["id"],),
        )
        cur.execute(
            "INSERT INTO print_jobs_logs (job_id, actor, from_status, to_status, remark, created_at) "
            "VALUES (%s,%s,%s,%s,%s,NOW())",
            (job["id"], str(actor or "system")[:64], job.get("status"), job.get("status"), reason[:500] or None),
        )
    return current


def list_balance_logs(user_id=None, limit=50):
    """余额流水（倒序）；user_id 为空返回全部（管理端对账用）"""
    with tx() as cur:
        if user_id is None:
            cur.execute(
                "SELECT l.*, u.username FROM balance_logs l LEFT JOIN users u ON u.id=l.user_id "
                "ORDER BY l.id DESC LIMIT %s",
                (int(limit),),
            )
        else:
            cur.execute(
                "SELECT l.*, u.username FROM balance_logs l LEFT JOIN users u ON u.id=l.user_id "
                "WHERE l.user_id=%s ORDER BY l.id DESC LIMIT %s",
                (user_id, int(limit)),
            )
        return [_plain(dict(row)) for row in cur.fetchall()]


# ── API 令牌（MCP / 脚本长期凭证）──

API_TOKEN_FIELDS = ("id", "user_id", "name", "prefix", "created_at", "last_used_at", "revoked_at")


def create_api_token(user_id, name, token_hash, prefix):
    """落库一条令牌（只存哈希），返回令牌信息（不含明文/哈希）。"""
    with tx() as cur:
        cur.execute(
            "INSERT INTO api_tokens (user_id, name, token_hash, prefix, created_at) "
            "VALUES (%s,%s,%s,%s,NOW())",
            (user_id, str(name or "")[:64] or "未命名令牌", token_hash, prefix),
        )
        token_id = cur.lastrowid
        cur.execute("SELECT * FROM api_tokens WHERE id=%s", (token_id,))
        return _row(cur.fetchone(), API_TOKEN_FIELDS)


def list_api_tokens(user_id=None):
    """令牌列表（倒序）；user_id 为空返回全部（root 用），带用户名。"""
    with tx() as cur:
        if user_id is None:
            cur.execute(
                "SELECT t.*, u.username FROM api_tokens t LEFT JOIN users u ON u.id=t.user_id "
                "ORDER BY t.id DESC"
            )
            return [_row(row, API_TOKEN_FIELDS + ("username",)) for row in cur.fetchall()]
        cur.execute("SELECT * FROM api_tokens WHERE user_id=%s ORDER BY id DESC", (user_id,))
        return [_row(row, API_TOKEN_FIELDS) for row in cur.fetchall()]


def get_user_by_api_token(token_hash):
    """按令牌哈希取用户（角色以库里最新值为准）；令牌不存在/已撤销返回 None。"""
    with tx() as cur:
        cur.execute(
            "SELECT t.id AS token_id, u.id, u.username, u.role, u.source "
            "FROM api_tokens t JOIN users u ON u.id=t.user_id "
            "WHERE t.token_hash=%s AND t.revoked_at IS NULL",
            (token_hash,),
        )
        row = cur.fetchone()
    return dict(row) if row else None


def touch_api_token(token_id):
    """记录最近使用时间（MCP 每次调用都会刷新）。"""
    with tx() as cur:
        cur.execute("UPDATE api_tokens SET last_used_at=NOW() WHERE id=%s", (token_id,))


def revoke_api_token(token_id, user_id=None):
    """撤销令牌（传 user_id 时只能撤自己的）；返回是否真的撤销了一条。"""
    sql = "UPDATE api_tokens SET revoked_at=NOW() WHERE id=%s AND revoked_at IS NULL"
    params = [token_id]
    if user_id is not None:
        sql += " AND user_id=%s"
        params.append(user_id)
    with tx() as cur:
        cur.execute(sql, tuple(params))
        return cur.rowcount > 0


# ── 充值订单（支付宝）──

def create_payment_order(user_id, amount, channel="alipay", purpose="recharge", job_id=None, credit_amount=None):
    """创建一条待支付订单，返回订单 dict（含 out_trade_no）。"""
    amount = Decimal(str(amount)).quantize(Decimal("0.01"))
    credit = Decimal(str(credit_amount if credit_amount is not None else amount)).quantize(Decimal("0.01"))
    out_trade_no = "AP" + datetime.now().strftime("%Y%m%d%H%M%S") + secrets.token_hex(4).upper()
    with tx() as cur:
        cur.execute(
            "INSERT INTO payment_orders "
            "(out_trade_no, user_id, amount, purpose, job_id, credit_amount, channel, status, created_at, updated_at) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,'pending',NOW(),NOW())",
            (out_trade_no, user_id, amount, purpose, job_id, credit, channel),
        )
        order_id = cur.lastrowid
    return get_payment_order_by_id(order_id)


def get_payment_order(out_trade_no):
    with tx() as cur:
        cur.execute("SELECT * FROM payment_orders WHERE out_trade_no=%s", (out_trade_no,))
        row = cur.fetchone()
    return _row(row, PAYMENT_FIELDS) if row else None


def get_payment_order_by_id(order_id):
    with tx() as cur:
        cur.execute("SELECT * FROM payment_orders WHERE id=%s", (order_id,))
        row = cur.fetchone()
    return _row(row, PAYMENT_FIELDS) if row else None


def mark_payment_paid(out_trade_no, provider_txn_id=None):
    """把待支付订单标记为已支付（同一事务，幂等）。

    - purpose=recharge：按 credit_amount 给用户加余额（含赠送）；
    - purpose=job：不给余额加钱，把对应打印任务从「待支付」改成「待审核」。

    返回 (order, balance_after, credited)：订单不存在返回 (None, None, False)；
    已支付过则 credited=False（不重复入账）；已关闭/失败返回 (None, None, False)。
    """
    with tx() as cur:
        cur.execute("SELECT * FROM payment_orders WHERE out_trade_no=%s FOR UPDATE", (out_trade_no,))
        row = cur.fetchone()
        if not row:
            return None, None, False
        if row["status"] == "paid":
            balance = _user_balance(cur, row["user_id"])
            return _row(row, PAYMENT_FIELDS), balance, False
        if row["status"] != "pending":
            return None, None, False

        amount = Decimal(str(row["amount"] or 0)).quantize(Decimal("0.01"))
        credit = row.get("credit_amount")
        credit = amount if credit is None else Decimal(str(credit)).quantize(Decimal("0.01"))
        purpose = row.get("purpose") or "recharge"
        cur.execute(
            "UPDATE payment_orders SET status='paid', provider_txn_id=%s, paid_at=NOW(), updated_at=NOW() "
            "WHERE id=%s",
            ((provider_txn_id or None) and str(provider_txn_id)[:64], row["id"]),
        )

        if purpose == "job":
            job_id = row.get("job_id")
            if job_id:
                cur.execute("SELECT status FROM print_jobs WHERE id=%s FOR UPDATE", (job_id,))
                job = cur.fetchone()
                if job and job["status"] == S_UNPAID:
                    cur.execute(
                        "UPDATE print_jobs SET status=%s, updated_at=NOW() WHERE id=%s",
                        (S_PENDING, job_id),
                    )
                    cur.execute(
                        "INSERT INTO print_jobs_logs (job_id, actor, from_status, to_status, remark, created_at) "
                        "VALUES (%s,%s,%s,%s,%s,NOW())",
                        (job_id, "alipay", S_UNPAID, S_PENDING, "即时付款到账，进入审核队列"),
                    )
                else:
                    LOG.warning("即时付款到账但任务 #%s 状态不是待支付：%s", job_id, job and job["status"])
            balance_after = _user_balance(cur, row["user_id"])
        else:
            cur.execute("UPDATE users SET balance = balance + %s WHERE id=%s", (credit, row["user_id"]))
            balance_after = _user_balance(cur, row["user_id"])
            reason = "支付宝充值（含赠送）" if credit > amount else "支付宝充值"
            cur.execute(
                "INSERT INTO balance_logs (user_id, delta, balance_after, reason, job_id, actor, created_at) "
                "VALUES (%s,%s,%s,%s,%s,%s,NOW())",
                (row["user_id"], credit, balance_after, reason, None, "alipay"),
            )
    return get_payment_order(out_trade_no), balance_after, True


def close_payment_order(out_trade_no):
    """关闭超时未支付订单（只允许 pending → closed）。"""
    with tx() as cur:
        cur.execute(
            "UPDATE payment_orders SET status='closed', updated_at=NOW() "
            "WHERE out_trade_no=%s AND status='pending'",
            (out_trade_no,),
        )
        return cur.rowcount > 0


def list_payment_orders(user_id=None, limit=50):
    """充值订单（倒序）；user_id 为空返回全部（管理端对账用）。"""
    with tx() as cur:
        if user_id is None:
            cur.execute(
                "SELECT p.*, u.username FROM payment_orders p LEFT JOIN users u ON u.id=p.user_id "
                "ORDER BY p.id DESC LIMIT %s",
                (int(limit),),
            )
        else:
            cur.execute(
                "SELECT p.*, u.username FROM payment_orders p LEFT JOIN users u ON u.id=p.user_id "
                "WHERE p.user_id=%s ORDER BY p.id DESC LIMIT %s",
                (user_id, int(limit)),
            )
        return [_plain(dict(row)) for row in cur.fetchall()]


def _user_balance(cur, user_id):
    cur.execute("SELECT balance FROM users WHERE id=%s", (user_id,))
    row = cur.fetchone()
    return row["balance"] if row else Decimal("0")


def set_job_payment_order(job_id, payment_order_id):
    """把即时付款任务关联到 payment_orders.id。"""
    with tx() as cur:
        cur.execute(
            "UPDATE print_jobs SET payment_order_id=%s, updated_at=NOW() WHERE id=%s",
            (payment_order_id, job_id),
        )


def clear_job_charge(job_id):
    """未支付的即时付款任务取消时清零 charge（没有真实扣款，不能留下金额痕迹）。"""
    with tx() as cur:
        cur.execute("UPDATE print_jobs SET charge=0, updated_at=NOW() WHERE id=%s", (job_id,))


def get_payment_order_by_job(job_id, pending_only=False):
    """取某任务最近一笔支付宝订单（pending_only=True 只看待支付）。"""
    sql = "SELECT * FROM payment_orders WHERE job_id=%s AND purpose='job'"
    if pending_only:
        sql += " AND status='pending'"
    sql += " ORDER BY id DESC LIMIT 1"
    with tx() as cur:
        cur.execute(sql, (job_id,))
        row = cur.fetchone()
    return _row(row, PAYMENT_FIELDS) if row else None


def mark_payment_refunded(out_trade_no):
    """标记订单已退款（用于支付成功后任务已取消等需要自动退款的兜底场景）。"""
    with tx() as cur:
        cur.execute(
            "UPDATE payment_orders SET refund_status='refunded', refunded_at=NOW(), updated_at=NOW() "
            "WHERE out_trade_no=%s",
            (out_trade_no,),
        )
        return cur.rowcount > 0


def list_unpaid_jobs_before(minutes=30):
    """列出超过指定分钟数仍「待支付」的任务（用于惰性清理）。"""
    with tx() as cur:
        cur.execute(
            f"SELECT id, user_id FROM print_jobs WHERE status=%s "
            f"AND created_at < NOW() - INTERVAL {int(minutes)} MINUTE",
            (S_UNPAID,),
        )
        return [dict(row) for row in cur.fetchall()]


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
    - 额外关键字字段（reject_reason / print_error / finished_at / printed_at / agent_id，值为 None 表示清空）与状态同事务更新；
    - 返回是否更新成功（任务不存在或状态不符返回 False）。
    """
    allowed = {"reject_reason", "print_error", "finished_at", "printed_at", "agent_id"}
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


def delete_user(user_id):
    """删除账号（护栏在接口层：余额必须为 0、不能删自己/root）。

    只删 users 这一行：**任务与余额流水保留**（任务列表 LEFT JOIN 用户名，删号后用户名显示为空，
    但打印记录与对账痕迹还在；这也是「余额为 0 才让删」的原因——钱没结清就删会丢账）。
    """
    with tx() as cur:
        cur.execute("DELETE FROM users WHERE id=%s", (user_id,))
        return cur.rowcount > 0


def sha256_in_use(sha256):
    """该内容是否还有别的文件记录在用（删任务时决定要不要清掉转换缓存）"""
    with tx() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM print_job_files WHERE sha256=%s", (sha256,))
        row = cur.fetchone()
    return bool(row and row["n"])


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
