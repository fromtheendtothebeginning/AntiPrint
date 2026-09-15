"""Word / PPT 转 PDF（预览、打印、缓存）接口测试（临时脚本）。

前置：本机（或服务器）已安装 LibreOffice；先用 .tmp-test/make_office_fixtures.ps1 生成测试件。
用法：backend\\.venv\\Scripts\\python.exe .tmp-test\\office_convert_test.py
"""
import os
import sys
import time

import requests

BASE = "http://127.0.0.1:8301"
DOCX = ".tmp-test/test-word.docx"
PPTX = ".tmp-test/test-ppt.pptx"
PDF = ".tmp-test/test-print.pdf"
CONVERTED_DIR = "backend/data/converted"
PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("  [PASS] " if cond else "  [FAIL] ") + name + (f"  {extra}" if extra else ""))


def auth(token):
    return {"Authorization": "Bearer " + token}


def submit(token, paths, **fields):
    data = {"address": "Office 转 PDF 测试（可删除）", "delivery_mode": "配送", "note": "转换验证"}
    data.update(fields)
    files = []
    for path in paths:
        with open(path, "rb") as fh:
            content = fh.read()
        name = os.path.basename(path)
        mime = "application/pdf" if name.endswith(".pdf") else "application/octet-stream"
        files.append(("files", (name, content, mime)))
    return requests.post(BASE + "/api/jobs", data=data, headers=auth(token), files=files, timeout=180)


tag = str(int(time.time()))[-6:]
admin = requests.post(f"{BASE}/api/login", json={"username": "admin", "password": "admin123"}, timeout=20).json()["token"]
reg = requests.post(f"{BASE}/api/register", json={"username": "office" + tag, "password": "Test123456"}, timeout=20).json()
UT = reg["token"]
# 计费：新账号余额为 0，先由管理员充 100 元（否则提交会被 402 拦住）
requests.post(f"{BASE}/api/users/{reg['user']['id']}/balance", headers=auth(admin),
              json={"delta": "100", "note": "测试充值"}, timeout=20)
AGENT = requests.get(f"{BASE}/api/settings", headers=auth(admin), timeout=20).json()["settings"]["agent_token"]
GH = {"X-Agent-Token": AGENT}

if not (os.path.isfile(DOCX) and os.path.isfile(PPTX)):
    print("缺少测试件，先跑：powershell -File .tmp-test/make_office_fixtures.ps1")
    sys.exit(1)

print("\n1. 提交页预览接口：Word / PPT 转 PDF")
for path, label in ((DOCX, "Word"), (PPTX, "PPT")):
    with open(path, "rb") as fh:
        r = requests.post(BASE + "/api/preview/office", headers=auth(UT),
                          files={"file": (os.path.basename(path), fh.read())}, timeout=180)
    ok = r.status_code == 200 and r.content[:4] == b"%PDF"
    check(f"{label} 预览返回 PDF", ok, f"{r.status_code} {r.headers.get('content-type')} {len(r.content)}B")
    check(f"{label} 预览响应用内嵌 disposition", "inline" in (r.headers.get("content-disposition") or ""),
          (r.headers.get("content-disposition") or "")[:70])

print("\n2. 预览接口的类型与大小校验")
for path, label, expect in ((PDF, "PDF", 400), ("backend/constants.py", "py 脚本", 400)):
    with open(path, "rb") as fh:
        r = requests.post(BASE + "/api/preview/office", headers=auth(UT),
                          files={"file": (os.path.basename(path), fh.read())}, timeout=60)
    check(f"{label} 走预览接口 → {expect}", r.status_code == expect, f"{r.status_code} {r.json().get('detail','')[:50]}")
with open(DOCX, "rb") as fh:
    big = fh.read() + b"0" * (11 * 1024 * 1024)
r = requests.post(BASE + "/api/preview/office", headers=auth(UT), files={"file": ("big.docx", big)}, timeout=60)
check("超过 10MB → 400", r.status_code == 400, f"{r.status_code} {r.json().get('detail','')[:50]}")
r = requests.post(BASE + "/api/preview/office", files={"file": ("x.docx", b"x")}, timeout=20)
check("未登录 → 401", r.status_code == 401, str(r.status_code))
with open(DOCX, "rb") as fh:
    fake = fh.read()[:200] + "这不是真的 docx".encode() * 50
r = requests.post(BASE + "/api/preview/office", headers=auth(UT), files={"file": ("broken.docx", fake)}, timeout=180)
check("假 docx 转换失败 → 400 且给出中文原因", r.status_code == 400 and "转换失败" in r.json().get("detail", ""),
      f"{r.status_code} {r.json().get('detail','')[:80]}")

print("\n3. 提交含 Word/PPT 的任务（上传时即转换）")
r = submit(UT, [DOCX, PPTX, PDF], copies="2")
job = r.json().get("job", {}) if r.status_code == 200 else {}
check("三个文件（docx+pptx+pdf）提交成功", r.status_code == 200, f"{r.status_code} {r.text[:100]}")
jid = job.get("id")
names = [f["filename"] for f in job.get("files", [])]
check("文件名保持原名（含 .docx/.pptx）", names == ["test-word.docx", "test-ppt.pptx", "test-print.pdf"], str(names))

