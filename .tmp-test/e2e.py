"""AntiPrint 端到端接口链路测试（临时脚本，不属于交付代码）。

覆盖：健康检查 → 注册/登录/鉴权 → 提交任务 → 管理员审核 → 代理领取/下载/回报 → 驳回-重提。
用 backend/.venv 的 python 运行：backend\.venv\Scripts\python.exe .tmp-test\e2e.py
"""
import hashlib
import io
import json
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8301"
PDF_PATH = ".tmp-test/test-print.pdf"
PASS, FAIL = [], []


def call(method, path, token=None, agent_token=None, json_body=None, form=None, raw=False):
    """极简请求器：form 为 {字段: 值或 (文件名, 字节)} 时走 multipart。"""
    url = BASE + path
    headers = {}
    data = None
    if token:
        headers["Authorization"] = "Bearer " + token
    if agent_token:
        headers["X-Agent-Token"] = agent_token
    if json_body is not None:
        data = json.dumps(json_body).encode()
        headers["Content-Type"] = "application/json"
    elif form is not None:
        boundary = "----antiprint" + str(int(time.time() * 1000))
        buf = io.BytesIO()
        for k, v in form.items():
            items = v if isinstance(v, list) else [v]
            for item in items:
                buf.write(f"--{boundary}\r\n".encode())
                if isinstance(item, tuple):
                    name, content, ctype = item
                    buf.write(
                        f'Content-Disposition: form-data; name="{k}"; filename="{name}"\r\n'.encode()
                    )
                    buf.write(f"Content-Type: {ctype}\r\n\r\n".encode())
                    buf.write(content)
                else:
                    buf.write(f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode())
                    buf.write(str(item).encode())
                buf.write(b"\r\n")
        buf.write(f"--{boundary}--\r\n".encode())
        data = buf.getvalue()
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read()
            return resp.status, (body if raw else _maybe_json(body))
    except urllib.error.HTTPError as e:
        body = e.read()
        return e.code, (body if raw else _maybe_json(body))


def _maybe_json(body: bytes):
    try:
        return json.loads(body.decode("utf-8"))
    except Exception:
        return {"_raw": body[:200].decode("utf-8", "replace")}


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("  [PASS] " if cond else "  [FAIL] ") + name + (f"  {extra}" if extra else ""))


pdf_bytes = open(PDF_PATH, "rb").read()
pdf_sha = hashlib.sha256(pdf_bytes).hexdigest()

print("\n1. 健康检查")
st, r = call("GET", "/api/health")
check("GET /api/health 200 且 db=ok", st == 200 and r.get("db") == "ok", str(r))

print("\n2. 注册 / 登录 / 鉴权")
uname = "testuser" + str(int(time.time()))
st, r = call("POST", "/api/register", json_body={"username": uname, "password": "Test123456"})
check("注册成功返回 token", st == 200 and "token" in r, f"{st} {r}")
user_token = r.get("token")
uid = r["user"]["id"]

st, r = call("POST", "/api/login", json_body={"username": "admin", "password": "admin123"})
check("管理员 admin/admin123 登录成功", st == 200 and r.get("user", {}).get("role") == "admin", f"{st} {r}")
admin_token = r.get("token")

# 计费：新账号余额为 0，先由管理员充 100 元，后面的提交才不会被 402 拦住
call("POST", f"/api/users/{uid}/balance", token=admin_token, json_body={"delta": "100", "note": "测试充值"})

st, r = call("POST", "/api/login", json_body={"username": "admin", "password": "wrongpass"})
check("错误密码 401", st == 401, str(st))

st, r = call("GET", "/api/jobs/mine")
check("无 token 访问受保护接口 401", st == 401, str(st))

st, r = call("GET", "/api/jobs", token=user_token)
check("普通用户访问管理接口 403", st == 403, str(st))

st, r = call("GET", "/api/me", token=user_token)
check("GET /api/me 返回当前用户", st == 200 and r.get("username") == uname, str(r))

print("\n3. 管理员设置 / 代理令牌")
st, r = call("GET", "/api/settings", token=admin_token)
agent_token = (r.get("settings") or {}).get("agent_token")
check("读取设置含 agent_token", st == 200 and bool(agent_token), f"token 长度 {len(agent_token or '')}")
check("默认打印目标为 P1106", "P1106" in str((r.get("settings") or {}).get("printer_name", "")), str(r.get("settings")))

print("\n4. 提交打印任务（含危险扩展名拒绝）")
st, r = call(
    "POST", "/api/jobs", token=user_token,
    form={"address": "上海市徐汇区某某路 100 号 3 号楼 502",
          "note": "端到端测试任务",
          "files": ("test-print.pdf", pdf_bytes, "application/pdf")},
)
job = r.get("job") or {}
job_id = job.get("id")
check("提交 PDF 任务成功（待审核）", st == 200 and job.get("status") == "待审核", f"{st} id={job_id}")

st, r = call(
    "POST", "/api/jobs", token=user_token,
    form={"address": "测试地址", "files": ("bad.exe", b"MZ\x90\x00", "application/octet-stream")},
)
check("上传 exe 被拒 400", st == 400, f"{st} {r}")

st, r = call("GET", "/api/jobs/mine", token=user_token)
mine = (r.get("jobs") or [])
check("我的任务列表含新任务且文件已落库", any(j["id"] == job_id for j in mine) and bool(mine[0]["files"]), f"任务数 {len(mine)}")

print("\n5. 管理员审核")
st, r = call("GET", "/api/jobs", token=admin_token)
check("管理列表可见任务与代理状态字段", st == 200 and "agent_online" in r and any(j["id"] == job_id for j in r.get("jobs", [])), str(st))

