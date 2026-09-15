# AntiPrint · 远程打印服务

用户远程登录后提交打印任务（上传文件 + 填写配送地址），管理员在后台审核，审核通过后由**本机打印代理静默出纸**。

## 三个部分

> 管理员与运维请直接看 **[docs/admin-guide.md](docs/admin-guide.md)**：怎么配管理员账号、怎么审核与勾选交接、怎么在**接打印机的那台电脑**上装打印代理、出问题怎么查（含实测踩坑）。大多数管理员**不需要**装代理。

| 组成 | 目录 | 说明 |
|---|---|---|
| 前端 | `frontend/` | React 18 + Vite + TypeScript。登录 / 提交打印 / 我的任务 / 管理后台 |
| 服务端 | `backend/` | FastAPI + MySQL 8 + PyMySQL。鉴权、任务状态机、代理调度、静态托管前端 |
| 打印代理 | `agent/` | Windows 常驻小程序：轮询任务 → SumatraPDF 静默打印 → 回报结果 |

数据流：`用户提交 → 待审核 → 管理员同意 → 已通过 → 代理领取（打印中）→ 已打印 → 管理员勾选 待配送/待取件 → 已完成`；异常支线：`已驳回`（必填理由，可改后重提）、`打印失败`（可重新入队）。

## 页面与角色

| 页面 | 谁用 | 做什么 |
|---|---|---|
| 提交打印 | 所有用户 | 上传文件、选**配送方式**（配送 / 取件）、填地址与备注（按「我的配置」的默认值预填）；可设**打印参数**（份数 / 纸张 / 页面范围 / 每张页数 / 缩放） |
| 我的任务 | 所有用户 | 看自己任务的状态、驳回理由、打印错误，被驳回后可改地址/备注重提 |
| 我的配置 | 所有用户 | **默认配送地址**、**默认配送方式**、**绑定 / 解绑 anticraft 账号** |
| 任务队列 | 管理员 | 审核（同意 / 驳回 / 重新入队）、预览文件，出纸后**勾选**「待配送 / 待取件」再勾「已完成」 |
| 管理设置 | 管理员 | 打印代理状态、启动器 / 目标打印机 / 份数 / 演练模式、anticraft 绑定应用、代理令牌 |

配送方式决定出纸后的去向：选「配送」的任务打印完标为**待配送**（管理员送达），选「取件」的标为**待取件**（用户到打印点自取），两者最终都勾成**已完成**。

## 快速开始

```bat
setup.bat                  :: 建 venv + 装依赖 + 构建前端（首次）
run.bat                    :: 启动后端 + 打印代理（无窗口）
cd frontend && npm.cmd run dev   :: 开发前端（http://localhost:3010 热更新）
stop.bat                   :: 停止后端 / 代理 / 前端
```

- 网址：后端与前端构建产物 **http://127.0.0.1:8301**（单进程，生产形态）；开发热更新 **http://localhost:3010**（`/api` 代理到 8301）。
- 默认管理员：`admin` / `admin123`（可用环境变量 `ADMIN_PASSWORD` 覆盖，仅首次建库生效）。
- 打印代理配置：管理页「打印设置」复制**代理令牌** → 填入 `agent/config.json` → `agent\install-agent.bat`（装依赖 + 注册开机自启）。

## 打印代理

```bat
backend\.venv\Scripts\python.exe agent\print_agent.py --selftest   :: 自检（配置/打印机/服务端心跳）
backend\.venv\Scripts\python.exe agent\print_agent.py --printers   :: 列出本机打印机
backend\.venv\Scripts\python.exe agent\print_agent.py --once       :: 只跑一轮（调试）
backend\.venv\Scripts\python.exe agent\print_agent.py --dry-run    :: 演练：只打印命令行，不出纸
```

打印命令形如：
`SumatraPDF.exe -print-to "HP LaserJet Professional P1106" -silent -exit-when-done <文件>`

要点：
- **HP LaserJet Professional P1106 是主机型（GDI）打印机**，必须经 Windows 驱动渲染，不能直接灌 PDF 原始数据；SumatraPDF（GDI）正是干这个的。
- 「演练模式」在管理页「打印设置」里开关，开启后代理只记录要执行的命令、不真的出纸（**演练也会把任务标成已打印**，仅用于验链路）。
- 代理与服务器之间只靠轮询（默认 5 秒）+ `X-Agent-Token`，没有 websocket；服务端用原子 UPDATE 领取任务，保证同一单不会被打印两次。

## 接口一览

用户/管理：`POST /api/register`、`POST /api/login`、`POST /api/login/anticraft`、`GET /api/me`、`POST /api/jobs`（multipart：`address` + `note` + `delivery_mode` + `files`）、`GET /api/jobs/mine`、`GET /api/jobs`（管理员）、`GET /api/jobs/{id}`、`GET /api/jobs/{id}/files/{fid}`、`POST /api/jobs/{id}/approve|reject|resubmit|retry`、`POST /api/jobs/{id}/advance`（交接流转，body `{to}`）、`DELETE /api/jobs/{id}`、`GET/POST /api/settings`、`POST /api/settings/rotate-agent-token`。