print("\n4. 用户/管理员预览接口：Office 给转换后的 PDF，?download=1 给原文件")
for f in job.get("files", []):
    if f["filename"].endswith(".pdf"):
        continue
    r = requests.get(f"{BASE}/api/jobs/{jid}/files/{f['id']}", headers=auth(UT), timeout=60)
    check(f"{f['filename']} 预览返回 PDF", r.status_code == 200 and r.content[:4] == b"%PDF"
          and r.headers.get("content-type", "").startswith("application/pdf"), f"{r.status_code} {len(r.content)}B")
    check(f"{f['filename']} 预览文件名改成 .pdf", f"{f['filename'][:-5]}.pdf" in (r.headers.get("content-disposition") or ""),
          (r.headers.get("content-disposition") or "")[:80])
    r = requests.get(f"{BASE}/api/jobs/{jid}/files/{f['id']}?download=1", headers=auth(UT), timeout=60)
    check(f"{f['filename']} 下载给原文件（zip 头 PK）", r.status_code == 200 and r.content[:2] == b"PK", f"{r.status_code} {len(r.content)}B")

print("\n5. 代理链路：claim 带 print_name，下载到的是 PDF")
requests.post(f"{BASE}/api/jobs/{jid}/approve", headers=auth(admin), timeout=20)
# 队列里可能有别的「已通过」任务（历史测试遗留），代理按顺序领取 → 边领边还：
# 领到别人的就回报失败（可被 retry 还原），领到自己的就停下
GH_JSON = {**GH, "Content-Type": "application/json"}
claimed, borrowed = None, []
for _ in range(10):
    got = requests.post(f"{BASE}/api/agent/claim", headers=GH_JSON, json={}, timeout=20).json().get("job") or {}
    if got.get("id") == jid:
        claimed = got
        break
    if not got:
        break
    borrowed.append(got["id"])
    requests.post(f"{BASE}/api/agent/jobs/{got['id']}/result", headers=GH_JSON,
                  json={"ok": False, "error": "临时占用（Office 转 PDF 测试）"}, timeout=20)
check("领取到刚提交的任务", claimed is not None, f"借用过 {borrowed}")
claim = claimed or {}
print_names = {f["filename"]: f["print_name"] for f in claim.get("files", [])}
check("docx 的 print_name = test-word.pdf", print_names.get("test-word.docx") == "test-word.pdf", str(print_names))
check("pptx 的 print_name = test-ppt.pdf", print_names.get("test-ppt.pptx") == "test-ppt.pdf", "")
check("pdf 的 print_name 保持不变", print_names.get("test-print.pdf") == "test-print.pdf", "")
for f in claim.get("files", []):
    r = requests.get(BASE + f["url"], headers=GH, timeout=60)
    is_pdf = r.content[:4] == b"%PDF"
    check(f"代理下载 {f['filename']} → PDF 字节", r.status_code == 200 and is_pdf, f"{r.status_code} {len(r.content)}B")
    check(f"代理下载 {f['filename']} 的头文件名是 .pdf", f["print_name"] in (r.headers.get("content-disposition") or ""),
          (r.headers.get("content-disposition") or "")[:70])

print("\n6. 转换缓存（内容寻址，同一文件只转一次）")
sha = next((f.get("sha256") for f in job.get("files", []) if f["filename"] == "test-word.docx"), None)
cached = os.path.join(CONVERTED_DIR, f"{sha}.pdf") if sha else ""
check("docx 的转换结果已落到 data/converted/<sha>.pdf", bool(cached) and os.path.isfile(cached), os.path.basename(cached))
if os.path.isfile(cached):
    before = os.path.getmtime(cached)
    time.sleep(1.1)
    with open(DOCX, "rb") as fh:
        r = requests.post(BASE + "/api/preview/office", headers=auth(UT), files={"file": ("test-word.docx", fh.read())}, timeout=180)
    check("再预览同一文件命中缓存（mtime 未变）", r.status_code == 200 and os.path.getmtime(cached) == before,
          f"{r.status_code}")

print("\n7. 代理回报结果 + 删除任务时清理缓存")
requests.post(f"{BASE}/api/agent/jobs/{jid}/result", headers=GH_JSON,
              json={"ok": True, "error": None}, timeout=20)
check("回报成功（链路走通）", requests.get(f"{BASE}/api/jobs/{jid}", headers=auth(admin), timeout=20).json()["job"]["status"] == "已打印")
for other in borrowed:      # 把临时占用的任务还原回「已通过」
    requests.post(f"{BASE}/api/jobs/{other}/retry", headers=auth(admin), timeout=20)
r = requests.delete(f"{BASE}/api/jobs/{jid}", headers=auth(admin), timeout=30)
check("删除任务", r.status_code == 200, str(r.status_code))
check("删任务后未被引用的转换缓存被清理", not cached or not os.path.isfile(cached), os.path.basename(cached))

print("\n8. 含宏的 Office 仍然拒绝")
for name in ("bad.docm", "bad.pptm"):
    r = requests.post(BASE + "/api/jobs", data={"address": "x", "delivery_mode": "配送"}, headers=auth(UT),
                      files=[("files", (name, b"macro", "application/octet-stream"))], timeout=30)
    check(f"{name} → 400", r.status_code == 400, f"{r.status_code} {r.json().get('detail','')[:60]}")

print("\n=== 结果 ===")
print(f"通过 {len(PASS)} 项，失败 {len(FAIL)} 项")
for name in FAIL:
    print("  - 失败：" + name)
sys.exit(1 if FAIL else 0)
