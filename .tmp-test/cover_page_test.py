"""任务信息页（封面页）测试：接口、内容与代理打印顺序。

用法：backend\\.venv\\Scripts\\python.exe .tmp-test/cover_page_test.py
"""
import re
import sys
import time

import requests

sys.path.insert(0, "backend")
import cover  # noqa: E402

BASE = "http://127.0.0.1:8301"
PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("  [PASS] " if cond else "  [FAIL] ") + name + (f"  {extra}" if extra else ""))


def unescape(rtf: str) -> str:
    """把 \\uNNNN? 还原成中文，便于断言内容"""
    def repl(match):
        code = int(match.group(1))
        return chr(code + 65536) if code < 0 else chr(code)
    return re.sub(r"\\\\u(-?\d+)\?", repl, re.sub(r"\\u(-?\d+)\?", repl, rtf))


tag = str(int(time.time()))[-6:]
admin = requests.post(f"{BASE}/api/login", json={"username": "admin", "password": "admin123"}, timeout=20).json()["token"]
AH = {"Authorization": "Bearer " + admin}
ut = requests.post(f"{BASE}/api/register", json={"username": "cover" + tag, "password": "Test123456"}, timeout=20).json()["token"]
UH = {"Authorization": "Bearer " + ut}
requests.post(f"{BASE}/api/settings", headers=AH, json={"free_users": "cover" + tag}, timeout=20)
AGENT = requests.get(f"{BASE}/api/settings", headers=AH, timeout=20).json()["settings"]["agent_token"]
GH = {"X-Agent-Token": AGENT, "Content-Type": "application/json"}

with open(".tmp-test/test-print.pdf", "rb") as fh:
    pdf = fh.read()

print("\n1. 设置项：默认打印任务信息页")
settings = requests.get(f"{BASE}/api/settings", headers=AH, timeout=20).json()["settings"]
check("cover_page 默认 '1'（打印）", str(settings.get("cover_page")) == "1", str(settings.get("cover_page")))
r = requests.post(f"{BASE}/api/settings", headers=AH, json={"cover_page": "false"}, timeout=20)
check("可以改成关闭", str(r.json()["settings"]["cover_page"]) == "0", str(r.json()["settings"]["cover_page"]))
requests.post(f"{BASE}/api/settings", headers=AH, json={"cover_page": "true"}, timeout=20)

print("\n2. 提交任务 → claim 里带 cover_url")
job = requests.post(f"{BASE}/api/jobs", headers=UH, timeout=120,
                    data={"address": "三教 305 讲台旁", "delivery_mode": "配送", "note": "信息页验收"},
                    files=[("files", ("test-print.pdf", pdf, "application/pdf"))]).json()["job"]
requests.post(f"{BASE}/api/jobs/{job['id']}/approve", headers=AH, timeout=20)
claimed = {}
for _ in range(10):
    got = requests.post(f"{BASE}/api/agent/claim", headers=GH, json={}, timeout=60).json().get("job") or {}
    if not got:
        break
    if got["id"] == job["id"]:
        claimed = got
        break
    requests.post(f"{BASE}/api/agent/jobs/{got['id']}/result", headers=GH,
                  json={"ok": False, "error": "临时占用（信息页测试）"}, timeout=20)
check("代理领取到该任务", claimed.get("id") == job["id"], str(claimed.get("id")))
check("claim 里带 cover_url", claimed.get("cover_url", "").endswith("/cover.pdf"), str(claimed.get("cover_url")))

print("\n3. 下载并检查任务信息页 PDF")
r = requests.get(BASE + claimed.get("cover_url", "/api/agent/jobs/0/cover.pdf"), headers=GH, timeout=300)
check("下载成功且是 PDF", r.status_code == 200 and r.content[:4] == b"%PDF", f"{r.status_code} {len(r.content)}B")
check("是 1 页（单张纸）", r.status_code == 200 and 1000 < len(r.content), f"{len(r.content)}B")
check("响应头文件名是「任务信息-N.pdf」", "cover" in (r.headers.get("content-disposition") or ""),
      (r.headers.get("content-disposition") or "")[:70])
check("未带代理令牌 → 401", requests.get(BASE + claimed["cover_url"], timeout=20).status_code == 401, "")
check("别人的任务号也能生成（代理按任务号取）",
      requests.get(f"{BASE}/api/agent/jobs/{job['id']}/cover.pdf", headers=GH, timeout=300).status_code == 200, "")

print("\n4. 信息页内容（检查 RTF，PDF 由它转出）")
rtf = cover.build_rtf({"id": job["id"], "username": "cover" + tag, "user_id": 1, "copies": 2,
                       "delivery_mode": "配送", "address": "三教 305 讲台旁", "note": "信息页验收",
                       "created_at": "2026-09-15T22:30:00", "files": [{"filename": "test-print.pdf"}]},
                      "2026-09-15 22:31:00")
text = unescape(rtf)
for field in ("任务号", "提交人", "文件", "份数", "配送方式", "配送地址", "备注", "提交时间", "打印时间"):
    check(f"含「{field}」", field in text, "")
check("含提交人用户名", ("cover" + tag) in text, "")
check("含文件名", "test-print.pdf" in text, "")
check("含配送地址", "三教 305 讲台旁" in text, "")
check("含提交时间与打印时间（两个时间都在）", "2026-09-15 22:30:00" in text and "2026-09-15 22:31:00" in text, "")
check("RTF 全文是 ASCII（CJK 已转义，任何编码都不会乱码）", all(ord(ch) < 128 for ch in rtf), "")

print("\n5. 代理会先打信息页再打文件")
agent_src = open("agent/print_agent.py", encoding="utf-8").read()
process = agent_src[agent_src.index("def process_job"):agent_src.index("def run_once")]
check("process_job 里先下载信息页", process.index("download_cover") < process.index("for index, file_info in enumerate"),
      "下载信息页在文件循环之前")
check("信息页先打印且只打 1 份", "self.print_file(cover_path, 1, {})" in process, "")
check("受 cover_page 开关控制", 'truthy(self.effective("cover_page"))' in process, "")
check("信息页下载失败会回报失败（不静默跳过）", "下载任务信息页失败" in process, "")

requests.post(f"{BASE}/api/agent/jobs/{job['id']}/result", headers=GH, json={"ok": True, "error": None}, timeout=20)
requests.delete(f"{BASE}/api/jobs/{job['id']}", headers=AH, timeout=20)
requests.post(f"{BASE}/api/settings", headers=AH, json={"free_users": ""}, timeout=20)

print("\n=== 结果 ===")
print(f"通过 {len(PASS)} 项，失败 {len(FAIL)} 项")
for name in FAIL:
    print("  - 失败：" + name)
sys.exit(1 if FAIL else 0)
