"""服务器上创建/更新管理员账号，并封堵播种的默认 admin（部署辅助脚本，不含任何凭据）。

用法（在服务器上，用户名与口令从标准输入传入，避免出现在命令行/历史里）：
    printf 'end\n<口令>\n' | /var/www/antiprint/backend/.venv/bin/python server_create_admin.py
"""
import secrets
import sys

sys.path.insert(0, "/var/www/antiprint/backend")

import auth  # noqa: E402
import db  # noqa: E402

name = (sys.stdin.readline() or "").strip()
password = (sys.stdin.readline() or "").strip()
if not name or len(password) < 6:
    sys.exit("用法：printf '用户名\\n口令\\n' | python server_create_admin.py（口令至少 6 位）")

db.ensure_database()
db.init_db()
db.run_migrations()

user = db.get_user_by_name(name)
if user:
    db.set_user_password(user["id"], auth.hash_password(password))
    with db.tx() as cur:
        cur.execute("UPDATE users SET role='admin', source='local' WHERE id=%s", (user["id"],))
    print(f"已把既有账号 {name} 设为管理员并重设口令")
else:
    db.create_user(name, auth.hash_password(password), "admin", "local")
    print(f"已创建管理员账号 {name}")

seed = db.get_user_by_name("admin")
if seed and name != "admin" and auth.verify_password("admin123", seed["password_hash"]):
    db.set_user_password(seed["id"], auth.hash_password(secrets.token_urlsafe(24)))
    print("已把默认账号 admin 的口令改为随机值（admin123 不再可用）")

with db.tx() as cur:
    cur.execute("SELECT username, role, source FROM users ORDER BY id")
    print("当前账号：", [(r["username"], r["role"], r["source"]) for r in cur.fetchall()])
