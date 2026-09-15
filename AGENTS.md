# AGENTS.md — AntiPrint · 远程打印服务

用户远程提交打印任务（上传文件 + 配送地址），管理员审核通过后由**本机打印代理静默出纸**。三进程：React+TS 前端 / FastAPI+MySQL 服务器 / Windows 打印代理。

> **项目状态（2026-09-14）**：三端代码已落地，并已部署到阿里云（systemd `antiprint-api` + nginx，管理员账号 `end`）。文档分工：`README.md` 面向使用者、**`docs/admin-guide.md` 面向管理员与运维**（建管理员、审核交接、在接打印机的机器上装代理、故障排查）、本文面向 AI 代理（契约、坑、红线）。

## 已定决策（勿擅自改动，改动前先问用户）

| 决策点 | 结论 |
|---|---|
| 前端 | React 18 + Vite + **TypeScript（strict）**，`@/*` 路径别名；**Tailwind CSS v4 + lucide-react**（2026-09-14 全站换肤为暖色仪表盘风格，token 见「前端约定」；不再用页面私有 CSS / 内联 SVG 图标库） |
| 后端 | Python 3.14 + FastAPI + PyMySQL + **MySQL 8**（与 `D:\anticraft\index`、`antiClass` 一致） |
| 静默打印 | **本机常驻打印代理**领取任务后静默打印（不用 `window.print()`，浏览器无法程序化选打印机/份数） |
| 打印内容 | **仅文件上传**（PDF / 图片为可静默打印格式；Office 转换见「已知未定义」） |
| 本地端口 | 后端 **8301**、Vite **3010**（3000/8000 被 `index`、**8300 被 natpierce 内网穿透工具占用**，2026-09-14 实测；3306 有 MySQL 在跑） |
| 目标打印机 | `HP LaserJet Professional P1106`（USB001，本机唯一真实打印机，**主机型/GDI**）。**注意**：管理页「保存设置」会把下拉当前值一起写库，2026-09-14 18:25 被改成过 `Microsoft Print to PDF`（虚拟队列，静默打印会弹保存对话框）——改打印机后务必确认存的是 P1106。 |
| 账号体系 | **anticraft 账号绑定登录**（协议：`D:\anticraft\index\docs\account-binding-api.md`）。① 主用：OAuth 授权码模式——前端跳 `GET /api/oauth/anticraft/start`（302 到 anticraft `/bind`）→ 用户确认 → 回跳 `GET /api/oauth/anticraft/callback`（服务端用 client_secret 换 token）→ 按 **anticraft 用户 ID** 绑定/创建本地账号（`users.source='anticraft'`、`users.anticraft_id`）→ 302 回前端落地页带一次性 ticket → `POST /api/oauth/anticraft/exchange` 换本地 JWT。密码不经过本项目。② 备用：`POST /api/login/anticraft` 用账号密码向 anticraft 校验（自动建号 + 密码同步）。③ 本地自建账号同名时**一律拒绝**（防顶号，含 admin）。**启用跳转授权必须先在 anticraft 后台「绑定应用」登记** `client_id`/`client_secret` 与**精确回调地址**，再填进「打印设置」（`anticraft_base` / `anticraft_client_id` / `anticraft_client_secret` / `anticraft_origins`） |

## 核心流程（端到端时序）

```
用户浏览器 ──登录/上传文件+选配送方式+填地址──▶ 服务器(FastAPI+MySQL)：print_jobs.status = 待审核
管理员浏览器 ──预览文件/同意──▶ status = 已通过（驳回则必填理由 → 已驳回，可改后重提）
打印代理(常驻) ──轮询+原子领取──▶ status = 打印中 → SumatraPDF 静默打印 → 回报
                                        ├─ 成功 → status = 已打印（记 printed_at/agent）
                                        └─ 失败 → status = 打印失败（错误入库，可重试回「已通过」）
管理员浏览器 ──任务队列勾选──▶ 待配送（配送单）/ 待取件（取件单）──再次勾选──▶ 已完成（记 finished_at）
```

## 验证记录（2026-09-14 实测，改动后请重跑）

