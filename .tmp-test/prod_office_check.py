"""线上 Office 转 PDF 冒烟验证（临时脚本）：提交 docx → 预览是 PDF → 删除任务。

口令从环境变量 PROD_ADMIN_PW 读；只打印结论，不打印口令。
用法：PROD_ADMIN_PW=... backend\.venv\Scripts\python.exe .tmp-test/prod_office_check.py
"""
import os
import sys

import requests

BASE = "http://47.100.125.150"
PW = os.environ.get("PROD_ADMIN_PW", "")
DOCX = ".tmp-test/test-word.docx"
ok = True


def check(name, cond, extra=""):
    global ok
    ok = ok and bool(cond)
    print(("  [PASS] " if cond else "  [FAIL] ") + name + (f"  {extra}" if extra else ""))


login = requests.post(f"{BASE}/api/login", json={"username": "end", "password": PW}, timeout=20)
if login.status_code != 200:
    print("登录失败，无法继续：", login.status_code)
    sys.exit(1)
ADMIN = {"Authorization": "Bearer " + login.json()["token"]}
print("1. 管理员登录成功")

with open(DOCX, "rb") as fh:
    docx = fh.read()
r = requests.post(f"{BASE}/api/preview/office", headers=ADMIN,
                  files={"file": ("test-word.docx", docx, "application/octet-stream")}, timeout=180)
check("线上提交页预览接口把 docx 转成 PDF", r.status_code == 200 and r.content[:4] == b"%PDF",
      f"{r.status_code} {r.headers.get('content-type')} {len(r.content)}B")

r = requests.post(f"{BASE}/api/jobs", headers=ADMIN, timeout=180,
                  data={"address": "线上 Office 冒烟验证（脚本会自动删除）", "delivery_mode": "配送", "note": "自动删除"},
                  files=[("files", ("test-word.docx", docx, "application/octet-stream"))])
check("线上提交含 docx 的任务成功", r.status_code == 200, f"{r.status_code} {r.text[:80]}")
job = r.json().get("job", {}) if r.status_code == 200 else {}
fid = (job.get("files") or [{}])[0].get("id")

if job.get("id"):
    r = requests.get(f"{BASE}/api/jobs/{job['id']}/files/{fid}", headers=ADMIN, timeout=120)
    check("线上预览该文件拿到的是转换后的 PDF", r.status_code == 200 and r.content[:4] == b"%PDF",
          f"{r.status_code} {len(r.content)}B")
    r = requests.get(f"{BASE}/api/jobs/{job['id']}/files/{fid}?download=1", headers=ADMIN, timeout=120)
    check("?download=1 仍给原文件（zip 头 PK）", r.status_code == 200 and r.content[:2] == b"PK", f"{len(r.content)}B")
    r = requests.delete(f"{BASE}/api/jobs/{job['id']}", headers=ADMIN, timeout=60)
    check("测试任务已删除（未审批，不会出纸）", r.status_code == 200, str(r.status_code))

print("\n结果：", "全部通过 ✓" if ok else "有失败项 ✗")
sys.exit(0 if ok else 1)