用户配置：`GET /api/profile`、`PUT /api/profile`（默认地址 / 默认配送方式）、`POST /api/profile/anticraft/bind-ticket`（绑定用一次性票据）、`POST /api/profile/anticraft/unbind`（解绑并设置本地密码）。

anticraft 账号绑定：`GET /api/oauth/anticraft/status`（是否已配置）、`GET /api/oauth/anticraft/start`（302 跳授权页）、`GET /api/oauth/anticraft/callback`（anticraft 回跳，换令牌并建号）、`POST /api/oauth/anticraft/exchange`（一次性票据换本地登录态）。

## 用 anticraft 账号登录（账号绑定，推荐）

登录页第三个 Tab「anticraft 登录」有两条路：

1. **跳转授权（主用，OAuth 授权码模式）**：点「用 anticraft 登录（跳转授权）」→ 浏览器跳到 anticraft 的授权页 → 用户确认 → 自动回到 AntiPrint 并登录。**密码不经过 AntiPrint**，服务端只拿到一次性授权码换来的访问令牌。
2. **账号密码（备用）**：不跳转，直接填 anticraft 账号密码，由服务端向 anticraft 校验。

两种方式都会在 **AntiPrint 没有该账号时自动创建**（`source=anticraft`），并按 **anticraft 用户 ID** 绑定（anticraft 侧改用户名也能认出同一个人）；若用户名已被 **AntiPrint 本地注册**占用则拒绝，防止 anticraft 账号顶掉本地账号（含管理员）。

### 启用「跳转授权」需要在 anticraft 登记（只做一次）

> **当前状态（2026-09-14）**：`anticraft 服务地址` 指向**本机跑着的 anticraft**（`http://localhost:3000`，即 `D:\anticraft\index`），并在那边登记好了本应用（应用名 `antiprintlocal`，回调地址 `http://127.0.0.1:8301/api/oauth/anticraft/callback`）。所以**请用 http://127.0.0.1:8301 打开本项目**再点跳转授权（回调地址是逐字符精确匹配的，用 `localhost:3010` 会被拒）。想切到线上，把「anticraft 服务地址」改成 `https://anticraft.top`，并先在 anticraft.top 后台按下面步骤登记同一个回调地址（两边的 `client_id`/`client_secret` 不同，要一起换）。

1. 用 anticraft 管理员进「管理后台 → 绑定应用 → 登记应用」，填：
   - 应用名：`AntiPrint 远程打印`
   - 简介：远程提交打印任务并由本机打印代理出纸
   - 主页：`http://127.0.0.1:8301`（部署后改成正式域名）
   - 回调地址（**逐个精确登记，不支持通配符**，按你实际访问的地址来）：
     - `http://127.0.0.1:8301/api/oauth/anticraft/callback` — 直接访问后端（单进程托管前端）
     - `http://localhost:3010/api/oauth/anticraft/callback` — 用 Vite 开发（`/api` 会代理到 8301）
     - `https://<正式域名>/api/oauth/anticraft/callback` — 部署后补登记
2. 复制登记得到的 `client_id`（`ac_` 开头）与 `client_secret`（`acs_` 开头，**只显示一次**）。
3. 回到 AntiPrint，管理员「打印设置」里填：`anticraft 绑定应用 client_id`、`anticraft 绑定应用 client_secret`，确认 `anticraft 服务地址` 为 `https://anticraft.top`、`允许的授权来源` 含你访问的地址，保存即可。

> 未配置时，登录页会直接把「需要去 anticraft 登记的回调地址」显示出来，照着填即可。
> `client_secret` 只存在服务端、接口只回显 `******`；登录尝试与普通登录共用限速（同一 IP 每分钟 10 次）。

代理：`POST /api/agent/register|heartbeat|claim`、`GET /api/agent/jobs/{id}/files/{fid}`、`POST /api/agent/jobs/{id}/result`（均需 `X-Agent-Token`）。

## 约定与注意事项

- 上传仅支持 **PDF / 图片（png、jpg）**：单文件 ≤10MB、单任务 ≤5 个；危险扩展名（exe/bat/js/html…）一律拒绝。Office 文档需先转 PDF（见 AGENTS.md「已知未定义」）。
- 中文界面/注释/文档；样式沿用 `D:\anticraft\index` 的设计体系（紫 `#6c5ce7` / 青 `#00cec9`，明暗模式），图标全部内联 SVG。
- 端口：后端 **8301**、前端 dev **3010**（本机 3000/8000 被 `index` 占用，**8300 被 natpierce 占用**）。
- pip 若报「找不到 fastapi」是清华源对新 Python 返回空，改用 `-i https://mirrors.aliyun.com/pypi/simple/`（setup.bat 已内置）。
- 数据库凭据在 `backend/db_config.json`（已 gitignore，模板 `db_config.example.json`）；部署相关脚本与凭据**禁止提交**。
- 更多排错细节、状态机、部署红线见 **AGENTS.md**。