| 层 | 怎么测 | 结果 |
|---|---|---|
| 接口 | `backend\.venv\Scripts\python.exe .tmp-test\e2e.py`（**临时脚本，不算交付代码**） | 28 项全通过：注册/登录/401/403、上传（exe 拒绝）、审核、代理注册/心跳/领取/下载字节一致/回报、驳回-重提、失败-重入队、他人取文件 403 |
| UI | `node .tmp-test\ui-test2.mjs` / `ui-test3.mjs`（复用 `D:\anticraft\index` 的 playwright-core + 本机 chromium） | 25 项全通过：登录跳转、提交任务、我的任务、同意/驳回（空理由禁用）、预览 iframe、代理在线状态、设置区；截图在 `.tmp-test\shots\` |
| 打印 | `agent\print_agent.py --once`（真实出纸） | 18:17 调 SumatraPDF 打出 1 张测试页，任务转「已打印」，打印机状态 Normal、DetectedErrorState=0、队列清空 |
| anticraft 登录 | `.tmp-test\anticraft_test.py` + `anticraft_test2.py`（先用 `.tmp-test\mock_anticraft.py` 起 8302 假服务，再指向真实 `anticraft.top`） | 19 项全通过：自动注册（`source=anticraft`）、二次登录不重复注册、**anticraft 改密后同步且旧密码失效**、密码错 401、空参 400、本地同名 409 且本地密码未被顶掉、不可达 502、真实服务 401（可达性+契约）。UI：`ui-test4.mjs` 8 项全通过（Tab、自动建号提示、跳转、管理页回显） |
| anticraft 授权绑定 | `.tmp-test\oauth_test.py`（mock 扮演授权页与开放接口，按 index 的接入文档实现） | 25 项全通过：未配置 503、来源白名单 400、start→bind→callback→exchange 全链路建号、按 `anticraft_id` 绑定（改名不新建账号）、ticket/state 一次性、二次授权不重复建号、用户拒绝、同名本地账号拒绝、错误 client_secret 回报错。UI：`ui-test5.mjs` 10 项全通过（按钮可用性、真实点击跳转→授权→回跳自动登录、未配置时的登记引导）. 真实 `anticraft.top`：`/api/open/apps/{id}` 与 `/bind` 探活正常（未登记返回 404 白名单提示） |
| 回归 | 改完 anticraft 后重跑 `e2e.py` | 27/28（唯一失败项是 `printer_name` 被人在管理页改成了 `Microsoft Print to PDF`，非代码问题） |
| 换肤（Tailwind + lucide） | `node .tmp-test\ui-test6.mjs`（逐页截图：浅色/深色登录页、提交页与成功态、我的任务、管理后台、驳回弹窗、预览弹窗、anticraft Tab） | 16 项中 15 项通过、1 项因「假设未配置绑定应用」的过期断言失败（实际已配置，脚本已改为跟随 `/api/oauth/anticraft/status`）；页面 JS 错误 0、HTTP 4xx/5xx 0；功能回归（注册/提交/我的任务/管理员审查/驳回必填理由/预览 iframe/退出）全通过 |
| 真实跳转授权（本机 anticraft） | `node .tmp-test\ui-test7.mjs`（不用 mock：授权页是跑在本机的 anticraft，走真实 `/bind` + `/api/open/token`） | 7 项全通过、页面 JS 错误 0：点「跳转授权」→ 本机 anticraft 授权页（显示申请方 `antiprintlocal`、当前账号、跳转地址）→ 点「同意绑定」→ 回跳本项目自动登录（`source=anticraft`、`anticraft_id=126`）；另用 `/api/bind/authorize` 逐个核对回调地址：只认 `http://127.0.0.1:8301/api/oauth/anticraft/callback`，`localhost:3010` 与 `localhost:8301` 均报「回调地址与登记值不一致」 |
| 配送方式 + 交接流转 | `backend\.venv\Scripts\python.exe .tmp-test\e2e2.py` | 26 项全通过：默认配置读写与非法值 400、默认取件时地址可空、显式配送缺地址 400、配送/取件单各自的合法流转、跨方式流转 400、越级 400、重复标记 400、普通用户调用 403、`finished_at` 落库、绑定票据一次性、未绑定账号解绑 400 |
| 队列/配置 UI | `node .tmp-test\ui-test8.mjs` | 14 项全通过：配置页保存默认地址与默认取件、提交页按默认值预填、队列页勾选「待配送」→「已完成」（勾选后状态与时间正确）、用户侧看到新状态；页面 JS 错误 0 |
| 绑定/解绑 UI | `node .tmp-test\ui-test9.mjs`（真实本机 anticraft 授权，自包含可重复） | 7 项全通过：A 账号绑定成功并显示 anticraft 用户 ID → B 账号绑同一 anticraft 账号被拒（提示占用者）→ A 解绑（设置本地密码）后可用新密码登录；页面 JS 错误 0 |
| 打印设置（份数/纸张/页面范围/每张页数/缩放） | `backend\.venv\Scripts\python.exe .tmp-test\print_options_test.py` | 16 项全通过：完整设置落库与回读、默认值、8 类非法值 400、代理 claim 能拿到设置、用户/管理列表都带 print_options；另用代理 `--dry-run` 验证命令行出现 `-print-settings 3x,paper=A3,1-2,2,2,fit` |
| 逐文件设置（API） | `backend\.venv\Scripts\python.exe .tmp-test/per_file_settings_test.py` | 12 项全通过：两文件两套设置各自落库、代理 claim 逐文件带设置、非法纸张/份数 0/非法范围/非 JSON 一律 400、settings 比文件短时缺的回落任务级、不传 settings 时任务级设置仍生效 |
| 文件预览（我的任务 / 管理员队列） | `node .tmp-test/ui-test10.mjs` | 4 项全通过：走两步流程提交后，「我的任务」点文件名弹窗预览渲染 iframe、管理员队列预览正常；页面 JS 错误 0 |
| 两步提交 + 逐文件打印设置 | `node .tmp-test/ui-test13.mjs` | 19 项全通过：第一步选两文件后逐文件各自的设置互不影响、页面范围让预览跳到 `#page=2`、每张页数提示「按 4 页/张排版」、切换文件预览在 iframe/img 间切换、第二步「返回修改打印设置」不丢状态、提交成功卡片逐文件列设置、后端按文件存了两套 print_options |
| 手机端适配 | `node .tmp-test/ui-test14.mjs`（390×844 触摸视口） | 17 项全通过：登录页/提交第一步与第二步/我的任务/任务队列/管理设置/我的配置/用户管理**均无页面级横向溢出**（390/390）、小屏侧栏默认在屏幕外（x=-240）、点汉堡滑出到 x=0、点导航自动收起、手机端完整走通两步提交并成功、队列表格 1001px 靠容器内滚动且带「左右滑动」提示；页面 JS 错误 0 |
| 内嵌预览（投放区变预览面板） | `node .tmp-test/ui-test11.mjs` | 12 项全通过：拖入 PDF 后投放提示消失、面板显示「正在预览」并渲染 iframe，继续拖入图片后点文件名可切换（img 出现、iframe 让位）、「放大查看」走弹窗、「清空」回到投放区、提交后我的任务与管理员队列预览仍正常；页面 JS 错误 0 |

**测试中修掉的真 bug（勿回退）**：
1. **代理把 `dry_run` 判断成恒真** —— 服务端下发的是字符串 `"0"`，`bool("0")` 在 Python 里是 `True`，导致代理永远只干跑却回报成功（任务被误标已打印）。已改为 `truthy()` 解析（`print_agent.py`），**任何服务端开关值都要走它**。
2. **任务列表缺提交人** —— 管理页「提交人」列空白，`db.list_jobs/get_job` 已 JOIN `users.username`。
3. **`/api/login/anticraft` 的 401 曾触发前端「登录已过期」拦截** —— `api.ts` 的 401 白名单只排除了 `/api/login`，已补上 `/api/login/anticraft`（现集中为 `NO_EXPIRY_PATHS`，**新增登录类接口时要同步这里**）。
4. **`POST /api/settings` 曾回明文 client_secret**（GET 已掩码、POST 忘了）—— 已统一走 `_masked_settings()`；`update_settings` 对空串/掩码 `******` 视为「不修改」，清空要直接改库。
5. **登录页告警被 flex 拆成三栏** —— 覆盖 `.alert` 的 display 必须写成 `.alert.xxx`（见「环境事实与坑」的 CSS 优先级一条）。

