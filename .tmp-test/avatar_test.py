"""头像接口测试：上传/读取/移除 + 类型与大小校验。

用法：backend\\.venv\\Scripts\\python.exe .tmp-test/avatar_test.py
"""
import sys
import time

import requests

BASE = "http://127.0.0.1:8301"
PNG = ".tmp-test/test-image.png"
PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("  [PASS] " if cond else "  [FAIL] ") + name + (f"  {extra}" if extra else ""))


tag = str(int(time.time()))[-6:]
reg = requests.post(f"{BASE}/api/register", json={"username": "avatar" + tag, "password": "Test123456"}, timeout=20).json()
UT = reg["token"]
UID = reg["user"]["id"]
H = {"Authorization": "Bearer " + UT}
other = requests.post(f"{BASE}/api/register", json={"username": "avatar2" + tag, "password": "Test123456"}, timeout=20).json()
OH = {"Authorization": "Bearer " + other["token"]}

with open(PNG, "rb") as fh:
    png = fh.read()

print("\n1. 默认没有头像")
prof = requests.get(f"{BASE}/api/profile", headers=H, timeout=20).json()["profile"]
check("profile.avatar 为空串", prof.get("avatar") == "", repr(prof.get("avatar")))
check("读取头像 → 404", requests.get(f"{BASE}/api/users/{UID}/avatar", headers=H, timeout=20).status_code == 404, "")

print("\n2. 上传头像")
r = requests.post(f"{BASE}/api/profile/avatar", headers=H, files={"file": ("me.png", png, "image/png")}, timeout=30)
check("上传 png 成功且回 profile", r.status_code == 200 and r.json()["profile"]["avatar"], f"{r.status_code} {str(r.text)[:60]}")
stored = r.json()["profile"]["avatar"] if r.status_code == 200 else ""
check("落库文件名带 user_id 前缀", stored.startswith(f"{UID}-"), stored)
r = requests.get(f"{BASE}/api/users/{UID}/avatar", headers=H, timeout=20)
check("能读回同一张图（字节一致）", r.status_code == 200 and r.content == png, f"{r.status_code} {len(r.content)}B")
check("响应是图片类型且 nosniff", r.headers.get("content-type", "").startswith("image/") and r.headers.get("x-content-type-options") == "nosniff", r.headers.get("content-type"))
check("别人也能看（登录即可）", requests.get(f"{BASE}/api/users/{UID}/avatar", headers=OH, timeout=20).status_code == 200, "")
check("未登录看不了 → 401", requests.get(f"{BASE}/api/users/{UID}/avatar", timeout=20).status_code == 401, "")

print("\n3. 更换头像：文件名变了、旧的被删")
first = stored
r = requests.post(f"{BASE}/api/profile/avatar", headers=H, files={"file": ("me2.png", png, "image/png")}, timeout=30)
second = r.json()["profile"]["avatar"]
check("换头像后文件名不同（免缓存）", second != first, f"{first} → {second}")
import pathlib

check("旧文件已删除", not (pathlib.Path("backend/data/avatars") / first).exists(), first)
check("新文件存在", (pathlib.Path("backend/data/avatars") / second).exists(), second)

print("\n4. 校验：类型与大小")
for name, blob, mime, label in (
    ("evil.pdf", b"%PDF-1.4\n", "application/pdf", "pdf"),
    ("evil.exe", b"MZ\x90\x00", "application/octet-stream", "exe"),
    ("fake.png", b"this is not a real image" * 10, "image/png", "改了后缀的假图片"),
):
    r = requests.post(f"{BASE}/api/profile/avatar", headers=H, files={"file": (name, blob, mime)}, timeout=30)
    check(f"{label} → 400", r.status_code == 400, f"{r.status_code} {r.json().get('detail', '')[:40]}")
r = requests.post(f"{BASE}/api/profile/avatar", headers=H,
                  files={"file": ("big.png", png + b"0" * (2 * 1024 * 1024), "image/png")}, timeout=60)
check("超过 2MB → 400", r.status_code == 400, f"{r.status_code} {r.json().get('detail', '')[:40]}")
check("未登录上传 → 401", requests.post(f"{BASE}/api/profile/avatar", files={"file": ("a.png", png, "image/png")}, timeout=20).status_code == 401, "")
check("校验失败不影响已有头像", requests.get(f"{BASE}/api/users/{UID}/avatar", headers=H, timeout=20).status_code == 200, "")

print("\n5. 移除头像")
r = requests.delete(f"{BASE}/api/profile/avatar", headers=H, timeout=20)
check("移除成功且 avatar 清空", r.status_code == 200 and r.json()["profile"]["avatar"] == "", f"{r.status_code} {str(r.text)[:50]}")
check("文件已删除", not (pathlib.Path("backend/data/avatars") / second).exists(), second)
check("再读 → 404", requests.get(f"{BASE}/api/users/{UID}/avatar", headers=H, timeout=20).status_code == 404, "")
check("重复移除也不报错", requests.delete(f"{BASE}/api/profile/avatar", headers=H, timeout=20).status_code == 200, "")

print("\n=== 结果 ===")
print(f"通过 {len(PASS)} 项，失败 {len(FAIL)} 项")
for name in FAIL:
    print("  - 失败：" + name)
sys.exit(1 if FAIL else 0)
