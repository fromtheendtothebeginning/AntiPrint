# api_docs.py — 「API 文档」页面的正文
#
# 文档用 Markdown 写，存在 settings 表（键 api_docs_md）里，管理员可以在网页上直接改；
# 这个模块只提供**出厂默认**那份（settings 里为空时用它，管理员点「恢复默认」也回到这里）。
#
# 改默认文档时要保证与实现一致：接口签名见 main.py，打印参数白名单见 constants.py。

DEFAULT_DOCS = """# AntiPrint 打印 API

把文件提交到本站，管理员审核通过后由本机打印代理**静默出纸**，之后走配送或自取。
下文用 `BASE` 表示服务地址，例如 `https://print.anticraft.top`（本机开发是 `http://127.0.0.1:8301`）。

## 认证

所有打印相关接口都要带登录令牌：

```http
Authorization: Bearer <token>
```

登录接口返回的 `token` 有效期 **24 小时**；`/api/login` 有 **10 次/分钟/IP** 的限速。

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/register` | POST | 注册本站账号，body `{"username": "zhangsan", "password": "******"}`，返回 `{"token": "...", "user": {...}}` |
| `/api/login` | POST | 本站账号登录，body 同上 |
| `/api/login/anticraft` | POST | 用 anticraft.top 的账号密码登录（首次自动建号并同步密码） |
| `/api/me` | GET | 当前账号信息（`id` / `username` / `role`） |

> 用户名 3~32 位；密码至少 6 位。绑定 anticraft 账号后也可以用 anticraft 的账号密码登录。

## 提交打印任务

```http
POST /api/jobs
Content-Type: multipart/form-data
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `files` | 是 | 文件本体，**可重复**传多个（1~5 个，单个 ≤10MB）。支持 PDF / PNG / JPG / Word(.doc/.docx) / PPT(.ppt/.pptx)；Word、PPT 会由服务端先转成 PDF |
| `delivery_mode` | 否 | `配送` 或 `取件`；留空时用你「我的配置」里的默认值（默认 `配送`） |
| `address` | 配送时必填 | 配送地址，最长 255 字；取件单可留空 |
| `note` | 否 | 备注，最长 500 字（管理员认单时会看到） |
| `copies` | 否 | 份数，1~99，默认 1 |
| `settings` | 否 | **每个文件各自的打印设置**，JSON 数组，顺序与 `files` 一一对应，例如 `[{"paper":"A4","pages":"1-3","copies":2},{}]`（空对象 `{}` = 该文件用任务级默认） |

打印设置可用字段（都放在 `settings` 数组的小对象里）：

| 字段 | 可选值 | 说明 |
|---|---|---|
| `paper` | `A4` `A3` `A5` `B5` `Letter` `Legal` | 纸张大小（P1106 只放得下 A4，其他值会打不出来） |
| `pages` | 例如 `1-3,5` | 页面范围，只允许数字、逗号、短横线 |
| `nup` | `1,1` `2,1` `1,2` `2,2` `3,3` `4,4` | 每张纸排几页（行,列） |
| `scale` | `fit` `noscale` `shrink` | 适应纸张 / 实际大小 / 缩小到可打印区域 |
| `copies` | 1~99 | 只针对这个文件；不填就用任务级 `copies` |

**成功**（200）：

```json
{
  "job": {"id": 123, "status": "待审核", "files": [{"id": 45, "filename": "报告.pdf", "print_options": {"copies": 1}}]},
  "charge": "0.10",
  "balance": "4.90"
}
```

**余额不足**（402，body 是 `detail` 对象）：

```json
{
  "detail": {
    "code": "insufficient_balance",
    "message": "余额不足：本单需 0.10 元（1 张 × 0.1 元/张），当前余额 0.00 元",
    "cost": "0.10", "balance": "0.00", "sheets": 1
  }
}
```

## 查询、撤回与删除

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/jobs/mine` | GET | 我的任务列表（含状态、文件、扣费、驳回理由） |
| `/api/jobs/{id}` | GET | 单个任务详情（只能看自己的；管理员能看全部） |
| `/api/jobs/{id}/files/{file_id}` | GET | 下载任务文件（Word/PPT 拿到的是转好的 PDF；加 `?download=1` 拿原件） |
| `/api/jobs/{id}/withdraw` | POST | 撤回（`待审核` / `已通过` 可撤，**自动退费**） |
| `/api/jobs/{id}` | DELETE | 删除自己的任务（`待审核` / `已驳回` / `已撤回`；未出纸的会自动退费） |

任务状态：`待审核` → `已通过` → `打印中` → `已打印` →（配送）`待配送` → `已完成`，或（取件）`待取件` → `已完成`；
审核不通过会变成 `已驳回`（附理由，可改后重提）。

## 余额与计费

```http
GET /api/balance
```

```json
{"balance": 5.0, "billable": true, "free_reason": "", "price": "0.1", "logs": [...], "recharge_enabled": false}
```

- 计费口径：**张数 × 单价**（默认 0.1 元/张）。张数按「页数 ÷ 每张页数 × 份数」估算（取整后至少有 1 张）。
- **免费**：管理员 / 白名单账号 / anticraft 账号；`billable: false` 时 `free_reason` 说明原因。
- **提交时扣费**；驳回、撤回、删除未出纸的任务会自动退回。
- 余额由管理员在「用户管理」里手工调整（充值功能暂未开放）。

## Python 示例

依赖：`pip install requests`

```python
import time
import requests

BASE = "https://print.anticraft.top"
USERNAME = "zhangsan"
PASSWORD = "******"

# 1) 登录拿令牌（24 小时有效，别每次提交都登录 —— 登录接口有每分钟 10 次的限速）
resp = requests.post(f"{BASE}/api/login", json={"username": USERNAME, "password": PASSWORD}, timeout=15)
resp.raise_for_status()
token = resp.json()["token"]
session = requests.Session()
session.headers["Authorization"] = f"Bearer {token}"

# 2) 提交打印任务（multipart：files 可重复；settings 与 files 一一对应）
with open("报告.pdf", "rb") as handle:
    resp = session.post(
        f"{BASE}/api/jobs",
        files=[("files", ("报告.pdf", handle, "application/pdf"))],
        data={
            "delivery_mode": "配送",
            "address": "图书馆二楼服务台",
            "note": "姓名：张三",
            "copies": "1",
            # 逐文件设置：纸张 A4、只打 1~3 页、2 份、每张纸排 2 页
            "settings": '[{"paper": "A4", "pages": "1-3", "copies": 2, "nup": "1,2"}]',
        },
        timeout=60,
    )

if resp.status_code == 402:                       # 余额不足：先充值（找管理员）再提交
    detail = resp.json()["detail"]
    raise SystemExit(f"提交被拒：{detail['message']}")
resp.raise_for_status()
data = resp.json()
job_id = data["job"]["id"]
print(f"已提交任务 #{job_id}，扣费 {data['charge']} 元，余额 {data['balance']} 元（等管理员审核）")

# 3) 轮询进度（审核 → 打印 → 交接）
while True:
    job = session.get(f"{BASE}/api/jobs/{job_id}", timeout=15).json()["job"]
    print("当前状态：", job["status"])
    if job["status"] in ("已打印", "已完成", "打印失败", "已驳回"):
        break
    time.sleep(5)

# 4) 反悔了：撤回（只有「待审核 / 已通过」能撤，撤了会自动退费）
if job["status"] in ("待审核", "已通过"):
    session.post(f"{BASE}/api/jobs/{job_id}/withdraw", timeout=15)
    print("已撤回")
```

多文件 + 各自设置的写法：

```python
files = [
    ("files", ("报价.pdf", open("报价.pdf", "rb"), "application/pdf")),
    ("files", ("方案.docx", open("方案.docx", "rb"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
]
data = {
    "delivery_mode": "取件",
    "settings": '[{"paper": "A4", "copies": 2}, {"paper": "A4", "pages": "1-2"}]',   # 与 files 顺序一致
}
resp = session.post(f"{BASE}/api/jobs", files=files, data=data, timeout=120)
```

## 错误速查

| 状态码 | 含义 |
|---|---|
| 400 | 参数不对：缺地址、文件类型/大小不允许、份数越界、页面范围格式错、打印设置不是合法 JSON 等（`detail` 是中文说明） |
| 401 | 未登录或令牌过期 —— 重新登录 |
| 402 | 余额不足（`detail.code = insufficient_balance`） |
| 403 | 不是你的任务，或需要管理员权限 |
| 404 | 任务/文件不存在（可能已被删除） |
| 429 | 触发限速（登录接口 10 次/分钟） |
| 500 | 服务端异常，稍后重试；Office 转换失败也会报在这里 |

## 打印代理与虚拟打印机

- **打印代理**：接打印机的那台机器上常驻的服务，领取任务后静默出纸；设备令牌（`X-Agent-Token`）由管理员在「管理设置 → 打印代理」里管理，普通用户不需要用它。
- **虚拟打印机**：给用户用的桌面小程序 —— 在任意软件里 `Ctrl+P` 选「AntiPrint-1.0.0」就等于把内容转成 PDF 并调用本页的 `POST /api/jobs` 提交。安装包与用法见网站「虚拟打印机」页。
"""