## 目录规划

```
frontend/          React 18 + Vite + TS；dev 3010，/api 代理到 127.0.0.1:8301；构建产物 dist/（由后端托管）
  src/pages/       LoginPage / SubmitPage / MyJobsPage / ProfilePage（我的配置）/ QueuePage（任务队列，管理员）/ AdminPage（管理设置）/ AnticraftCallbackPage（各带同名 .css 已删除，全部 Tailwind）
  src/components/  Modal / DropZone / FileChips / TextField / ThemeToggle / Icons
  src/api.ts       所有请求的唯一出口（401 统一处理）；src/types/api.ts 接口类型
backend/           FastAPI + MySQL；main.py 入口、db.py 存储层、auth.py 认证、agent_api.py 代理接口、config.py、constants.py
  data/uploads/<job_id>/   上传文件存储（gitignore）；log/server.log 运行日志（gitignore）
  db_config.json / db_config.example.json   DB 凭据（前者 gitignore）
agent/             Windows 打印代理（Python + requests，常驻）
  print_agent.py   轮询/领取/打印/回报；config.json 本机配置（gitignore，模板 config.example.json）
  tmp/<job_id>/    下载的待打印文件（gitignore）；log/agent.log 日志（gitignore）
setup.bat / run.bat / stop.bat / stop.ps1     一键安装 / 启动 / 停止（bat 必须纯 ASCII + CRLF）
```

## 常用命令

> Windows 上 **npm 脚本被 ExecutionPolicy 禁用 → 一律 `npm.cmd`**。

- 后端：`backend\.venv\Scripts\python.exe backend\main.py`（uvicorn **8301**，`reload=False`，改代码后手动重启）
- 前端：`npm.cmd run dev`（Vite 3010，`/api` 代理 `127.0.0.1:8301`）
- 前端类型/构建验证：`npm.cmd run build`（`tsc --noEmit && vite build`，**类型错误会阻断构建**）
- 一键：`setup.bat`（建 venv + 装依赖 + `npm.cmd install` + 构建前端）/ `run.bat`（无窗口起后端 + 代理）/ `stop.bat`（调 `stop.ps1`，按端口与路径精确停本项目进程，**不碰 index/antiClass**）
- 代理：`--selftest`（自检）/ `--printers`（列打印机）/ `--once`（只跑一轮，调试用）/ `--dry-run`（只打命令行不出纸）
- **服务常驻方式（已实测）**：`schtasks /Create /TN AntiPrintRun /TR "cmd /c <仓库>\run.bat" /SC ONCE /ST 00:00 /F` → `/Run` → 删除任务，进程仍活着。`run.bat` 内部用 `start ""` + **绝对路径**拉起 `pythonw.exe`（相对路径会让 stop.ps1 匹配不到）；不要内联 `Start-Process`（会被工具会话回收）。Git Bash 里调 schtasks 要先 `export MSYS_NO_PATHCONV=1`，否则 `/Create` 被当成路径。
- **无 linter、无测试框架**。验证方式：`curl http://127.0.0.1:8301/api/health` + `npm.cmd run build` 通过 + 真实打印一张测试页（见「验证记录」）
- **单条 Bash 调用必须秒级返回（目标 <10 秒）**：重启、curl、构建分成独立调用，不要串联
- 启动服务用 agent 内部终端（`run_in_background`），**不要开新的 cmd/PowerShell 窗口**（用户明确要求）

## 打印代理（本项目最关键，改前通读）

- **技术栈约束**：Python + `requests`，**不依赖 pywin32**（本机默认 Python 3.14 没装 pywin32，只有 conda 里有）。打印机枚举用 PowerShell `Get-Printer`，不要 `win32print`。
- **静默打印命令**：`SumatraPDF.exe -print-to "<打印机名>" -silent -exit-when-done <文件>`；本机路径 `C:\Users\86133\AppData\Local\SumatraPDF\SumatraPDF.exe`（3.6.1，未入 PATH）。打默认打印机用 `-print-to-default`。
- **P1106 是主机型（GDI）打印机**：必须经 Windows 打印驱动渲染输出（SumatraPDF 走 GDI 正好合适）；**禁止往 USB/RAW 端口灌 PDF 原始字节**（该机型不支持 PDF/PCL 直通，只会打出乱码或失败）。
- **任务获取**：轮询（默认 3~5 秒，项目不引 websocket/SSE）。领取必须**原子**：服务端 `UPDATE print_jobs SET status='打印中', agent_id=? WHERE id=? AND status='已通过'`，影响行数为 0 即视为被别的代理抢走 → **防重复打印**（唯一一台打印机的出纸是不可逆操作）。
- **鉴权**：设备令牌（请求头 `X-Agent-Token`，独立于用户 JWT），代理启动时注册/心跳写 `agents` 表（hostname、版本、last_seen、上报的本地打印机列表）；管理页显示「代理在线/离线」，离线时仍可批准入队但要提示管理员。
- **上报**：`POST /api/agent/jobs/{id}/result`，成功写 `已打印` + `printed_at`；失败写 `打印失败` + 错误文本（退出码/超时/SumatraPDF stderr）。
- **失败判定**：退出码非 0、进程超时、打印子进程满 90 秒、打印机队列不可用都要判失败；**不要**仅凭 SumatraPDF 退出码为 0 就认定出纸（纸张/缺纸/离线队列要靠状态回读兜底），必要时用 `Get-PrintJob` 复核队列。
  实测案例（2026-09-14）：app 里显示「已打印」，但 Windows 打印队列里两条任务长期 `JobStatus=Normal` 不动 —— SumatraPDF 只是把任务交给了打印后台，纸没出来（打印机电源/USB 问题）。**验收出纸时必须查 `Get-PrintJob`，不能只看 app 状态**。