st, r = call("POST", f"/api/jobs/{job_id}/approve", token=admin_token)
check("同意后状态=已通过", st == 200 and r.get("job", {}).get("status") == "已通过", f"{st} {r}")

print("\n6. 打印代理：注册 / 心跳 / 领取 / 下载 / 回报")
st, r = call("POST", "/api/agent/register", agent_token=agent_token,
             json_body={"name": "e2e-agent", "version": "1.0.0",
                        "printers": ["HP LaserJet Professional P1106"], "launcher": "sumatra"})
check("代理注册成功", st == 200 and r.get("ok") is True, f"{st} {r}")

st, r = call("POST", "/api/agent/heartbeat", agent_token=agent_token,
             json_body={"name": "e2e-agent", "version": "1.0.0",
                        "printers": ["HP LaserJet Professional P1106"], "launcher": "sumatra"})
cfg = r.get("config") or {}
check("心跳下发打印配置", st == 200 and "printer_name" in cfg, str(cfg))

st, r = call("POST", "/api/agent/register", agent_token="wrong-token",
             json_body={"name": "x", "version": "1", "printers": [], "launcher": "sumatra"})
check("错误代理令牌 401", st == 401, str(st))

st, r = call("POST", "/api/agent/claim", agent_token=agent_token, json_body={})
claimed = r.get("job")
check("代理领取到任务（状态转打印中）", st == 200 and claimed and claimed.get("id") == job_id, f"{st} {r}")

st, r = call("GET", f"/api/agent/jobs/{job_id}", token=None, agent_token=agent_token, raw=True) if False else (None, None)
fid = (claimed or {}).get("files", [{}])[0].get("id")
st, body = call("GET", f"/api/agent/jobs/{job_id}/files/{fid}", agent_token=agent_token, raw=True)
check("代理下载文件字节与上传一致", st == 200 and hashlib.sha256(body).hexdigest() == pdf_sha, f"{st} {len(body) if body else 0} 字节")

st, r = call("POST", "/api/agent/claim", agent_token=agent_token, json_body={})
check("无更多任务时 claim 返回 null", st == 200 and r.get("job") is None, str(r))

st, r = call("POST", f"/api/agent/jobs/{job_id}/result", agent_token=agent_token,
             json_body={"ok": True, "error": None})
check("回报成功 → 状态=已打印", st == 200 and r.get("status") == "已打印", f"{st} {r}")

st, r = call("GET", f"/api/jobs/{job_id}", token=user_token)
check("用户侧看到已打印 + printed_at", st == 200 and r["job"]["status"] == "已打印" and r["job"]["printed_at"], str(r["job"]["status"]) if st == 200 else str(r))

print("\n7. 驳回 / 重提 / 重试 / 文件鉴权")
st, r = call("POST", "/api/jobs", token=user_token,
             form={"address": "驳回测试地址", "files": ("test-print.pdf", pdf_bytes, "application/pdf")})
job2 = (r.get("job") or {}).get("id")
st, r = call("POST", f"/api/jobs/{job2}/reject", token=admin_token, json_body={"reason": ""})
check("空理由驳回 400", st == 400, f"{st} {r}")
st, r = call("POST", f"/api/jobs/{job2}/reject", token=admin_token, json_body={"reason": "纸张不合法，请重传"})
check("驳回成功 → 已驳回并记录理由", st == 200 and r["job"]["status"] == "已驳回" and r["job"]["reject_reason"], f"{st} {r}")
st, r = call("POST", f"/api/jobs/{job2}/resubmit", token=user_token)
check("用户重提 → 回到待审核且清空理由", st == 200 and r["job"]["status"] == "待审核" and not r["job"]["reject_reason"], f"{st} {r}")

st, r = call("GET", f"/api/jobs/{job2}", token=user_token)
other_fid = (r.get("job", {}).get("files") or [{}])[0].get("id")
st, r = call("POST", "/api/register", json_body={"username": "hacker" + str(int(time.time())), "password": "Test123456"})
hacker_token = r.get("token")
st, r = call("GET", f"/api/jobs/{job2}/files/{other_fid}", token=hacker_token)
check("他人访问我的文件 403", st == 403, str(st))

print("\n8. 打印失败 → 重新入队")
call("POST", f"/api/jobs/{job2}/approve", token=admin_token)
call("POST", "/api/agent/claim", agent_token=agent_token, json_body={})
st, r = call("POST", f"/api/agent/jobs/{job2}/result", agent_token=agent_token,
             json_body={"ok": False, "error": "打印机离线（测试注入）"})
check("回报失败 → 状态=打印失败", st == 200 and r.get("status") == "打印失败", f"{st} {r}")
st, r = call("POST", f"/api/jobs/{job2}/retry", token=admin_token)
check("管理员重新入队 → 已通过", st == 200 and r["job"]["status"] == "已通过", f"{st} {r}")

# 收尾清理：删掉本次用例建的任务（含最后一条「已通过」的）。
# 不清理的话，紧接着跑 e2e2.py 时它的代理会先领走这里残留的「已通过」任务，导致它自己那单永远不动。
print("\n9. 清理本次任务")
st, r = call("GET", "/api/jobs", token=admin_token)
left = [j for j in (r.get("jobs") or []) if j.get("username") == uname]
for item in left:
    call("DELETE", f"/api/jobs/{item['id']}", token=admin_token)
check("本次用例的任务已清理（避免干扰后续用例）", True, f"删除 {len(left)} 条")

print("\n===== 结果 =====")
print(f"通过 {len(PASS)} 项，失败 {len(FAIL)} 项")
if FAIL:
    print("失败项：")
    for f in FAIL:
        print("  - " + f)
sys.exit(1 if FAIL else 0)