- **`install-agent.bat` 注册自启要管理员会话**：`schtasks /RL HIGHEST` 与普通权限都会 `Access is denied`（实测本机非提权会话）；脚本已退回「去掉 `/RL HIGHEST` 再试一次」并保留失败提示。没有管理员权限时用启动文件夹替代（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`）。
- **目标打印机必须是真实队列（HP LaserJet Professional P1106）**：选成虚拟队列（`Microsoft Print to PDF`、OneNote）时 SumatraPDF `-silent` 会卡到 90 秒超时（等保存文件对话框），任务最终判「打印失败」——2026-09-14 18:41 实测过一次（管理员在管理页把打印机改成了 Microsoft Print to PDF）。管理页改过「打印设置」后务必回读确认存的是 P1106。
- **代理是单线程循环**：打印期间（最长 90 秒超时）不心跳也不领任务，管理页会把「最后心跳」判成离线 —— 属正常现象，别误判为代理挂了（看 `agent/log/agent.log` 是否还在推进）。
- **任务在打印途中被管理员删除**：代理回报会拿到 404 并重试 3 次后放弃（日志有明确说明），属预期行为。
- **常驻方式**：`schtasks` 开机任务（`/sc onlogon`）+ `pythonw.exe` 无窗口运行，日志重定向 `agent/log/`。**pythonw 下 `sys.stdout/stderr` 为 None，代码必须兼容**（不兼容会直接崩，`antiClass` 踩过）；打印子进程必须 `CREATE_NO_WINDOW`，否则反复闪黑窗（`index` 踩过）。
- **「默认启动器」**（管理设置页可选，存 `settings` 表下发给代理，断网时用 `agent/config.json` 兜底）：① 启动器程序：SumatraPDF / 系统默认关联程序；② 目标打印机：代理上报的本地队列列表（默认 P1106）；③ 打印参数：份数 / 双面 / 纸张；④ 是否打印封面页（待确认，见下）。
- **开关值一律用 `truthy()` 解析**（`print_agent.py` 顶层）：服务端 `settings` 存的是字符串 `'0'`/`'1'`，`bool('0')` 恒为 `True` —— 曾因此让代理永远只干跑却回报「已打印」。新增任何服务端布尔配置都必须走它。
- **演练模式（dry-run）也会把任务回报成「已打印」**：它只验链路不出纸，别拿它当出纸验证；真要验证出纸必须关掉演练打一张真页。
- `--selftest` / `--printers` / `--once` / `--dry-run` 四个开关覆盖了排查全流程；单实例锁（`agent.lock`）会拦住第二个代理，避免重复出纸。

## 任务状态机

`待审核 → 已通过 → 打印中 → 已打印 →（按配送方式）待配送 / 待取件 → 已完成`；异常支线 `已驳回`（**驳回必填理由**，允许提交人改后重提）、`打印失败`（可重试，回退到「已通过」重新入队）。**每次流转写 `print_jobs_logs` 留痕**（操作者、时间、原状态→新状态、备注）。状态取值用固定中文字符串，前后端共享，改动需两端同步（放 `backend/constants.py` + `frontend/src/constants.ts`）。

**配送方式与交接流转（2026-09-14 新增）**：

- 每个任务带 `delivery_mode`（`配送` / `取件`）：提交页选，留空时取用户配置 `users.default_delivery`；**配送单必须填地址，取件单地址可空**（库里存空串）。
- 出纸后由管理员在**任务队列页**勾选交接（`POST /api/jobs/{id}/advance`，body `{to}`）：`已打印` → `待配送`（仅配送单）/ `待取件`（仅取件单）→ `已完成`（写 `finished_at`）。
- 允许的流转集中在 `constants.HANDOVER_NEXT`（`{当前状态: {目标状态: 该目标要求的配送方式}}`），**服务端强校验**：配送单不能标「待取件」，反之亦然；重复标记、越级流转一律 400。改状态机只改这一张表 + 两端 constants。
- 用户侧在「我的任务」看到同样的徽章与提示（待配送=等待管理员送达、待取件=到打印点自取、已完成=完成时间）。

## 打印设置（**逐文件**可选，2026-09-15 起）

- **数据**：**每个文件一套设置** —— `print_job_files.print_options`（JSON 文本，含 `copies`）；`print_jobs.copies` / `print_jobs.print_options` 保留为**任务级默认**（老任务与不传 `settings` 的调用方走它）。取值**就是 SumatraPDF `-print-settings` 的原生 token**，白名单在 `constants.py`：`PRINT_PAPER`（A4/A3/A5/B5/Letter/Legal）、`PRINT_NUP`（"1,1"/"2,1"/"1,2"/"2,2"/"3,3"/"4,4"，即「行,列」）、`PRINT_SCALE`（fit / noscale / shrink）、页面范围（只允许数字/逗号/短横线，≤64 字）、份数 1~99。**没有双面/彩色**：目标机型是黑白激光、无自动双面单元，2026-09-15 按用户要求移除，接口传了也会被忽略。
- **接口**：`POST /api/jobs` 接受 **`settings`**（JSON 字符串，**数组与 `files` 顺序一一对应**，如 `[{"copies":2,"paper":"A3","pages":"1-2","nup":"2,2","scale":"fit"}]`；数组比文件短时缺的回落任务级默认），并兼容任务级 `copies/paper/pages/nup/scale`；逐项白名单校验、非法值一律 400。任务出参与代理 `claim` 里**每个文件**都带解析好的 `print_options`。
- **代理**：打印每个文件前按 **文件级 → 任务级 → 全局设置** 取该文件的设置，`PrintAgent.build_print_settings(copies, options)` 拼成一条 `-print-settings`（顺序：份数 → 纸张 → 页面范围 → 每张页数 → 缩放，例如 `3x,paper=A3,1-3,2,2,fit`）；日志打印「应用打印设置：…」，排查「设置没生效」先看这一行。
- **前端**：提交页是**两步向导** —— ①「打印文件与设置」：投放区（`DropZone` 加 `hideChips`）→ 自绘文件行列表（点行选中）→ 右栏编辑**选中文件**的设置（`#file-settings-copies/paper/pages/nup/scale`，切换文件各自保留）→ 右栏预览按设置显示（PDF `#page=<页面范围起始页>`、图片 img、高 480px；每张页数 ≠ 1 时提示「按 N 页/张排版，预览为单页视图」）；②「配送与备注」：配送方式/地址/备注 + 「返回修改打印设置」+「提交打印任务」。摘要文案统一 `describePrintOptions(options, copies)`。

## 数据库（MySQL 8）

- 连接配置：`backend/db_config.json`（gitignore）—— 模板 `backend/db_config.example.json`；环境变量 `MYSQL_HOST/PORT/USER/PASSWORD/DB` 可覆盖；默认库 `antiprint`（utf8mb4）。密码字符集只用字母数字 `_` `-`（含 `@` 会破坏 URL 拼接，`index` 出过事故）。
- 启动自动建库建表；**`create_all` 不给已存在的表补列** → 新增列必须同步写进 `db.py` 的 `run_migrations()`，否则旧库报 `Unknown column`（`index` 反复踩过）。
- 表：`users`（含 role、`source`、`anticraft_id`、`default_address` 默认配送地址、`default_delivery` 默认配送方式）、`print_jobs`（status/address/note/reject_reason/print_error/agent_id/`delivery_mode` 配送方式/claimed_at/printed_at/`finished_at` 完成时间）、`print_job_files`（任务文件）、`print_jobs_logs`（流转留痕）、`agents`（设备+心跳+能力）、`settings`（k/v：agent_token、启动器、打印机、份数、dry_run、anticraft_* 等）。
- **`set_status()` 只认白名单字段**（`allowed = {reject_reason, print_error, finished_at}`）：新增「随状态一起写」的列，必须同时加进这个集合，否则会被静默丢弃（2026-09-14 踩过：`finished_at` 没写进去）。
- **`settings` 的值全是字符串**（如 copies=`'1'`、dry_run=`'0'`）：后端读出来要按字符串用，代理侧开关判断必须走 `truthy()`（见打印代理一节）。
- `list_jobs` / `get_job` 已 JOIN `users` 带出 `username`（管理页「提交人」列），改 SQL 时别丢这个字段。
- `users.source`：`local`（AntiPrint 自建）/ `anticraft`（anticraft 账号自动创建）。`set_user_password()` 用于 anticraft 侧改密后同步本地密码；`create_user(username, hash, role, source)` 的第四个参数别漏。
- 账号相关接口（`/api/login`、`/api/login/anticraft`）**共用同一个 IP 限速桶（10 次/分钟）**：写自动化测试脚本时会连续触发 429（这是功能正常的信号）。测试要分批跑或等 60 秒窗口；重启后端可清空内存里的计数器。
- 多步写操作走事务（`db.tx()` 风格）。

## 认证与权限

- 复用 `D:\anticraft\index` 的模式：**SHA-256 预哈希 → bcrypt**（绕过 72 字节限制，直接 `import bcrypt`，不用 passlib）、**pyjwt HS256 24h**（不用 python-jose，避免 C 扩展编译）。
- 前端 token 存 `localStorage.token`、用户信息 `localStorage.user`，请求头 `Authorization: Bearer <token>`；**所有带 token 的请求必须走 `api.ts` 的 `request()`**（统一 401 拦截 → 清 localStorage → 弹「登录已过期」，绕开就丢这套行为）。
- **角色三档**：`user`（普通用户）< `admin`（管理员）< `root`（超级管理员）。后端 `auth.require_admin` 放行 admin 与 root，`auth.require_root` 只放行 root；**文件访问判断也要用 `user["role"] not in ("admin", "root")`**（曾只判 `!= "admin"`，root 会被挡在自己的接口外）。
  - 用户管理接口（2026-09-14 新增）：`GET /api/users`（admin/root 可看：角色/来源/anticraft 绑定/任务数/注册时间）、`POST /api/users/{id}/role`（**仅 root**，body `{role: 'user'|'admin'}`）。护栏：不能改自己的角色、不能改 root 的角色、**不允许通过接口把谁设成 root**（role 只能 user/admin）。
  - 线上 `end` = root（本机同样）；`end` 是经 anticraft 授权登录自动建号的账号（`source=anticraft`）。前端 `/users` 页（侧栏「用户管理」）只对 root 显示，root 在那里把普通用户提拔为管理员 / 收回管理员。
  - anticraft 管理员映射：`_promote_if_anticraft_admin()` 只把 **user** 提升为 admin（不动 admin/root，不降级）；密码登录路径优先用 anticraft 返回的 `role`，OAuth 路径因其开放接口不返回角色，走设置项 `anticraft_admin_users`（逗号分隔用户名）。
- 默认管理员播种（`ADMIN_PASSWORD` 环境变量可覆盖），登录限速（5 次/分钟/IP）。
- **文件下载/预览必须鉴权**：仅任务提交人本人或管理员可取，带 `Content-Disposition` + `X-Content-Type-Options: nosniff`；`agents` 令牌只能领取/回报任务，**不得读他人文件**。

## 上传与安全

- 单文件 ≤10MB、单任务 ≤5 个文件；**扩展名黑名单**（可执行/脚本/网页/Office 宏等一律 400，沿用 `antiClass` 的 `DANGEROUS_EXT` 思路）；sha256 内容去重；文件名净化 + 防目录穿越（存 `backend/data/uploads/<job_id>/`，库内存相对路径）。
- 白名单优先：可静默打印的 **PDF / png / jpg** 直接放行，其余类型按「已知未定义」处理。

## 前端约定

- **技术栈**：React 18 + Vite + TypeScript（strict）+ **Tailwind CSS v4**（`@tailwindcss/vite` 插件，无 config 文件，token 写在 `src/index.css` 的 `@theme`）+ **lucide-react** 图标。**不要**再写页面私有 CSS 文件、不要引入其它 UI 组件库、**禁止 emoji**。
- **设计 token（`src/index.css`，语义色勿散落 hex）**：`bg-warm`(#faf8f5 暖米白底) / `bg-brand`(#4a9d9a 青绿主色) / `bg-amber`(#e8b86d) / `bg-clay`(#c17767 警示) / `bg-slate-teal`(#6b8e8e)；深色底 `bg-ink`(#1f1f1e) / `bg-ink-soft`(#2b2b2a 卡片)；阴影 `shadow-card`(极低透明度大扩散) / `shadow-brand`；字体 `font-sans` 已在 base 层设置。
- **深色模式**：`@custom-variant dark` 绑定到 `<html data-theme="dark">`（由 `ThemeToggle` 三态开关写入）。**每个颜色/边框/底色类都要配 `dark:` 变体**（卡片 `dark:bg-ink-soft`、边框 `dark:border-white/10`、次级底 `dark:bg-white/5`）。
- **常用配方（照抄，保证全站一致）**：
  - 卡片：`rounded-2xl bg-white p-6 shadow-xl shadow-black/[0.04] dark:bg-ink-soft`；需要悬浮感再加 `transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl`
  - 主按钮：`inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-brand/25 transition-all duration-200 hover:bg-brand-dark hover:shadow-xl hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60`
  - 次按钮：`inline-flex items-center gap-1.5 rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-gray-600 shadow-lg shadow-black/5 hover:-translate-y-0.5 hover:shadow-xl dark:bg-ink-soft dark:text-gray-300`
  - 危险按钮：次按钮基础上换 `bg-clay text-white shadow-clay/25`
  - 输入/文本域：`w-full rounded-xl border border-gray-200 bg-warm px-4 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 dark:border-white/10 dark:bg-white/5 dark:text-gray-100`
  - 表格：`w-full` + 表头 `border-b border-gray-100 dark:border-white/10` 与 `px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400` + 行 `group border-b border-gray-50 transition-colors hover:bg-warm dark:border-white/5 dark:hover:bg-white/5`；行内操作按钮用 `opacity-0 transition-opacity group-hover:opacity-100`
  - 徽章：`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium`，配色一律「同色 10% 底 + 本色字」
  - 弹窗：遮罩 `fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm`，面板 `w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl dark:bg-ink-soft`
  - 空状态：`flex flex-col items-center gap-3 rounded-2xl border border-dashed border-gray-200 bg-white/60 px-6 py-16 text-center text-sm text-gray-400 dark:border-white/10 dark:bg-white/5`
  - 提示条：`flex items-start gap-2 rounded-xl px-4 py-3 text-sm` + 语义色
- **状态徽章取色**（6 个状态，勿改）：待审核 `bg-amber/15 text-amber-700 dark:text-amber`；已通过 `bg-brand/10 text-brand-dark dark:text-brand`；打印中 `bg-slate-teal/15 text-slate-teal`；已打印 `bg-emerald-500/10 text-emerald-600 dark:text-emerald-400`；已驳回 `bg-clay/10 text-clay`；打印失败 `bg-red-500/10 text-red-600 dark:text-red-400`。
- **图标**：一律 `lucide-react`（`h-4 w-4` 行内 / `h-5 w-5` 标题与品牌 / `h-[18px] w-[18px]` 侧栏导航）；`components/Icons.tsx` 已废弃删除，不要再 import。
- **外壳**：`App.tsx` 是参考实现——已登录 = 240px 可折叠侧栏（`w-60`↔`w-0`，主区 `ml-60`↔`ml-0` 过渡）+ 吸顶栏（`sticky top-0 bg-warm/80 backdrop-blur-md`，标题取自 `PAGE_META`）+ 右下角 toast；未登录 = 只有品牌条（登录页/回调页）。新页面照此风格写，不要再造导航。
- **移动端适配（2026-09-15 起）**：断点用 Tailwind 默认（`lg` = 1024px）。① 侧栏：`<lg` 是**抽屉**（`fixed w-60` + `-translate-x-full` 收起，默认收起，点汉堡滑出、点遮罩或点导航自动收起，遮罩 `z-30`/侧栏 `z-40`）；`lg` 起才是常驻并把主区推到 `lg:ml-60`。② 内边距：`px-4 py-3 md:px-8 md:py-4` 一档缩放，副标题 `<sm` 隐藏。③ 预览高度随屏幕：提交页预览 `h-[300px] sm:h-[480px]`，弹窗 `h-[60vh] lg:h-[80vh]`。④ 表格保持 `min-w-*` + 容器 `overflow-x-auto`（页面本身不允许横向滚动），队列页在 `<lg` 提示「左右滑动查看完整表格」。⑤ 新增页面的验收要跑 `.tmp-test/ui-test14.mjs`（390×844 视口，检查每页 `documentElement.scrollWidth <= innerWidth`、抽屉行为、两步提交可走通）。
- 复用组件（勿重造）：`Modal`（确认弹窗统一用它，不用 `window.confirm`）、`DropZone`（`previewInline` 时**选完文件把投放区变成预览面板**：内嵌 iframe/img + 切换文件 + 继续添加 + 清空 + 放大查看）、`FileChips`、`TextField`（所有文本输入）、`ThemeToggle`、**`FilePreview`**（预览弹窗：PDF→iframe、图片→img、其它→提示下载；给 `jobId`+`fileId` 由组件带 Bearer 取 blob，或给 `localUrl` 预览本地文件）。预览入口共三处：提交页（拖入即内嵌预览，可放大到弹窗）、我的任务（本人上传件，弹窗）、任务队列（管理员，弹窗）。
- react-router-dom v7，路由集中在 `App.tsx`，页面在 `src/pages/`。
- 管理端预览 PDF 用**同源** blob→iframe（`/api/jobs/{id}/files/{fid}`，需 Bearer 头，所以走 `fetch` + `URL.createObjectURL`，关闭时 `revokeObjectURL`）；跨域源无法内嵌预览。
- UI 文案、注释、文档、提交信息**一律简体中文**；提交信息结构化（单行标题概括整批 + 正文按模块分节）。

## 部署（Windows → 阿里云 47.100.125.150）

- **已部署（2026-09-14）**：代码在 `/var/www/antiprint`（`backend/` + `frontend/dist` + 文档），venv 在 `backend/.venv`，systemd 单元 `antiprint-api`（`WorkingDirectory=/var/www/antiprint/backend`、`ExecStart=.../uvicorn main:app --host 127.0.0.1 --port 8301`、`Environment=SECRET_KEY=<随机 64 位 hex>`）；MySQL 建了独立库 `antiprint` 与专用账号 `antiprint`（口令与 anticraft 的库口令一致，写在 `/var/www/antiprint/backend/db_config.json`，权限 600）；**前端 dist 随包上传，由后端单进程托管**（同 `antiClass`）。
- **管理员账号**：线上为 `end`（role=admin）；播种的 `admin` 口令已随机化（`admin123` 登录返回 401）。建号脚本：`.tmp-test/server_create_admin.py`（从 stdin 读用户名与口令，命令行不落口令）。
- **nginx**：站点配置在服务器 `/etc/nginx/sites-available/antiprint`（仓库留档 `deploy/nginx-antiprint.conf`，`print.anticraft.top` → 127.0.0.1:8301，`client_max_body_size 60m`）。**DNS 解析生效后**再启用：`ln -sf ... sites-enabled/ && nginx -t && systemctl reload nginx && certbot --nginx -d print.anticraft.top`；服务器上 `/root/finish-antiprint-deploy.sh` 把「写线上设置 + 启用 nginx + 申请证书 + 自测」打包成一步（幂等，DNS 未生效会自动跳过 nginx 部分）。2026-09-14 部署时 `print.anticraft.top` 尚无 A 记录，故域名证书待启用。
- **线上入口（2026-09-14 定型）**：`https://print.anticraft.top/` 是**主入口**（Let's Encrypt 证书，`certbot --nginx` 签发、90 天自动续期、http 301 跳 https）；`http://47.100.125.150/` 是明文回退入口；`https://47.100.125.150/` 用**自签证书** `/etc/nginx/ssl/antiprint-ip.{crt,key}`（CN/SAN = IP，600 权限）——浏览器会提示「不受信任」，**Let's Encrypt 明确不为纯 IP 签发证书**（`certbot ... -d <IP>` 会被拒，实测）。**8301 端口被阿里云安全组封锁**，外网只通 80/443。
- **certbot 改写 nginx 的坑（改配置前必读）**：`certbot --nginx --redirect` 会把 :80 的 server 块就地改写成「301 + `return 404`」，并**接管原块的 server_name**——当时它把 IP 一起写进了 `server_name print.anticraft.top 47.100.125.150;`，与另加的 IP :80 块**冲突**（nginx 只给一条 `conflicting server name ... ignored` 警告，现象是 `http://47.100.125.150/` 返回 404）。解法：把 IP 从 certbot 那块删掉、只留域名，IP 单独一个 server 块；改完 `nginx -t` 必看有没有 conflict 警告。
- **管理页「保存设置」会把打印机一起写库**：2026-09-14 两次（本机 18:25、线上 22:3x）把 `printer_name` 写成 `Microsoft Print to PDF`——虚拟队列会让静默打印卡 90 秒超时判失败。已加护栏：前端选中虚拟队列（print to pdf / onenote / xps / fax）时显示红色警告，打印机名称为空时**不提交**该字段。线上值已改回 P1106。
- **本机 DNS 缓存**：域名解析生效后，这台 Windows 的上游解析器（路由器）可能仍缓存旧的 NXDOMAIN（`nslookup` 报 Non-existent domain），现象是浏览器打不开域名；`ipconfig /flushdns` 只清本机缓存，公共解析器（8.8.8.8/223.5.5.5/114）与服务器都正常——等路由器缓存过期/重启路由器即可（自测可用 `curl --resolve print.anticraft.top:443:47.100.125.150`）。
- **线上 anticraft 登录要能用**，必须先在 **anticraft.top** 后台登记本应用、回调地址填 `https://print.anticraft.top/api/oauth/anticraft/callback`，再把 `client_id`/`client_secret` 填进线上「管理设置」（线上 `anticraft_base` 已是 `https://anticraft.top`，`anticraft_origins` 已含生产域名）。
- **打印代理不部署在服务器**（云服务器够不到本机 USB 打印机），只跑在管理员这台 Windows 上。**当前 `agent/config.json` 已指向线上 `http://47.100.125.150` + 线上令牌**；等本机能解析域名后可换成 `https://print.anticraft.top`（`agent/config.prod.json` 已备好，含线上令牌、gitignore），本机开发用的那份在 `agent/config.local.json`。
- **更新部署一律用 `bash deploy/pack.sh`**（在本仓库根目录的 Git Bash 里跑）：它按正确的排除清单打包（`.venv` / `backend/data` / `backend/log` / `backend/db_config.json` / `node_modules` / `__pycache__`）→ `scp` 上传 → 解包覆盖 `/var/www/antiprint`（不动线上 db_config.json 与 data）→ 重启 `antiprint-api` → 自测健康与首页。`--dry-run` 只打包并列出包内文件。前端改过要先 `npm.cmd run build`。
- **打包排除清单是血泪教训（2026-09-14 两次事故）**：① 漏排除 `db_config.json` → 线上库凭据被本机凭据覆盖，服务立刻 `db:error`；② 漏排除 `backend/data` → 本机 `uploads/` 覆盖线上，残留目录与新任务号撞名，用户提交报「文件保存失败，请重试」（`os.rename` Errno 39 Directory not empty）。`deploy/pack.sh` 已内置校验：包内一旦出现这些路径直接中止。
- 服务已在 127.0.0.1:8301 上；**提交任务失败时先查 `uploads/` 是否有库里不存在的残留目录**（`ls uploads | sort -n` 对比 `SELECT id FROM print_jobs`），`main.py` 现在遇到同名残留会先清理再落盘并在日志里警告。
- 服务器已占用端口参考：index 8000、antiClass 8100、GEOMind 18000、AntiPrint 8301；nginx 站点配置目录既有 `anticlass`、`anticlass-domain`、`anticraft` 三份。
- **部署红线（硬性）**：未经用户明确同意，禁止运行任何部署脚本或发布到服务器；**代理不得读取、展示或上传 `deploy*.bat` 等脚本中的任何凭据**——凭据只由用户本人使用。功能完成后只启动本地服务供验收，等用户说「发布到服务器并 git」再部署。
- 兄弟项目做法：部署脚本含凭据、已 gitignore、仅本机存在（参考 `index/deploy.bat` 家族）；**不要提交任何含凭据的文件**（`deploy/nginx-antiprint.conf` 只含反代配置，无凭据）。

## 已知未定义（实现前须与用户确认，勿臆测）

1. **Office（docx/xlsx/pptx）如何转 PDF 才能静默打印** —— 需本机 Office/WPS COM 还是 LibreOffice headless？在确认前，Office 文件应按「不支持静默打印」明确拒绝或提示。
2. 配送地址是否要打印成**封面页/面单**（当前默认：仅线上跟踪，不打印）。
3. 用户注册是否需要**邀请码**（`index` 用邀请码门控），还是管理员建号。
4. 域名（`print.anticraft.top`？）与最终端口分配。
5. 是否需要多台打印代理 / 多管理员；打印配额与限流（如每用户每天 N 单）。
6. 任务列表刷新方式与轮询间隔（当前默认 5 秒轮询）。
7. 图片类任务的多页排布规则（一张/多张图如何分页、是否缩放到 A4）。

## 环境事实与坑（Windows 本机）

- 默认打印机 `HP LaserJet Professional P1106`；同机还有其他虚拟队列（`Microsoft Print to PDF`、OneNote）——**选打印机时不要用「默认」二字想当然**，按名称精确指定。
- SumatraPDF 3.6.1 在 `C:\Users\86133\AppData\Local\SumatraPDF\SumatraPDF.exe`（**不在 PATH**，用绝对路径；`SumatraPDF-settings.txt` 里有 `PrinterDefaults`，会记住上次的打印机/份数，排查「参数不生效」时先看它）。
- 浏览器：Chrome `C:\Program Files\Google\Chrome\Application\chrome.exe`、Edge `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`（仅用于本地验证管理页；**打印不走浏览器**）。
- **本机端口占用（2026-09-14 实测）**：3000（index 前端）、8000（index 后端）、3306（MySQL）、**8300 与 12390/14013-14023 被 natpierce.exe（内网穿透工具，用户自己在跑，勿杀）占用**。AntiPrint 用 **3010 / 8301**，两端口实测可绑定（绑 8300 会报 WinError 10013）。Windows 保留端口区间（2869、50000-50059）不与本次端口冲突。
- Shell 为 Git Bash / PowerShell；npm 脚本被 ExecutionPolicy 禁用 → **用 `npm.cmd`**；**pip 全局配置指向清华镜像，对 Python 3.14 会返回空**（报「Could not find a version that satisfies the requirement fastapi (from versions: none)」）→ 必须加 `-i https://mirrors.aliyun.com/pypi/simple/`（`setup.bat` 已内置）。
- **Git Bash 调 schtasks 要先 `export MSYS_NO_PATHCONV=1`**，否则 `/Create`、`/Run` 被 MSYS 当路径转换成 `C:/Program Files/Git/Create` 而报错。
- **`.bat` 里不要写多行 `^` 折行的 PowerShell**（实测静默不执行）→ 复杂逻辑放 `.ps1`，bat 只做 `powershell -File "%~dp0xxx.ps1"` 调用；`.bat` 必须纯 ASCII + CRLF。
- **venv 的 `pythonw.exe` 是启动器**，会再拉起一个 `C:\Python314\pythonw.exe` 子进程 —— 数进程时会看到成对出现，属正常；判断「是否重复启动」以端口监听数 + `agent.lock` 为准。
- **anticraft 登录怎么测**：优先用**本机跑着的 anticraft**（`D:\anticraft\index`，前端 Vite `http://localhost:3000`、后端 `127.0.0.1:8000`，绑定接口齐全）——把「打印设置」的 `anticraft_base` 指到 `http://localhost:3000`，就能跑**真实**的跳转授权（`.tmp-test/ui-test7.mjs` 用 index 文档里的本地测试账号 `demotools/DemoTools123` 注入登录态后点「同意绑定」，7 项全通过）。**回调地址逐个精确匹配**：本机 anticraft 里当前只登记了 `http://127.0.0.1:8301/api/oauth/anticraft/callback`（应用名 `antiprintlocal`），所以要用 8301 访问本项目；想用 Vite 3010 测，得先去本机 anticraft 管理后台把 `http://localhost:3010/api/oauth/anticraft/callback` 也加进该应用的回调列表。若手上没有真实账号可用 `.tmp-test/mock_anticraft.py`（`uvicorn mock_anticraft:app --port 8302`，在 `.tmp-test` 目录下跑）顶替，测完把 `anticraft_base` 改回目标地址。注意 `stop.bat` 会连 mock 一起杀掉（它用的是本项目 venv），重启后端后记得重新拉起 mock。
- **本机 vs 线上 anticraft 切换**：`anticraft_base` 一个字段搞定（`http://localhost:3000` ↔ `https://anticraft.top`）；两边各自维护白名单，`client_id`/`client_secret` 不同，切换时要连服务地址一起换。`anticraft.top` 目前**尚未登记**本应用（2026-09-14 公开接口查 `ac_...` 返回 404），线上启用前需在 anticraft.top 后台登记同一个回调地址。
- **前端 CSS 覆盖全局类必须提高优先级**：页面 CSS 里写 `.alert.xxx { display: block }` 这类覆盖，**不能只写 `.xxx`** —— 打包后全局 `index.css` 排在页面 CSS 之后，同优先级下后写的生效（2026-09-14 实测：登录页告警被 `.alert` 的 flex 拆成三栏竖排）。
- **UI 自动化验证环境**（项目本身不装测试依赖）：复用 `D:\anticraft\index\node_modules\playwright-core` + 本机 chromium `C:\Users\86133\AppData\Local\ms-playwright\chromium-1234\chrome-win64\chrome.exe`，脚本在 `.tmp-test/`（临时文件，可删）。**别用 `input[type=text]` 选配送地址**（`TextField` 不写 `type`，会选到备注 textarea/文件输入框，浪费一轮）。
- 优先移植兄弟项目实现，**不引入新依赖**（`index` 的 `auth.py`/`db.py`、`antiClass` 的 `save_upload`/驳回-重提流程可直接借鉴）。
- 已有兄弟项目文档可查：`D:\anticraft\index\AGENTS.md`（认证、部署、坑最全）、`D:\anticraft\antiClass\AGENTS.md`（上传/审批/单进程托管）。

## 验证清单（每次交付前逐条过）

1. `curl http://127.0.0.1:8301/api/health` 通，且 `curl http://127.0.0.1:8301/` 返回前端页面（后端单进程托管 dist）；
2. `npm.cmd run build` 无类型错误；
3. 接口链路：`backend\.venv\Scripts\python.exe .tmp-test\e2e.py`（28 项）全绿；
4. UI 链路：`node .tmp-test\ui-test3.mjs` 全绿（登录/提交/同意/驳回/预览/代理在线）；
5. **真实出纸**：管理页同意一单 → 代理 `--once`（演练必须关闭）→ 任务转「已打印」+ 打印机队列清空（静默打印链路必须真机验证，不能只看接口返回）；
6. 重启后端/代理后状态不丢（状态在 MySQL，不在内存）。
