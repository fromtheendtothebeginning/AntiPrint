# AGENTS.md — AntiPrint · 远程打印服务

用户远程提交打印任务（上传文件 + 配送地址），管理员审核通过后由**本机打印代理静默出纸**。三进程：React+TS 前端 / FastAPI+MySQL 服务器 / Windows 打印代理。

> **项目状态（2026-09-14）**：三端代码已落地，并已部署到阿里云（systemd `antiprint-api` + nginx，管理员账号 `end`）。文档分工：`README.md` 面向使用者、**`docs/admin-guide.md` 面向管理员与运维**（建管理员、审核交接、在接打印机的机器上装代理、故障排查）、本文面向 AI 代理（契约、坑、红线）。
>
> **补充（2026-09-16）**：新增两个**用户侧客户端**，都不参与线上部署、改动不碰既有三端：`vprinter/`（虚拟打印机，打印 = 转 PDF 提交）与 **`miniprogram/`（kbone 微信小程序，只做提交/查询，不做管理端）**。

## 已定决策（勿擅自改动，改动前先问用户）

| 决策点 | 结论 |
|---|---|
| 前端 | React 18 + Vite + **TypeScript（strict）**，`@/*` 路径别名；**Tailwind CSS v4 + lucide-react**（2026-09-14 全站换肤为暖色仪表盘风格，token 见「前端约定」；不再用页面私有 CSS / 内联 SVG 图标库） |
| 后端 | Python 3.14 + FastAPI + PyMySQL + **MySQL 8**（与 `D:\anticraft\index`、`antiClass` 一致） |
| 静默打印 | **本机常驻打印代理**领取任务后静默打印（不用 `window.print()`，浏览器无法程序化选打印机/份数） |
| 计费 | **管理员/root、anticraft 账号、白名单（`settings.free_users`）免费**；其余账号按「张数 × 单价」扣余额，单价存 `settings.print_price`（默认 0.1 元/张，管理设置可改）。**提交时扣**、驳回/撤回/未出纸的删除**自动退**；充值/付款码**暂未实现**（余额由管理员在「用户管理」手工调整）。见「账户余额与计费」 |
| API 文档页 | **「API 文档」页的正文是 Markdown，存 `settings.api_docs_md`**（空 = 用 `backend/api_docs.py` 的 `DEFAULT_DOCS` 出厂文档）。`GET /api/docs/api` **登录可读**；`PUT /api/docs/api` **仅 admin**（body `{content}`，传空 = 恢复出厂）。前端用 `marked` + `DOMPurify` 渲染（`.md-body` 那套样式在 `index.css`）。**改接口时同步改 `api_docs.py`**（文档是随代码发布的默认版本） |
| 虚拟打印机页 | **「虚拟打印机」页提供下载 + 使用说明**；清单在 `backend/downloads.py`（**当前只开放 Windows x86-64 的 zip**，macOS/Linux 标 `available: False` = 页面显示「暂未开放」）。包放 `backend/data/downloads/`（开发期也认仓库 `dist/`），`GET /api/downloads` 给清单、`GET /api/downloads/{id}` 流式下载（**都要登录**，只认白名单 id、不接路径）。`deploy/pack.sh` 会单独 scp 最新的 `dist/AntiPrintVPrinter-*.zip` 上去并删掉旧版本。**三个平台图标必须是官方品牌标记**（`src/components/OsIcons.tsx`，取自 Simple Icons v9 的 `windows` / `apple` / `linux` 路径，CC0-1.0；新版 Simple Icons 因微软商标政策下架了 `windows`，所以锁 v9、别再 `npm i simple-icons` 取新的），**别换回 lucide 的 Monitor / TerminalSquare 这种通用图标** —— 用例里有 `svg[aria-label]` 的三条断言当护栏 |
| 打印内容 | **仅文件上传**：PDF / 图片（png/jpg）直接可打印；**Word / PPT 上传时服务端先转 PDF**（LibreOffice headless，Windows 无 LibreOffice 时用本机 Office COM，见「Office 转 PDF」） |
| 虚拟打印机 | **用户端只要「打印成 PDF 再提交」**：跨平台桌面程序（`vprinter/`，Python + tkinter + pystray）建一台名叫 `AntiPrint-<版本>`（默认 `AntiPrint-1.0.0`，驼峰 + 版本号）的系统打印队列，打印到它就等于「转 PDF + 走 `POST /api/jobs` 提交到本站」。Windows 用系统自带的 `Microsoft Print To PDF` 驱动 + **固定文件端口**（不写驱动、不写内核组件）；macOS/Linux 用 **CUPS 后端**。**不做**「打印完自动审批」（仍走管理员审核），也不碰实体打印机。见「虚拟打印机」 |
| 本地端口 | 后端 **8301**、Vite **3010**（3000/8000 被 `index`、**8300 被 natpierce 内网穿透工具占用**，2026-09-14 实测；3306 有 MySQL 在跑） |
| 目标打印机 | `HP LaserJet Professional P1106`（USB001，本机唯一真实打印机，**主机型/GDI**）。**注意**：管理页「保存设置」会把下拉当前值一起写库，2026-09-14 18:25 被改成过 `Microsoft Print to PDF`（虚拟队列，静默打印会弹保存对话框）——改打印机后务必确认存的是 P1106。 |
| 账号体系 | **anticraft 账号绑定登录**（协议：`D:\anticraft\index\docs\account-binding-api.md`）。① 主用：OAuth 授权码模式——前端跳 `GET /api/oauth/anticraft/start`（302 到 anticraft `/bind`）→ 用户确认 → 回跳 `GET /api/oauth/anticraft/callback`（服务端用 client_secret 换 token）→ 按 **anticraft 用户 ID** 绑定/创建本地账号（`users.source='anticraft'`、`users.anticraft_id`）→ 302 回前端落地页带一次性 ticket → `POST /api/oauth/anticraft/exchange` 换本地 JWT。密码不经过本项目。② 备用：`POST /api/login/anticraft` 用账号密码向 anticraft 校验（自动建号 + 密码同步）。③ 本地自建账号同名时**一律拒绝**（防顶号，含 admin）。**启用跳转授权必须先在 anticraft 后台「绑定应用」登记** `client_id`/`client_secret` 与**精确回调地址**，再填进「打印设置」（`anticraft_base` / `anticraft_client_id` / `anticraft_client_secret` / `anticraft_origins`） |
| 微信小程序 | **kbone（`mp-webpack-plugin`）独立工程 `miniprogram/`**：`frontend/`/`backend/`/`agent/` 源码不动，只通过 webpack 别名 `@shared → ../frontend/src` **只读**复用接口类型与状态/选项常量（口径与网站永远一致）；React 17（kbone 需要）+ 手写 wxss 类名（不用 Tailwind）。**范围限用户端**：登录/提交/我的任务/我的余额/我的配置五个 Tab 页，**不做管理端、不做头像、不做 anticraft 跳转授权**；提交一次只能一个文件（`wx.uploadFile` 限制，后端也没有追加文件接口）。见「微信小程序（kbone）」 |

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
| 手机端适配 | `node .tmp-test/ui-test14.mjs`（390×844 触摸视口） | 22 项全通过（2026-09-15 补 3 项层级断言 + 2 项侧栏分组断言）：**侧栏分两组——日常入口在上、设置项（我的配置/管理设置）贴底且在用户卡片上方**；**抽屉展开时遮罩层级高于吸顶栏（40 > 30）、侧栏高于遮罩（50 > 40）、顶栏被遮罩盖住（点上去命中的是遮罩 → 顶栏变灰，两者不再打架）**；登录页/提交第一步与第二步/我的任务/任务队列/管理设置/我的配置/用户管理**均无页面级横向溢出**（390/390）、小屏侧栏默认在屏幕外（x=-240）、点汉堡滑出到 x=0、点导航自动收起、手机端完整走通两步提交并成功、队列表格 1001px 靠容器内滚动且带「左右滑动」提示；页面 JS 错误 0 |
| 撤回 / 重新打印 / 删除 | `backend\.venv\Scripts\python.exe .tmp-test/withdraw_reprint_test.py`（15 项）+ `node .tmp-test/ui-test15.mjs`（11 项） | API：待审核与已通过可撤回、已撤回/打印中/已打印不可撤、他人撤回 403、普通用户重打 403、已打印与待配送可重打且清掉 printed_at、重打后能被代理再次领取、已撤回不可重打、管理员可删除（删后 404）。UI：撤回按钮与确认弹窗、撤回后状态变「已撤回」且按钮消失、队列「重新打印」把任务打回已通过、「删除」二次确认后行消失且接口 404；页面 JS 错误 0 |
| 内嵌预览（投放区变预览面板） | `node .tmp-test/ui-test11.mjs` | 12 项全通过：拖入 PDF 后投放提示消失、面板显示「正在预览」并渲染 iframe，继续拖入图片后点文件名可切换（img 出现、iframe 让位）、「放大查看」走弹窗、「清空」回到投放区、提交后我的任务与管理员队列预览仍正常；页面 JS 错误 0 |
| 队列一行式布局（2026-09-15） | `node .tmp-test/ui-test16.mjs` | 16 项全通过：表头合并成 5 列、**除长地址外每行单行（49px，长地址行允许 101px）**、任务号/提交人/时间同行、文件与各自设置同行、配送徽章与地址同格、驳回理由截断成一行、操作区单行且「同意/驳回/删除」同一 y 坐标、**非地址列内容不溢出（超出即省略号）**、操作列装得下「重新打印/待配送/删除」、1920 视口下表格不横向滚动且操作列完整可见、点「同意」仍可用；页面 JS 错误 0 |
| Office（Word/PPT）转 PDF（2026-09-15） | `powershell -File .tmp-test/make_office_fixtures.ps1`（造测试件）+ `backend\.venv\Scripts\python.exe .tmp-test/office_convert_test.py`（34 项）+ `node .tmp-test/ui-test17.mjs`（13 项） | API 34 项全通过：提交页预览接口把 docx/pptx 转成 PDF（`%PDF` 头、inline disposition）、非 Office/未登录/超 10MB/假 docx 一律 400、**含 docx+pptx+pdf 的混合任务提交成功且文件名保持原名**、用户与管理员预览拿到的都是转换后的 PDF（`原名.pdf`）而 `?download=1` 给原文件（zip 头 PK）、代理 claim 带 `print_name=原名.pdf` 且下载字节是 PDF、转换缓存按 sha256 命中（mtime 未变）且删任务后清理、docm/pptm 仍拒绝。UI 13 项全通过：投放区文案、转换中「正在把 Word/PPT 转成 PDF…」、右栏 iframe 预览 +「（Word/PPT 已转 PDF）」标注、加 PPT 一起提交成功、「我的任务」与管理员队列点文件名预览的都是 PDF、同意后代理领取到 PDF；页面 JS 错误 0。**本机实测耗时：Word ≈6s、PPT ≈23s**（Office COM；LibreOffice 一般更快） |
| 代理断开 / 重连（2026-09-15） | `backend\.venv\Scripts\python.exe .tmp-test/agent_link_test.py`（11 项）+ `node .tmp-test/ui-test18.mjs`（13 项） | API：普通用户 403、断开后**注册/心跳/领取/下载/回报五个入口全 403**（提示含「断开」）、断开期间任务仍停「已通过」不被领取、重连后能领到排队任务并正常回报。UI：默认显示在线/离线 + 「断开连接」按钮、点击弹二次确认、断开后状态徽章变「打印代理已断开」且按钮变「重新连接」、服务端确实 403、点「重新连接」恢复且提示消失；页面 JS 错误 0 |
| 队列移动端改造（2026-09-15） | `node .tmp-test/ui-test19.mjs`（16 项） | 手机端（390×844）：操作区 opacity=1 无需悬停、「查看文件与设置」图标按钮（内联文件名隐藏）、弹窗含文件名与设置摘要、点文件名可预览、「知道了」44px 整行宽、删除确认按钮 40px 整行宽且与取消并排、页面无横向溢出（表格 1002px 靠容器滚动）；桌面端（1600）：操作同样常显、仍显示内联文件名、不显示手机图标、确认按钮保持原大小；页面 JS 错误 0 |
| 手机端任务详情抽屉 + 弹出动画（2026-09-15） | `node .tmp-test/ui-test21.mjs`（22 项） | 手机端（390×844）：点行弹出底部抽屉、抽屉里显示提交人/提交时间（含日期时分）/配送方式与完整地址/备注/文件与设置（点文件名可预览）；**操作按钮位于屏幕下半部（y=736 > 422）且 44px 高、与「删除」同一条底部操作区、抽屉贴着屏幕下沿（间距 0px）**；点「同意」后任务变已通过且抽屉自动关闭；「删除」仍走二次确认；桌面端点行不弹抽屉、内联操作按钮照旧。**弹出/收起动画断言**：抽屉面板 `animationName=sheet-up`、抽屉遮罩 `fade-in`、弹窗面板 `pop-in`、弹窗遮罩 `fade-in`；点「同意」后抽屉立刻进入 `sheet-down` 且播完才卸载、确认弹窗点「取消」后进入 `pop-out`（退场只播 ~200ms，用例用 `waitForAnimation()` 轮询抓，别等完再断言）。另：`ui-test19.mjs` 手机端断言同步更新为「行内只留『详情』入口，同意/驳回不在行内」17 项全通过 |
| 管理页二级菜单 + 名单表格（2026-09-15） | `node .tmp-test/ui-test22.mjs`（18 项） | 六个分栏入口（打印设置/打印计费/免费白名单/管理员名单/anticraft 绑定/打印代理）都在；默认「打印设置」只显示启动器/份数/打印机、不含 client_id；计费分栏只有单价、没有白名单输入框；**白名单与管理员名单是表格**（表头 用户名/账号/操作）——添加后表格出现该行且服务端 `free_users`/`anticraft_admin_users` 已写入、未注册的名字标「本站没有这个账号（不会生效）」、移除后两边都清掉；anticraft 分栏有 client_id/secret/授权来源；代理分栏有状态/令牌/重置；切回打印设置仍能拿到打印机下拉；页面 JS 错误 0 |
| 用户管理 = 账号操作中心（2026-09-15） | `backend\.venv\Scripts\python.exe .tmp-test/users_admin_test.py`（14 项）+ `node .tmp-test/ui-test23.mjs`（14 项） | API：列表带余额、admin 删号 403（仅 root）、删自己/删 root 400、**余额不为 0 → 400 并提示先扣到 0**、清空后删除成功且账号无法再登录、**任务与流水保留**、白名单加入→该账号判免费→移出恢复计费。UI：管理员能进用户管理、普通账号显示「设为免费」、管理员看不到删除按钮且加管理员按钮禁用；**设为免费 → 服务端 `free_users` 写入且行里出现「免费」徽章**、取消免费同步；**管理员也能看到「删除」按钮**、余额 3.00 时禁用、扣到 0 后可删、确认弹窗说清「任务/流水保留、余额必须为 0」、删除后列表与服务端都没了；页面 JS 错误 0 |
| 免费白名单批量添加与预登记（2026-09-15） | `users_admin_test.py` 第 5 步（全 18 项）+ `node .tmp-test/ui-test23.mjs`（19 项） | 接口：把**未注册**的名字写进白名单成功、此时确实没有该账号、用这个名字注册后 **profile 立刻判免费（原因「在免费白名单里」）**、提交任务 **charge=0**。UI：批量文本框粘 3 个名字（含一个长度不合规的）→ 提示「已加入 2 个账号…长度不合规」、服务端白名单写入这 2 个、不合规的没写进去、「名单里还没注册的名字」区能看到它们、注册后自动免费 |
| 站点图标（2026-09-15） | `node .tmp-test/ui-test14.mjs` 第 1b 步（3 项） | 页面声明了 svg / ico / apple-touch 三件图标、`/favicon.svg` 返回 200 + `image/svg+xml`、内容确认是品牌图（打印机剪影 + `#4a9d9a`）；`/favicon.ico` 返回 200 + `image/x-icon` |
| 任务信息页（封面页，2026-09-15） | `backend\.venv\Scripts\python.exe .tmp-test/cover_page_test.py`（27 项） | 设置项默认 `cover_page='1'`、可改成 0 再改回；claim 带 `cover_url`；下载得到 **1 页 PDF**（39~49KB）+ 响应头文件名「任务信息-N.pdf」；不带代理令牌 401；**RTF 全文纯 ASCII**（CJK 走 `\uNNNN?`，杜绝编码乱码）；内容含 任务号/提交人/文件/份数/配送方式/配送地址/备注/提交时间/打印时间 九个字段与真实值；代理侧断言「先下载信息页、`print_file(cover_path, 1, {})` 固定 1 份、受 `cover_page` 开关控制、失败会回报失败」 |
| 用户头像（2026-09-15） | `backend\.venv\Scripts\python.exe .tmp-test/avatar_test.py`（21 项）+ `node .tmp-test/ui-test24.mjs`（13 项） | API：默认无头像（读 404）、上传 png 成功且能读回**字节一致**、响应是图片类型 + nosniff、登录即可看而**未登录 401**、换头像后**文件名变化且旧文件被删**、pdf/exe/**改了后缀的假图片**/超 2MB 一律 400、校验失败不影响已有头像、移除后列与文件都清空、重复移除不报错。UI：我的配置页有头像卡（默认首字母占位）、选图后立刻上传并显示预览、**侧栏同步换成头像**、刷新后仍在、移除后回到首字母占位；页面 JS 错误 0 |
| 深链丢失修复（2026-09-15） | 注入登录态后逐个深链验证 | 修前：`/users`、`/admin`、`/balance` 刷新后全落到 `/queue`；修后各自停在原页面（`RequireAuth` 加 `hydrating`，水合期只显示加载态） |
| 账户余额与计费（2026-09-15） | `backend\.venv\Scripts\python.exe .tmp-test/billing_test.py`（35 项）+ `node .tmp-test/ui-test20.mjs`（12 项） | API：默认单价 0.1、普通本地账号计费、余额 0 提交 **402 且不建单不扣钱**（detail 带 code/cost/balance/sheets）、充值后按 1 页×1 份扣 0.1、**3 份=0.3 / nup 2×2 且只打 1 页=0.1 / PPT 3 页=0.3**、**驳回与撤回各退回 0.1**（流水有「驳回退费」）、admin/anticraft/白名单三种免费、单价可改（0.5 生效，abc/500 各 400）、**调账权限**（普通用户 403、扣成负数 400、金额 0 400）。UI：用户管理页余额列 + 「调整余额」弹窗（调完列表刷新成 1.00）、我的余额页（¥1.00 / 计费账号 · 0.1 元/张 / 充值暂未开放 / 管理员调账 +¥1.00）、提交页「按 0.1 元/张 计费…当前余额 1.00 元」、成功卡片「本次扣费 0.10 元 + 余额 0.90 元」、余额不足弹**付款码（暂未开放）**占位（应付/余额/去我的余额）、管理员显示「免费账号」；页面 JS 错误 0 |
| 计费上线后既有用例回归（2026-09-15） | 见 AGENTS.md 验证记录其余各行 | e2e 29/29、e2e2 26/26、role 19/19、office 34/34、ui-test13 19/19、ui-test14 22/22、ui-test16 16/16、ui-test17 13/13、ui-test19 16/16 —— 全部用例的测试账号已改为「注册后由管理员充 100 元」，否则新账号余额 0 会被 402 拦住 |
| Office 转 PDF **线上部署**（2026-09-15） | `bash deploy/pack.sh` → `backend\.venv\Scripts\python.exe .tmp-test/prod_office_check.py`（口令从 `PROD_ADMIN_PW` 环境变量读，脚本不落口令） | 部署后：线上首页引用新 dist（`index-DNmMwP_w.js` 内含「Word/PPT 会先转成 PDF」文案）、`POST /api/preview/office` 返回 401（新接口已上线）、**线上提交 docx 成功且预览拿到 34532B 的 PDF、`?download=1` 给原 zip**、测试任务已删除（未审批 → 不会出纸）；服务器 soffice 用后端同款命令实跑 Word 2.7s / PPT 2.6s |
| **虚拟打印机**（2026-09-16） | `backend\.venv\Scripts\python.exe .tmp-test\vprinter_test.py`（163 项，开头等 61 秒腾清登录限速窗口；用完删掉自己建的任务） | 163/163 全通过（2026-09-17 增补：**托盘勾选现读磁盘**（把配置文件的 notify_popup 翻一下，菜单回调立刻读到新值；开机自启动读系统注册表）、**手动启动开配置界面**（`wants_settings_window` 四条判定 + 真起一个无参数守护进程：窗口进程出现、日志写「手动启动：打开配置界面」；`--silent` / `--no-tray` / `NO_GUI` 都不弹）、**底部两个勾选框勾了即存**（`notify_popup` / `autostart` 立刻落盘并有提示，两个 chk 都挂了 command）、**匹配规则按形态收窄**（源码形态的规则里没有 `AntiPrintVPrinter.exe`、exe 形态只认它）；另：**点窗口 × 时问「只关界面 / 退出程序」**（13 项）—— 出厂默认「每次询问」、`close_action` 手写非法值读回来兜成 `ask`；「运行状态」页三个单选改完立刻落盘且给提示；选「只关界面」窗口关了而**真守护进程照旧在跑**；弹窗里点「取消」窗口留着、后台不动；选「退出程序」**后台服务真的没了**（进程列表空）且勾「记住我的选择」后 `close_action=quit` 落盘、下一次 × 不再询问（询问次数 2 → 2）；另：**退出会连配置界面窗口一起关干净** —— 按命令行里的 `--settings` 精确匹配配置界面进程、连同启动器父子两个一起停（用例实测：认出 2 个窗口进程、守护 pid 不在里面、停掉 2 个后剩 0 个），而**守护进程不受影响**（进程还在跑）；只关配置界面窗口不退出程序（后台服务继续监听）；另：单实例锁被占时——第二个实例拿不到锁、能认出「别的实例」（不含自己）、持有者退出后锁能立刻被接管、接管弹窗只在窗口程序（`sys.stdout is None`）里弹（有控制台只打印一句，自动化不会被弹窗卡住）；另：队列名 = `AntiPrint-1.0.0`（驼峰 + 版本号、无空格）、落盘文件跟着队列名走、自检/测试的环境变量覆盖仍优先、老配置里的 `ANTIPRINT` 自动升成新名字、用户自定义队列名不动；另：界面分成三个子界面（网站账号/提交选项/运行状态，二级菜单切换、三页叠同一格 raise）、窗口压到 780×600、底部操作条固定在窗口内且在所有页之下；另：图标取自网站 logo 且与 `frontend/public/apple-touch-icon.png` **逐像素一致**、失败态换成砖红、界面顶部 logo 44×44、底部操作条固定在窗口内、「提交后弹窗提示」默认不勾且关闭时不发气泡只更新图标与悬停文字、保存后 `notify_popup` 落盘、托盘菜单含「提交后弹窗提示」，默认服务器线上站点）。**真机网站链路**：模拟打印 → 提交 → 网站上出现「待审核」任务（文件名/备注/charge=0.10 都对）、余额 5.00→4.90；**令牌复用**（把 `client.login` 换成抛异常的桩，第二次提交照样成功）；**跟随网站默认配送**（配置留空 → 任务地址 = `/api/profile` 里的默认地址）；「配送但没地址」提前提示且不建单；余额 0 → 402 不扣款；密码错 → 提示且**不把异常抛出流水线**（曾会崩）；服务器连不上 → 1/2/4 秒重试 3 次后归档 failed；**CUPS 后端**（用 Git Bash 的 `sh` 实跑）落盘 + 边车 key=value 被解析 → 上传名「季度报告.docx → 季度报告.pdf」、按打印对话框的份数 2 计费 0.20；PostScript 无 Ghostscript 时的处理按实测走（2026-09-17 修掉分支判定 bug 后，**本机 ps2pdf 能真转出 PDF**：换成「换个当前目录结果一致（分支判定没串）」+「当前目录不会多出那个叫 `-o` 的文件」+「转换后的 PDF 进 sent/、原件不被反复重试」+「`_work/` 不留残留」四条，见「真 bug」第 14、15 条）；**真起一个守护进程**：写落盘文件 → 几秒内自动提交（端到端）、第二个进程被单实例锁拒绝（退出码 1）；重启不重复提交同一份落盘文件；**自启动开关真写/删 HKCU Run**（界面勾选与托盘菜单都验了）；**配置界面**（真开 Tk）回显/保存/换账号清令牌/刷新状态；托盘图标 64×64 像素级校验 + 菜单项与回调；`--status`/`--once`/`--selftest`/`--simulate` 退出码。**托盘图标在 Windows 右下角实测显示**（`powershell -File .tmp-test\tray_check.ps1` 列通知栏 + `tray_flyout_check.ps1` 点开「显示隐藏的图标」溢出层，能看到 tooltip「AntiPrint 虚拟打印机 · 正在监听打印任务」）；`install-printer-windows.ps1 -DryRun` 在非提权会话下正确识别驱动 `Microsoft Print To PDF` 并只打印计划，`uninstall-*.ps1` 非提权时按 1 退出。**未实测**：真正用管理员建 Windows 队列（本机会话非管理员）、真实打印对话框出 PDF、macOS/Linux 上的 CUPS 安装与本机打印 |

| **虚拟打印机 exe 绿色版**（2026-09-16） | `bash deploy/pack-vprinter.sh` → `backend\.venv\Scripts\python.exe .tmp-test\vprinter_exe_test.py`（56 项） | 56/56 全通过（2026-09-17 增补：**4b 退出** —— 冻结形态的配置界面（`exe --settings`，解包器父进程 + 程序子进程共 2 个）被 `close_settings_windows()` 整树关掉（停 2 个 → 剩 0 个），**同一台机器上跑着的守护进程进程数 2→2 不受影响、日志无 ERROR**（用例通过 `.tmp-test/settings_close_helper.py` 从另一个进程调产品代码：命令行里不能出现 `--settings`，否则会被自己的匹配规则停掉）；另：exe 自带 `assets/antiprint-logo.png` —— 从没有 frontend 目录的临时目录里跑，图标仍是网站 logo；exe 资源图标 = 网站 logo；用例只停自己那份副本，不会误杀用户正在跑的 exe）。包里 exe 23MB（PyInstaller 单文件，冷启动实测 5.5~6.6 秒）。**绿色模式**：把 exe 拷到一个带中文+空格的临时目录直接跑 → `--status` 自报「数据模式 = 绿色模式（程序旁边）」且数据目录就是 exe 旁边的 `AntiPrintVPrinter-data\`、`--init-config` 真的把 config.json 写在那儿、实例锁在 `%LOCALAPPDATA%\AntiPrintVPrinter`（机器级，防两份副本重复提交）；拿一个同名**文件**占住目录名时自动回落「用户目录」且不报错。**队列自助安装**：非管理员跑 `--install-printer` → 退出码 1 + 明确提示「需要管理员权限」+ 给出可抄的命令，且**系统里没有留下半截改动**（`C:\ProgramData\AntiPrint` 未被创建）；提权命令构造成 `[exe, "--install-printer"]`（runas 再跑一遍自己）。**端到端**：临时 HOME 写一份账号配置 → `exe --simulate test-print.pdf` → exe 自己登录并提交 → 网站上出现「待审核」任务（文件名/备注对、扣 0.10、令牌写回配置）；**exe 常驻后托盘图标确实挂上了系统托盘**：以应用日志里的就绪信号为准（`Tray.run(setup=…)` 回调在 Shell_NotifyIcon 成功后才执行，记一行「托盘图标已显示（系统托盘已接受；图标取自 antiprint-logo.png…）」）；UI Automation 那条路**只在部分时候可用** —— Win11 的「显示隐藏的图标」按钮不再支持 Invoke（报 Unsupported Pattern），溢出层打不开就枚举不到，用例里降级成 `[SKIP]` 提示不算失败（12:57 同一套检测确实看到过图标，tooltip 是「AntiPrint 虚拟打印机 · 正在监听打印任务」）；冻结形态 `launch_argv("--settings")` = `[exe, --settings]`、`autostart_command()` = `"<exe>"`、源码形态仍带 `virtual_printer.py`；**`exe --settings` 真拉起配置窗口**（Win32 枚举顶层窗口拿到标题「AntiPrint 虚拟打印机 · 配置」，说明 tkinter/tcl 已打进包）；zip 内容：install/ 六个脚本齐全、README 带 BOM+CRLF、bat 纯 ASCII+CRLF 且优先调用 exe、无 config.json/日志/令牌/AntiPrintVPrinter-data（打包脚本会把自检产生的数据目录清掉并校验）；**`stop-vprinter.bat` 能把单文件 exe 的父子进程一起停干净（剩余 0 个）**。另有源码侧回归：托盘菜单含「安装/修复队列/卸载队列/打开数据目录」、首次使用引导判定（空白配置→True、配好且提示过→False）。**未实测**：真机点「一键安装打印机队列」走完 UAC 后队列真的建出来（本机非管理员会话，只能验到提权前的提示与命令构造）、真机装队列后从打印对话框走一遍、exe 在无 Python 的干净机器上运行（本机装着 Python，只能证明包里不含 Python 依赖） |

| **微信小程序（kbone）**（2026-09-16） | `cd miniprogram && npm.cmd run build`（webpack + 放进 miniprogram_npm）→ `npm.cmd run typecheck` → `node .tmp-test/miniprogram_test.cjs`（44 项，在仓库根跑） | 44/44 全通过：用例在 Node 里直接跑 kbone 的 `miniprogram-render`，把 webpack 产物里的 5 个页面真的挂起来（读 `dist/miniprogram/pages/*/index.js` 注册的 `Component`，驱动 `attached`/`onLoad`，再由 kbone 调 `window.createApp()`）。**渲染**：登录页品牌标题 + 登录/注册 + 两个输入框 + `page-root`；提交页「提交打印」+ 计费提示（0.1 元/张、余额 1.00）+ 默认配送与地址（读 input 的 value）+ 选文件入口 + 份数/纸张；任务页 任务号/状态徽章（待审核=amber、待取件=violet）/文件名 + 逐文件设置（2 份 · A3）/地址/备注/取件提示/撤回按钮；余额页 金额 + 流水（-0.20 / +2.00）+ 充值暂未开放；配置页 用户名/角色/默认地址/退出登录。**交互（用 kbone 的冒泡 CustomEvent 模拟点击）**：选文件后显示「报告.docx · 2 KB」→ 点提交 → `wx.uploadFile` 字段名 `files`、formData `delivery_mode=配送 / address=24 号楼 1016 / copies=1 / paper=A4`、URL 指向 `/api/jobs`、成功后显示「任务 #33 / 0.10」与 toast；402 响应 → 显示「余额不足：应付 0.10 元，当前余额 0.00 元（付款码暂未开放）」；点「撤回」→ 弹「撤回任务 #12」确认 → 调 `POST /api/jobs/12/withdraw` → toast「任务 #12 已撤回」；点文件名 → `wx.downloadFile` 带 `Authorization` 头到 `/api/jobs/12/files/5`。**登录兜底**：无令牌时页面不渲染内容、不发任何请求、`location` 改为 `/login`；有令牌时进登录页自动跳 `/pages/submit/index`。另：`tsc --noEmit`（strict）0 错误；产物布局逐项核对（`dist/project.config.json` 在项目根、含 appid + libVersion + urlCheck=false 且**没有** miniprogramRoot；`dist/miniprogram/app.json` 5 页 + tabBar 4 项 + window 暖色；`pages/jobs/index.json` 开了 `enablePullDownRefresh`；`app.wxss` 里 `@import "common/app.css"` 且 `common/app.css` 含自定义类；`common/*.js` 头是 `module.exports=function(window,document){...}`；`miniprogram_npm/` 内 render + element 齐全）。**开发者工具实测（2026-09-16）**：导入 `miniprogram/dist` 后先报 `[WXSS 文件编译错误] path common/app.css not found from ./app.wxss`（当时样式抽成了 `.css` —— 小程序 `@import` 只认 `.wxss`，文件在也不认），又因为早先的布局把项目根设在代码目录上一层而报过 `[app.json 文件内容错误] 在项目根目录未找到 app.json`。现已改成**样式抽成 `.wxss`（`MiniCssExtractPlugin filename: '[name].wxss'`）+ `dist/` 既是代码根也是项目根（不写 miniprogramRoot）**，导入路径就是 `miniprogram/dist`；构建 + `tsc` + 44 项用例重跑全绿，`app.wxss` 的 `@import` 目标 `common/app.wxss` 存在、产物里已无 `.css` 引用。**未实测**：wxss 实际渲染效果、`miniprogram-element` 的 wxml 投影、真实小程序 API（chooseMessageFile/openDocument）、合法域名与真机 —— 这些要微信开发者工具 + 自己的 AppID（现为 `touristappid` 游客模式） |

| 提交后回到提交页主界面（2026-09-16） | `node .tmp-test/ui-test-reset-submit.mjs`（8 项） | 8/8 全通过：提交成功卡片出现 → 切「我的任务」再切回「提交打印」在第一步（投放区可见、没有第二步按钮/成功卡片）；**停在成功卡片上直接点侧栏「提交打印」（同一地址）也回到第一步**（修的就是这条）；测试任务已删、页面 JS 错误 0 |
| **API 文档页 + 虚拟打印机页 线上部署**（2026-09-17） | `bash deploy/pack.sh`（含新的第 4b 步上传安装包）→ 线上匿名探测 | 部署后：`/apidocs`、`/vprinter` 都 200（SPA 路由打点正常）；`/api/docs/api`、`/api/downloads`、`/api/downloads/windows-x64` 未登录一律 **401**（路由已上线）；线上 `index-emVHVRrk.js` 里能搜到「虚拟打印机 / API 文档 / 下载 zip / 编辑文档 / /api/downloads」；**23MB 的 `AntiPrintVPrinter-1.0.0.zip` 已上传到 `data/downloads/`**（部署脚本打印了服务器上的 `-rw-r--r-- 23M …`）；`/api/health` = `{"ok":true,"db":"ok"}`；旧构建资源被自动清理。**又发过一次**（品牌图标 + `logo.png`）：线上 `index-DetTlk95.js` 里三条 `aria-label: Windows/macOS/Linux` 都在（图标确实是新的）、`/logo.png` 200 + `image/png` 6720B 且 **sha256 与本地一致**、两个页面仍 200、下载接口仍 401。**未实测**：带登录态的线上下载（本机没有线上账号口令，`prod_office_check.py` 那套要 `PROD_ADMIN_PW`），登录后点「下载 zip」这一步等用户在线上点一次 |
| **API 文档页 + 虚拟打印机页**（2026-09-17） | `backend\.venv\Scripts\python.exe .tmp-test/api_docs_test.py`（25 项）+ `node .tmp-test/ui-test-docs-vprinter.mjs`（27 项） | 接口 25/25 全通过：文档未登录 401 / 登录可读 / 未改过时 `custom=false` 且正文 = 出厂文档 / 普通用户 PUT 403 / admin PUT 200 且回 `updated_by`+时间 / 改完持久化（另一个账号读到新版本）/ 超长（200001 字）400 / 传空 = 恢复出厂；下载清单三个平台（只 `windows-x64` `open+ready`，报出文件名/版本/22.6MB/64 位 sha256，且**不含任何服务器路径**）/ 未登录 401 / 未开放平台 404 / **乱写 id 含 `../etc/passwd` 一律 404**（不接受路径）/ 下载 200 且是 zip（`PK\x03\x04`、字节数 = 清单大小、**sha256 与清单一致**、`Content-Disposition: attachment` + `no-store`）/ 服务器给的就是仓库 `dist/` 里那个包。UI 27/27 全通过：普通用户能读文档（**渲染出 5 个表格、8 个代码块**、能看到 `POST /api/jobs` 与 requests 示例）但没有「编辑文档」按钮；管理员「编辑文档」→ 改名/加内容 → 保存 → 页面渲染新内容 + 页头变「本站自定义文档」+ 服务端 `custom=true` → 「恢复默认」回到出厂文档；虚拟打印机页三种平台卡片（**图标是官方品牌标记**：`svg[aria-label]` 分别是 Windows / macOS / Linux）、Windows 只有一个「下载 zip」、macOS/Linux 标「暂未开放」、四步说明与常见问题齐、SHA-256 有展示；**浏览器真的下载到 zip 且字节数与清单一致**（23738526）；手机端（390）两页都无横向溢出；页面 JS 错误 0 |

**测试中修掉的真 bug（勿回退）**：1. **代理把 `dry_run` 判断成恒真** —— 服务端下发的是字符串 `"0"`，`bool("0")` 在 Python 里是 `True`，导致代理永远只干跑却回报成功（任务被误标已打印）。已改为 `truthy()` 解析（`print_agent.py`），**任何服务端开关值都要走它**。
2. **任务列表缺提交人** —— 管理页「提交人」列空白，`db.list_jobs/get_job` 已 JOIN `users.username`。
3. **`/api/login/anticraft` 的 401 曾触发前端「登录已过期」拦截** —— `api.ts` 的 401 白名单只排除了 `/api/login`，已补上 `/api/login/anticraft`（现集中为 `NO_EXPIRY_PATHS`，**新增登录类接口时要同步这里**）。
4. **`POST /api/settings` 曾回明文 client_secret**（GET 已掩码、POST 忘了）—— 已统一走 `_masked_settings()`；`update_settings` 对空串/掩码 `******` 视为「不修改」，清空要直接改库。
5. **登录页告警被 flex 拆成三栏** —— 覆盖 `.alert` 的 display 必须写成 `.alert.xxx`（见「环境事实与坑」的 CSS 优先级一条）。
6. **虚拟打印机打包成 exe 后「拿 exe 当解释器去跑 .py」** —— 托盘菜单打开配置界面、以及三条自启动命令原来都写成
   `python_launcher() + 脚本路径`，冻结后就是「`AntiPrintVPrinter.exe D:\...\virtual_printer.py --settings`」，
   配置窗口打不开、开机自启也起不来。已统一走 `vp_platform.launch_argv()` / `start_command()`（exe 形态不带脚本路径）。
7. **守护进程挂控制台会被 bat 退出时的 `CTRL_CLOSE_EVENT` 带走** —— 窗口程序挂上调用方控制台后，控制台一关，
   Windows 会通知挂在它上面的所有进程；`start-vprinter.bat` 用 `start` 拉起后立刻退出，托盘进程就会被顺手杀掉。
   所以 `attach_console()` 只在「跑完就退出」的命令行模式里调用（见「打成 Windows exe」一节）。
8. **托盘启动提示被 `Tray.run()` 盖掉** —— `run()` 原来写死设成「正在监听打印任务」，把 `run_daemon()` 刚设的
   「队列还没安装 / 配置不完整」警告覆盖了，首次使用的人看不到该看的那句话。现在 `run()` 沿用已有状态文字与颜色。
9. **打包脚本 `rm -rf` 删掉了用户正在用的绿色数据目录**（2026-09-16 真实事故）—— `pack-vprinter.sh` 的组装步骤原本是
   `rm -rf "$STAGE"` + 「校验时再删 `$STAGE/AntiPrintVPrinter-data`」，而绿色版用户很可能**就在 `dist/AntiPrintVPrinter/`
   里双击 exe 用着**：重跑一次打包就把他的 `AntiPrintVPrinter-data/`（账号配置、日志、提交记录）删了。
   现在改成「只删自己产出的文件」（exe/install/README/config.example.json/requirements.txt/*.bat），
   打包时复制到 `$DIST/.vprinter-pack/` 再在副本里排除数据目录，压缩改用 Python `zipfile`（Git Bash 里那个 zip 是 MiKTeX 的，
   对 Windows 绝对路径处理不靠谱）。**给别人打包时永远不要 `rm -rf` 整个输出目录。**
10. **单实例锁探测把「在跑」误判成「没在跑」，还会抛 PermissionError 卡死进程**（2026-09-16，查了很久）——
   `msvcrt.locking(fd, LK_NBLCK, 1)` 锁的是**当前文件位置**那一字节，而原来用文本流 `"a+"` 打开：守护进程先锁第 0 字节、
   再把 pid 写进去（文件变 5 字节），第二个进程用 `"a+"` 打开时光标落在文件尾 → 它锁的是**第 5 字节**（没人占）→
   `acquire()` 返回 True → `daemon_running()` 报「没在跑」；随后它还要 truncate/write 第 0 字节，撞上对方的锁 →
   `PermissionError` 抛出。**冻结成窗口程序后 PyInstaller 会弹一个看不见的「Fatal error」对话框等人点击**，
   于是 `--status` 进程活着但永不退出（自动化里卡了 24 分钟才发现）。修法：`SingleInstance` 改用 `os.open` + 显式
   `lseek(0)` 锁第 0 字节，**只锁不写**（空文件足够表达占用），整个过程包 try；另在 `virtual_printer.py` 的
   `__main__` 加顶层兜底把异常写进日志再退（不让 PyInstaller 弹对话框）。
11. **「双击 exe 没反应」= 单实例锁被占 + 窗口程序只写日志**（2026-09-16 用户实际遇到，2026-09-17 修复）——
   旧实例还在跑（占着机器级锁）时，新一次的启动会 `say(...)` + 退出；而窗口程序没有控制台，
   `say()` 退化成写日志 → **用户屏幕上什么都没有**，连点三次都「打不开」（日志里三行一样的
   「已经有一个虚拟打印机守护进程在跑了」）。修法：`take_over_lock()` —— 有控制台（命令行/管道，
   自动化也走这条）只打印一句；窗口程序则弹窗说明「右下角托盘图标就是它 / 右键点它开配置界面」，
   并给一个**接管**选项：点「是」→ `stop_other_instances()` 结束旧实例（按进程名匹配
   `AntiPrintVPrinter.exe` 和 `python* + virtual_printer`，**排除自己与自己的父进程** —— 单文件 exe
   父子同名，杀掉父进程会把这次启动一起带走）→ 重试拿锁 → 继续启动。同一轮还把
   `Remove-PrinterPort` 失败改成非致命（`ERROR_BUSY 0x800700aa`：队列里还有任务时端口删不掉，
   原来会让整个「卸载」报失败，现在只提示「重启后再清一次」）。
   **教训**：窗口程序里任何"只写日志"的退出路径都等于「用户看不见」——要么弹窗，要么改状态。
12. **用例别去调 `stop_other_instances()`**（2026-09-16 误杀）—— 它按进程名匹配，是给「升级时接管旧副本」
   用的（有用户确认）。`.tmp-test/vprinter_test.py` 的 7b 段一开始直接调它，把用户正在跑的实例一起停掉了。
   现在用例只停「自己启动的那个 PID」，验的是「持有者退出后锁会被释放」这个机制。
13. **「托盘图标关闭后程序没有真正关闭」= 配置界面窗口是独立进程，退出时没人关它**（2026-09-16 用户实际遇到）——
   配置界面按设计另起进程（关窗口不停后台服务，macOS 上也不跟托盘抢主线程），所以托盘「退出」只停了
   守护与图标，**那个窗口（可能就是双击 exe 时开的那个）还留在屏幕上**，看任务管理器/任务栏都像「没关掉」。
   修法：`vp_platform.close_settings_windows()` —— 按**命令行里有 `--settings`** 精确匹配
   `AntiPrintVPrinter.exe` / `python* virtual_printer`，再连同它们的子进程一起停（单文件 exe 是
   「解包器父进程 + 程序子进程」，只停父进程会留下子进程）；`Tray._quit()` 里先关窗口再停图标，
   并写日志「用户选择退出：正在关闭配置界面与后台服务」。**别改成按进程名杀**（会连带别人的副本），
   也**别把守护进程一起匹配进来** —— 判定条件是 `--settings`，守护进程的命令行里没有它。
   配套：`--settings` 的拉起统一走 `vp_platform.spawn_settings_window()`（托盘菜单与首次引导共用一份）。
   **注意**：只关配置界面窗口**不应该**退出程序（后台服务要继续监听），这条行为写进 `vprinter/README.txt` 了。
   **后续（2026-09-17 用户要求）**：既然「关窗口」和「退出程序」都合理，就别替用户决定 —— 点 × 时**问一句**
   「只关界面 / 退出程序」，可勾「记住我的选择」（写 `config.close_action`），并在「运行状态」页留一个
   单选随时改回来；「退出程序」那条路走 `stop_daemon()`（命令行里**没有** `--settings` 的就是守护进程）。
   实现见下面「配置界面」一条，用例见验证记录里的 10c 段。
14. **转换器分支按 `Path(tool).name` 精确比较 → Windows 上把 `ps2pdf` 当成 macOS `convert`**（2026-09-17 实测发现）——
   `shutil.which("ps2pdf")` 在 Windows 上返回 `C:\...\MiKTeX\...\ps2pdf.EXE`，`Path(tool).name` 是
   `ps2pdf.EXE`（**大写扩展名**），`== "ps2pdf"` 不成立 → 落进最后那条 `else: # macOS convert` 分支，
   命令行变成 `ps2pdf <输入> -o <输出>`；ps2pdf 把 `-o` 当**输出文件名**，于是**运行时的当前目录**里
   多出一个叫 `-o` 的 PDF 文件、真正的输出没生成 → 转换报告「没有生成文件（可能只是个包装器）」。
   **之前的「本机 ps2pdf 是包装器、啥也不产出」是误判**（真正的 ps2pdf 是好的）。修法：分支判定改用
   `Path(tool).stem.lower()`（`gs` / `ps2pdf` / `cupsfilter` / 其余 = macOS 的 `convert`），日志与错误文本也用这个短名字。
   本机现在 PS→PDF 实测**能转成功**（2367B 的 `%PDF`）；用例在 section 5 加了两条：
   「换个当前目录结果一致（分支判定没串）」+「当前目录不会多出 `-o` 文件」。
   **教训**：凡是用 `shutil.which` 拿到的可执行文件做判断，一律取 `stem.lower()` —— Windows 带 `.EXE` 且大小写不定。
15. **转换成功之后拿旧路径去提交 → `FileNotFoundError`**（2026-09-17，跟着第 14 条一起露出来的）——
   `Pipeline.process()` 里 `pdf = to_pdf(path, _work)`，转换成功后先把产物 `shutil.move` 成
   `inbox/<名字>.pdf`（免得原件被反复提交），接着提交时却还在用 `submit_job(pdf, …)` —— 那个文件**已经被移走**了，
   于是 `FileNotFoundError: inbox/_work/job-….pdf`。走 `run_forever` 时它被「单轮异常不能让守护退出」兜住，
   表现为「日志里每轮一条异常、任务反复没有提交」（下一轮那 `.pdf` 已经在 inbox 里、能自愈，所以很难发现）；
   用例里直接暴露成崩溃。修法：提交用 `path`（转换成功后它就是那个 PDF；move 失败时 `path = pdf` 也成立）。
   **为什么以前没发现**：本机 `ps2pdf` 分支判定坏掉（第 14 条）→ 转换永远失败 → 这条成功路径从没跑到；
   macOS/Linux 上装 Ghostscript 的用户才会撞上。
16. **SPA 兜底用 `startswith("/api")` → 前端路由 `/api-docs` 被当成接口，回一坨 JSON 404**（2026-09-17，UI 用例逮到）——
   404 兜底原来写 `not request.url.path.startswith("/api")` 才回 index.html；`"/api-docs".startswith("/api")`
   是 **True**（前缀没带边界），于是新加的「API 文档」页整个打不开 —— 直接访问 `/api-docs` 得到
   `{"detail":"Not Found"}`，而侧栏点进去也一样。修法：判断改成带边界的
   `path == "/api" or path.startswith("/api/")` ✓（真实接口全是 `/api/...`，未知接口照样回 JSON 404）。
   **教训**：前端路由**不要以 `/api` 开头**；`/apidocs` 这种也不行（`startswith("/api")` 同样命中）——
   现在这条边界判断兜住了，但新加路由时仍然避开这个前缀最省事。
   **同一个坑的第二处（同一天发现）**：`frontend/vite.config.ts` 的 dev 代理键也写的是 `'/api'` 前缀 ✗
   于是 dev 下 `/apidocs` 被代理去 **8301**、拿到后端托管的那份**构建产物**（HTML 里是 `/assets/index-*.js`
   → dev 下 404 → 白屏）。修法：代理键改成带边界的正则 `'^/api/'`（Vite 支持 `^` 开头的正则键）。
   **排查提示**：dev 下白屏、而返回的 HTML 里出现 `/assets/` 哈希文件名 = 请求被代理到后端了。

## 目录规划

```
frontend/          React 18 + Vite + TS；dev 3010，/api 代理到 127.0.0.1:8301；构建产物 dist/（由后端托管）
  src/pages/       LoginPage / SubmitPage / MyJobsPage / ProfilePage（我的配置）/ QueuePage（任务队列，管理员）/ AdminPage（管理设置）/ ApiDocsPage（API 文档，管理员可编辑）/ VprinterPage（虚拟打印机下载 + 说明）/ AnticraftCallbackPage（各带同名 .css 已删除，全部 Tailwind）
  src/components/  Modal / DropZone / FileChips / TextField / ThemeToggle / Icons
  src/api.ts       所有请求的唯一出口（401 统一处理）；src/types/api.ts 接口类型
backend/           FastAPI + MySQL；main.py 入口、db.py 存储层、auth.py 认证、agent_api.py 代理接口、config.py、constants.py、convert.py（Office→PDF）
  api_docs.py       「API 文档」页的**出厂默认正文**（Markdown 字符串；线上以 settings.api_docs_md 为准）
  downloads.py      虚拟打印机安装包清单（只开 windows-x64）+ 按 id 找包 + sha256（含缓存）
  data/uploads/<job_id>/   上传文件存储（gitignore）；data/converted/<sha256>.pdf Office 转换缓存（gitignore）；data/avatars/ 用户头像（gitignore）；data/covers/ 任务信息页 PDF（gitignore）；data/downloads/ 给用户下载的安装包（gitignore，部署时由 pack.sh 单独上传）；log/server.log 运行日志（gitignore）
  db_config.json / db_config.example.json   DB 凭据（前者 gitignore）
agent/             Windows 打印代理（Python + requests，常驻）
  print_agent.py   轮询/领取/打印/回报；config.json 本机配置（gitignore，模板 config.example.json）
  install/start/stop/check-agent.bat + apply-config.ps1   安装/启动/停止/自检（整仓库与分发包共用同一份；脚本自定位解释器）
  README.txt       分发包里给管理员看的中文安装说明（pack-agent.sh 会打进 zip）
  tmp/<job_id>/    下载的待打印文件（gitignore）；log/agent.log 日志（gitignore）
vprinter/          虚拟打印机（用户端投稿客户端：打印 = 转 PDF + 提交到本站；Windows/macOS/Linux）
  virtual_printer.py  入口：托盘 + 守护 + 命令行（--settings/--selftest/--status/--once/--simulate/--retry-failed）
  vp_config.py / vp_api.py / vp_pipeline.py / vp_platform.py / vp_tray.py / vp_gui.py   配置·网站客户端·流水线·平台·托盘·配置界面
  install/        install-printer-windows.ps1（要管理员，建 Windows 队列）/ setup-cups.sh（macOS/Linux 装 CUPS 后端 + 队列）
                  cups-backend-antiprint（后端脚本，收打印数据进收件目录）/ antiprint.ppd（lpadmin -m raw 不被支持时的兜底）
  start / check / stop-vprinter.bat   一键启动 / 自检 / 停止（优先用同目录的 exe，否则退回 Python；纯 ASCII + CRLF）
  README.txt      给使用者看的中文说明（exe 用法、装队列、填配置、常见问题）；运行数据都在 ~/.antiprint-vprinter/
deploy/pack-vprinter.sh   打 Windows 单文件 exe 分发包（PyInstaller）→ dist/AntiPrintVPrinter-<版本>.zip
miniprogram/       kbone 微信小程序（**独立工程，其它端源码不动**；用户端提交打印用，不做管理端）
  webpack.config.js  入口（app + 5 页面）与 kbone 插件配置；@shared 别名 → ../frontend/src（只读复用类型与常量）
  src/index.js       小程序 app 入口（恢复登录态 + 引入全局样式）；src/page.ts 各页面的 createApp（挂 React、登录兜底、下拉刷新）
  src/api.ts         wx.request / wx.uploadFile / wx.downloadFile 的唯一出口；src/util.ts 格式化/徽章/进度步骤；src/app.css 全局样式
  src/components.tsx PageHeader（品牌色带）/ Card / Row / Btn / Segmented / ChipRow / Stepper / Badge / Steps（四步进度）/ Field / Alert
  src/pages/         login（登录/注册）/ submit（选文件+份数纸张+配送，底部固定提交条）/ jobs（我的任务，含进度步骤）/ balance / profile
  tabbar/            tabBar 图标（scripts/make_tab_icons.py 生成，81×81，未选中灰/选中青绿）
  scripts/copy-runtime.js  构建后处理：kbone 运行时 → miniprogram_npm、logo → images/、样式内联进 app.wxss（见下）
  dist/             构建产物（gitignore）：**dist/ 本身就是小程序项目根**，开发者工具导入 miniprogram/dist/（不写 miniprogramRoot）
dist/              打包产物（gitignore）：AntiPrintAgent-<版本>.zip 与 .cache/（Python embeddable 下载缓存）
setup.bat / run.bat / stop.bat / stop.ps1     一键安装 / 启动 / 停止（bat 必须纯 ASCII + CRLF）
```

## 常用命令

> Windows 上 **npm 脚本被 ExecutionPolicy 禁用 → 一律 `npm.cmd`**。

- 后端：`backend\.venv\Scripts\python.exe backend\main.py`（uvicorn **8301**，`reload=False`，改代码后手动重启）
- 前端：`npm.cmd run dev`（Vite 3010，`/api` 代理 `127.0.0.1:8301`）
- 前端类型/构建验证：`npm.cmd run build`（`tsc --noEmit && vite build`，**类型错误会阻断构建**）
- 一键：`setup.bat`（建 venv + 装依赖 + `npm.cmd install` + 构建前端）/ `run.bat`（无窗口起后端 + 代理）/ `stop.bat`（调 `stop.ps1`，按端口与路径精确停本项目进程，**不碰 index/antiClass**）
- 打印代理分发包：`bash deploy/pack-agent.sh` → `dist/AntiPrintAgent-<版本>.zip`（自带 Python 运行环境，发给别人装代理用）
- 虚拟打印机 exe 分发包：`bash deploy/pack-vprinter.sh` → `dist/AntiPrintVPrinter-<版本>.zip`（单文件 exe，对方不用装 Python；加 `--skip-build` 只用上次的 exe 重新组包）
- 微信小程序（见「微信小程序（kbone）」一节）：`cd miniprogram && npm.cmd install`（首次）→ `npm.cmd run build`（webpack + 构建后处理）/ `npm.cmd run typecheck`（tsc strict）；用例 `node .tmp-test/miniprogram_test.cjs`（在仓库根跑，48 项）；预览截图 `node .tmp-test/miniprogram_preview.mjs`
- 小程序分发包：`bash deploy/pack-miniprogram.sh` → `dist/AntiPrintMiniProgram-<版本>.zip`（别人只要微信开发者工具，不需要 Node/Python；`--skip-build` 只用现有产物重打包）
- 代理：`--selftest`（自检）/ `--printers`（列打印机）/ `--once`（只跑一轮，调试用）/ `--dry-run`（只打命令行不出纸）
- 虚拟打印机（见「虚拟打印机」一节）：`vprinter\start-vprinter.bat`（无窗口起托盘）/ `check-vprinter.bat`（自检+状态）/ `stop-vprinter.bat`；
  Python 侧 `--selftest` / `--status` / `--once` / `--simulate <文件>`（把文件当打印输出走整条链路）/ `--retry-failed` / `--no-tray`；
  建队列：`powershell -ExecutionPolicy Bypass -File vprinter\install\install-printer-windows.ps1`（**要管理员**，加 `-DryRun` 只探测）
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
- **断开连接 / 重新连接（2026-09-15 新增）**：管理页代理区有「断开连接」按钮（二次确认弹窗），开关存 `settings.agent_enabled`（`'1'` 默认 / `'0'` 已断开），接口 `POST /api/settings/agent-link`（body `{connected: bool}`，仅 admin）。断开后 `agent_api.require_agent` 对**注册/心跳/领取/下载/回报一律 403**（中文提示「打印代理已被管理员断开连接」），`_agent_online()` 也直接返回 False（界面立刻显示「已断开」，不等 90 秒超时）。**代理进程不受影响**：`_note_blocked()` 只记一条日志（避免每 5 秒刷屏）、继续轮询，服务端恢复后自动续上（`_note_resumed()`）。断开期间已通过的任务只是排队，不会被领取。
- **任务信息页（封面页，2026-09-15 新增）**：每次出纸前**先打一张**，内容是 任务号 / 提交人 / 文件清单 / 份数 / 配送方式 / 配送地址 / 备注 / **提交时间** / **打印时间**——线下交付时一眼看清「给谁、打的什么」。
  生成在**服务端**（`backend/cover.py`）：把内容拼成**纯 ASCII 的 RTF**（CJK 一律 `\uNNNN?` 转义，任何编码都不会乱码），复用 `convert.py` 的转换链路（生产 LibreOffice / 本机 Word）转成 PDF，落 `data/covers/job-<id>-<时间戳>.pdf`（每次重新生成，好让「打印时间」是当下的）。
  接口：`GET /api/agent/jobs/{id}/cover.pdf`（代理令牌鉴权）；claim 的 payload 里带 `cover_url`。代理 `process_job` **先**下载并打印它（`self.print_file(cover_path, 1, {})` —— 固定 1 份，不套用文档的份数/页面设置），再打任务文件；信息页失败会回报失败而不是静默跳过。
  开关：`settings.cover_page`（`'1'` 默认打 / `'0'` 不打），管理设置「打印设置」里有勾选框。
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
- `--selftest` / `--printers` / `--once` / `--dry-run` 四个开关覆盖了排查全流程（`check-agent.bat` 就是前两个的封装）；单实例锁（`agent.lock`）会拦住第二个代理，避免重复出纸。
- **分发包（发给别的管理员/别的机器）**：`bash deploy/pack-agent.sh` 生成 `dist/AntiPrintAgent-<版本>.zip` —— 内置 python.org embeddable 运行环境（版本取后端 venv，依赖从 venv 复制到 `runtime\Lib\site-packages` 并写进 `._pth`），**收包机器不需要装 Python**；打包时会校验包内不含 `config.json` 与真实令牌。`agent/*.bat` 是自定位的：解释器按「包内 `runtime\` → 仓库 `..\backend\.venv` → PATH」找，所以同一份脚本整仓库里也能跑；`install-agent.bat` 交互问 server / agent_token / printer，由 `apply-config.ps1` 写进 config.json。**SumatraPDF 路径不再写死**：`find_sumatra()` 按「配置 → `%LOCALAPPDATA%\SumatraPDF` → Program Files → PATH」查找（`--selftest` 第 4 步会检查，缺了直接判失败）。
- **服务端下发的打印配置是全局的**（`heartbeat` 只回 `launcher`/`printer_name`/`copies`/`dry_run`，所有代理共用）：多台代理接不同型号打印机时，`printer_name` 只能在管理页统一改，本机 `config.json` 会被覆盖。

## 虚拟打印机（用户端投稿客户端，2026-09-15 新增）

`vprinter/` —— 给**用户**用的程序：在任意程序里 Ctrl+P 选「AntiPrint-<版本>」这台**虚拟打印机**，
打印内容自动变成 PDF 并**提交到本站**（等价于在网页上传文件），之后照常走「待审核 → 管理员同意 → 打印代理出纸」。
它不碰实体打印机，也不需要拿到 `agent_token`；提交人就是配置里填的那个账号（照常计费）。使用者文档见 `vprinter/README.txt`。

- **三个平台都是「系统打印队列 → 落盘 → 守护进程提交」这条链路**：
  - **Windows**：`install/install-printer-windows.ps1`（**必须提权**；`-DryRun` 不提权也能跑，只探测不改动）建队列，
    驱动用系统自带的 `Microsoft Print To PDF`，端口是**一个固定文件路径**——**就在程序旁边的数据目录里**：
    `<数据目录>\spool\<队列名>.pdf`（如 `…\AntiPrintVPrinter-data\spool\AntiPrint-1.0.0.pdf`；
    老版本放 `%ProgramData%\AntiPrint\spool`，装新队列时由 `legacy_cleanup()` 清掉老端口/残留文件）——
    驱动会把 PDF 直接写进这个文件、**不弹保存对话框**；脚本同时给落盘目录 `Users:Modify`（spooler 以 SYSTEM 身份写，
    托盘程序以当前用户身份读）。
  - **macOS / Linux**：`sudo bash install/setup-cups.sh` 装 CUPS 后端 `antiprint` + `lpadmin -p AntiPrint-<版本> -v antiprint:/ -m raw`
   （脚本自己 `import vp_config` 读版本号，和程序里的默认名永远一致）
    （`-m raw` 不被本地 CUPS 接受时回落 `install/antiprint.ppd`）。后端把打印数据 + 一份 `title/user/copies` 边车
    **原子地**（先写 `.part` 再 `mv`）落进 `/var/spool/antiprint`（**0777**：后端以 root/lp 写、桌面用户要能移走；
   `ANTIPRINT_SPOOL` 环境变量可改）。后端脚本能单独测：`ANTIPRINT_SPOOL=/tmp/x sh install/cups-backend-antiprint 1 "$USER" "文档名" 1 "" 文件`。
- **守护进程**（`virtual_printer.py`）：pystray 托盘图标（**Windows 右下角**，Win11 默认收进「显示隐藏的图标」溢出区；
  图标是程序画的 64×64：青绿=正常 / 砖红=最近一次提交失败）+ tkinter 配置界面 + 监听线程；单实例锁
  `~/.antiprint-vprinter/vprinter.lock`（第二个进程按退出码 1 拒绝启动）。**配置界面另起一个进程**（`--settings`，
  托盘菜单与首次引导共用 `vp_platform.spawn_settings_window()`），这样 macOS 上 AppKit 与 tkinter 不抢主线程、
  关窗口也不影响守护；配置按 mtime **热更新**。退出语义（2026-09-17 定）：**点配置界面窗口的 × 会先问一句**
  ——「只关界面」/「退出程序」，可勾「记住我的选择」；记住后写 `config.close_action`（`ask` 出厂默认 / `window` /
  `quit`，非法值在 `load_config()` 里兜回 `ask`），也能在「运行状态」页的单选里改回来（改完立刻落盘）。
  选「退出程序」走 `vp_platform.stop_daemon()`：按**命令行里没有 `--settings`** 匹配守护进程（配置界面与它带的
  父/子进程都有 `--settings`；`--install-printer` / `--uninstall-printer` 这类交互式参数也排除），连子进程一起停。
  **匹配一律先按「本程序这一形态」收窄**（`_self_form_match()`：exe 形态 = `AntiPrintVPrinter.exe`，
  源码形态 = `python*` 跑 `virtual_printer.py`）—— 2026-09-17 踩过：源码里跑用例的「退出程序」把用户正在跑的
  分发包实例一起停了 ✗。所以 `close_settings_windows()` 与 `stop_daemon()` 都只动**同形态**的进程（规则每次现算，
  用例验另一种形态时把 `vp_platform.IS_FROZEN` 翻一下即可，`.tmp-test/settings_close_helper.py` 加 `--frozen` 就是这么冒充 exe 形态的）。
  **托盘「退出」= 关配置界面窗口 + 停守护 + 摘图标**（`close_settings_windows()`，按 `--settings` 精确匹配）；
  命令行里想一把清干净就用 `stop-vprinter.bat`。
- **手动打开软件就把配置界面亮出来**（2026-09-17 用户要求）：`wants_settings_window(silent, has_tray)` ——
  有托盘 + 不是 `--silent` + 没设 `ANTIPRINT_VPRINTER_NO_GUI` 就开一次（`first_run_guide()` 开过就不重复开，
  它现在返回 bool）。双击 exe / 桌面快捷方式 / `start-vprinter.bat` 都算「手动」；**开机自启（`--silent`）与自动化不弹**。
- **托盘菜单里的勾选状态现读磁盘**（`vp_tray._fresh_cfg()`，2026-09-17 用户反馈「配置界面改了，托盘还显示改之前的」）：
  `checked=` 回调原来读内存里那份 `pipeline.cfg`，要等 2 秒一轮的热更新线程；配置界面是**另一个进程**、
  改完直接写盘，菜单上就会先显示旧值。现在这几个 `checked` 一律 `load_config()`（只在弹出菜单时读，开销可忽略）。
  **细节**：pystray 的 `MenuItem.checked` 是**属性**（读的时候就求值），用例里别写成 `item.checked(item)`（那是 bool，会 TypeError）。
  运行数据全在 `~/.antiprint-vprinter/`：`config.json`(0600) / `inbox/` / `sent/` / `failed/` / `log/vprinter.log` /
  `recent.json`（界面显示最近 10 次） / `spool_state.json`（已消费的落盘文件指纹）。环境变量
  `ANTIPRINT_VPRINTER_HOME`、`ANTIPRINT_VPRINTER_SPOOL`、`ANTIPRINT_VPRINTER_CUPS_SPOOL` 可整体改路径（测试用）。
- **提交走的还是 `POST /api/jobs`**（`vp_api.py`）：JWT 缓存进配置文件（**不要每次打印都登录**，登录接口 10 次/分钟限速），
  401 时强制重登一次；**配送方式/地址留空 → 跟随 `/api/profile` 的默认值**（`vp_pipeline.resolve_delivery()`），
  「配送但哪儿都没地址」**提前**给出可操作提示（告诉用户去配置界面或网站的「我的配置」），不白跑一趟 400；
  份数优先用打印对话框里的（CUPS 边车带过来）、否则用配置里的；402 余额不足 / 密码错 / 断网（1/2/4 秒重试 3 次）
  都归档进 `failed/` + 托盘提示，可「重试失败的文件」。
- **Windows 落盘文件是「复制」不是「搬走」**（文件归驱动所有、下次打印要重写它，也不能长留句柄），
  稳定判定 = 「修改时间+大小」1.5 秒不变，并用 `spool_state.json` 记住已消费的 (mtime,size)，**守护进程重启不会重复提交**。
  上传文件名优先取打印任务名（Windows 用 `Get-PrintJob` 的 DocumentName，取不到再读 PDF 的 `/Title`；CUPS 直接用边车的 title，
  `.docx` 之类会被换成 `.pdf`），都拿不到才退化成 `虚拟打印-<时间戳>.pdf`。
- **转换器链**（只对 CUPS 的 raw 队列有意义）：`%PDF` 直接用；否则依次试 `gs` → `ps2pdf` → `cupsfilter` → macOS 的
  `convert`，**每个候选都验产物**；分支判定用**去掉扩展名的小写名字**（`Path(tool).stem.lower()`）——
  Windows 上 `which` 回来的是 `ps2pdf.EXE`，按 `name` 比会把它当成最后那条 macOS convert 分支（详见「真 bug」第 14 条）。
  全失败就明确提示装 Ghostscript + 写清失败原因（没生成文件 / 输出不是 PDF / 退出码）。Windows 侧输出本来就是 PDF，用不到。
- **已知限制（写进 README.txt 了）**：① Windows 的端口是**一个固定文件**，两份任务同时排队会互相覆盖 —— 等托盘提示
  「已提交」再打下一份；② macOS 的 CUPS 后端目录要 cupsd 的 ServerBin 认（`lpinfo -v | grep antiprint` 可验，
  `setup-cups.sh` 会提示）；③ 账号密码明文存在本机 `config.json`（0600），介意就别勾「记住」。
- **数据全部在程序旁边**（2026-09-16 用户明确要求，含落盘文件与实例锁）：
  - **数据就地存放**：`vp_config._portable_dir()` 在 exe 旁边建 `AntiPrintVPrinter-data\`
    （config.json / log / inbox / sent / failed / **spool\**（驱动落 PDF 的地方）/ cache / vprinter.lock），
    拷走文件夹 = 拷走配置；exe 旁边写不了（受保护目录）就自动回落 `%USERPROFILE%\.antiprint-vprinter`。
    **只在打包成 exe 时启用**（源码运行仍写用户目录，免得往仓库里塞东西）；`--status` 的「数据模式/数据目录」能看出当前用哪个。
  - **单实例锁就在数据目录里**（`<数据目录>\vprinter.lock`，2026-09-16 按用户要求「程序产生的东西全放 exe 旁边」改）：
    早先放 `%LOCALAPPDATA%` 是为了防「两份副本同时盯同一个落盘文件、重复提交」，**现在这个前提没有了** ——
    落盘文件也跟着副本走（`<数据目录>\spool\<队列名>.pdf`），每份副本只盯自己那份。跨副本的错配改由
    **`spool_mismatch()` 护栏**兜住：队列端口是程序按自己所在目录算出的**绝对路径**，换目录/换机器后端口还指着
    老地方就报出来（自检红字 + 配置界面提示条 + 托盘状态），提示去点一次「一键安装打印机队列」对齐。
  - **队列由程序自己装**（`vp_printer.py`）：托盘菜单「安装/修复虚拟打印机队列」、配置界面的「一键安装打印机队列」，
    都是 `elevate_and_wait(["--install-printer"])` —— 用 `ShellExecuteExW(runas)` 提权后再跑一遍自己（UAC 一次），
    子进程做完弹窗告诉用户结果；`--install-printer` / `--uninstall-printer` 也可以由管理员直接在命令行跑。
    install/uninstall 都是**幂等**的（已存在就重设驱动/端口 = 修复）；非管理员调用会先被 `is_admin()` 拦下并提示，
    不会在系统里留下半截改动。**提权必须放后台线程**（UAC 期间不能卡住托盘消息循环 / Tk 主循环）。
  - **首次使用引导**（`first_run_guide()`）：没配账号、或队列没装且没提示过（`config.queue_warned`），就把配置界面自动打开
    —— 不然 Win11 把托盘图标收进溢出区，双击 exe 的人会以为啥也没发生。自动化用 `ANTIPRINT_VPRINTER_NO_GUI=1` 跳过。
  - **只有打印队列本身**（那个 `AntiPrint-<版本>` 打印机对象）是系统级的、放不进文件夹（Windows 注册表 + 假脱机服务管着），
    所以换机器/换目录后要点一次「一键安装打印机队列」把**端口**指到新目录；端口只能是绝对路径，
    「相对」体现在**路径由程序按自己所在目录算出来**（`spool_file_for()` ← `app_dir()`/数据目录），不写死在 ProgramData。
- **托盘图标「不见了」的真实原因：pystray 的 `run(setup=回调)` 会顶替 `visible = True`**（2026-09-16，害我
  查了很久还先怪到 Windows 头上）—— 看 `pystray/_base.py` 的 `setup_handler`：**传了 setup 回调，它就不执行
  默认那句 `self.visible = True`**，图标于是**永远不会被 NIM_ADD 加进托盘**；而回调里的日志照写不误，
  看起来像系统把图标弄丢了。修法：`Tray._on_tray_ready()` 里**自己 `icon.visible = True`** 再记日志。
  **教训：`Shell_NotifyIcon` 的返回值 pystray 压根不看（`_message()` 直接丢弃），所以任何日志行都不能当
  「系统收下了」的证据** —— 用例里给 `pystray._win32.win32.Shell_NotifyIcon` 打桩，断言 NIM_ADD 真的发出
  且返回真（`.tmp-test/vprinter_test.py` 的 10b2 段；注意 pystray 注册图标要 ~1.9 秒，用例别停太早）。
  另外：本机虚拟屏是 3627×1081（多显示器），拿「截屏右下角找图标」验证会**扫错显示器** —— 别用这个办法。
  恢复入口：图标没了托盘菜单就点不到，因此恢复入口必须在别处：
  配置界面「运行状态」页的 **「重启后台服务」**（`stop_other_instances()` + 起一个新进程，图标随之重新注册）
  和托盘菜单里的同名项。配置界面**双击 exe 就能打开**，所以这条路一定走得通。
  判断「图标到底在不在」用 `.tmp-test/tray_flyout_check.ps1`（点开溢出层逐个列文件名，注意 Win11 那个
  「显示隐藏的图标」按钮有时不支持 Invoke，脚本里做了多模式回退 + 鼠标兜底）。
- **免装 Python（2026-09-16 按用户要求补）**：
  * Windows 侧本来就是 PyInstaller 单文件包（Python + requests/pystray/Pillow/tkinter 全在里面）；
    **实证**：把 `PATH` 缩成 `C:\Windows\system32;C:\Windows`、`PYTHONHOME`/`PYTHONPATH` 指向不存在的目录，
    `AntiPrintVPrinter.exe --status` 照样 2.1 秒跑出 JSON（用例在 `.tmp-test/vprinter_exe_test.py` 的 1b 段）。
  * **macOS / Linux 也能免 Python**：`deploy/pack-vprinter.sh` 改成跨平台（解释器按
    「Windows venv → POSIX venv → python3」找；`.ico`/版本信息只 Windows 生成；`--add-data` 的分隔符按平台取；
    产物名在非 Windows 上加 `-macos`/`-linux` 后缀）。**跨平台二进制得在对应平台上构建**（PyInstaller 不能交叉编译）。
  * 分发包里补了 `start-vprinter.sh` / `check-vprinter.sh`（优先跑同目录可执行文件，没有才退回 `python3`）
    与 `快速开始.txt`（三步说明，给不看长文档的人）。
  * `setup-cups.sh` / `uninstall-cups.sh` 取版本号时**先试 python3，没有再问同目录的可执行文件**
    （`AntiPrintVPrinter --status` 里抠 `"version"`）—— 免 Python 的机器上队列名才不会退化成不带版本号的 `AntiPrint`。
- **可选的桌面快捷方式**：`vp_platform.create_desktop_shortcut()` / `shortcut_exists()` / `shortcut_path()`，
  入口：配置界面「运行状态」页按钮、托盘菜单、`--create-shortcut`，以及**首次启动时问一次**
  （仅 exe 形态、还没有快捷方式、`config.shortcut_asked` 未置位时问，问过就记住不再问）。
  * Windows 用 PowerShell 建 `.lnk`（目标 = `launch_argv()`，图标 = exe 自带图标或现场生成的 `.ico`；
    **冻结形态最怕把目标写成 python**，用例会读回 `.lnk` 断言目标就是 exe）；
  * macOS 写 `.command`、Linux 写 `.desktop`；
  * **桌面目录必须认注册表**（`...\Explorer\User Shell Folders\Desktop`）—— 本机桌面被重定向到 `D:\imgC\desktop`，
    写 `%USERPROFILE%\Desktop` 会落到另一个（Explorer 不显示的）目录；测试用
    `ANTIPRINT_VPRINTER_DESKTOP` 指到临时目录，不动用户真实桌面。
- **启动速度：别在启动路径上起 PowerShell**（2026-09-16，用户反馈「打开软件好慢」）—— `queue_exists()` /
  `queue_detail()` 原来都走 `powershell Get-Printer`，而 Windows PowerShell 5.1 **每次启动就要 1.5~2.5 秒**；
  配置界面初始化要问两次（队列在不在 + 驱动/端口），守护进程启动前再问一次，于是打开窗口要 5.5~6 秒、
  `--status` 4.66 秒里 4 秒全耗在这。现在改成**读注册表**（`HKLM\SYSTEM\CurrentControlSet\Control\Print\Printers\<队列>`，
  值 `Name`/`Port` 就够用，5 个队列共 0.001 秒）+ **5 秒缓存**（一次启动里同一份数据会被问好几次）；
  刚装/卸完队列的调用方传 `windows_printers(refresh=True)`（GUI 的「刷新状态」就是这么做的）。
  实测：配置界面出现 **5.5~6 秒 → 1.74 秒**，`--status` **4.66 → 2.24 秒**，`--selftest` **5.5 → 2.52 秒**。
  剩下的开销是 PyInstaller 单文件每次解包（约 1.4 秒）+ 进程启动；**要更快就换 onedir**：
  `--status` 实测 3.79 →（同样是注册表版）约 0.8 秒级别，代价是从「一个 exe」变成「一个文件夹」（exe + `_internal\`）。
  注册表里**没有驱动名**（`DsDriver` 子键存的是能力参数，不是驱动名），所以 `queue_detail()` 现在只报端口；
  真要驱动名的地方（装机脚本输出、`windows_job_name`）继续用 PowerShell —— 它们不在启动路径上。
- **双击 exe = 打开配置界面**（`handle_already_running()`，2026-09-16 按用户反馈改）：以前锁被占时一律弹
  「已经在运行，要不要接管」，用户每次双击都点「是」→ 把自己刚起的那份杀掉重启 → 又看到同一个窗口，像卡死一样。
  现在分三种情况：① 有控制台 / `--silent`（命令行、自动化、开机自启）→ 只打印一句、不弹窗；
  ② **同一份程序又点了一次**（`other_instances()` 里的可执行文件路径 == 自己，即双击桌面图标）→ 直接把配置界面
  开出来（`open_settings_window()`），**不弹窗、不杀进程**；③ **另一份副本在跑**（路径不同，升级场景）→ 才弹窗问要不要接管。
  配套：`autostart_command()` 末尾带 `--silent`（开机自启不主动弹界面）；`other_instances()` 用 CIM 取
  `ProcessId + ExecutablePath`，并**排除自己与自己的父进程**（单文件 exe 父子同名）。
- **队列名 = 驼峰品牌名 + 版本号**（`AntiPrint-1.0.0`，2026-09-16 按用户要求改）：`vp_config.DEFAULT_PRINTER_NAME =
  f"{DEFAULT_PRINTER_BASE}-{VERSION}"`，换版本号名字自动跟着变，打印对话框里一眼看出装的是哪一版。要点：
  ① **用连字符不用空格**（CUPS 的队列名不允许空格，Windows 侧跟着统一）；
  ② **落盘文件名跟着队列名走**（`spool_file_for(name)`，监听目标 `watch_targets(cfg)` 也按 `cfg.printer_name` 推导）——
     否则新队列入库写 `AntiPrint-1.0.0.pdf`、守护进程还盯着老的 `ANTIPRINT.pdf`，打印看起来「没反应」；
  ③ **老名字要迁移 + 清理**：`load_config()` 把配置里存的 `ANTIPRINT` 自动升成新默认名（用户自定义的名字不动），
     `vp_printer.install()` 建完新队列后调 `legacy_cleanup()` 把 `LEGACY_PRINTER_NAMES` 里的老队列连同它的端口/文件清掉
     （只碰我们自己的名字）；
  ④ 分发包里的 `install-printer-windows.ps1` 默认名由**打包脚本**把版本号替换进去（仓库里那份保持不带版本的 `AntiPrint`，
     直接跑也能用），替换数量在打包时会断言（必须是 2 个 ps1）。
- **图标 = 网站 logo（2026-09-16）**：托盘图标、窗口图标、exe 图标全部用网站那一份
  `frontend/public/apple-touch-icon.png`（品牌绿圆角方块 + lucide Printer 白色描边，由 `frontend/scripts/make_favicon.py` 生成）。
  `vp_tray.load_logo(size, state)` 按「exe 包内 `assets/antiprint-logo.png` → 程序目录 → 仓库 `../frontend/public/`」找图并缩放，
  失败态只是把徽标色换成砖红（`_recolor_badge`，白色图标与透明背景保留）；都拿不到才退回 `make_image()` 画的兜底图标。
  `deploy/pack-vprinter.sh` 组包时把网站 logo 复制进 `assets/` 并用 `--add-data` 塞进 exe（**不要**改成手绘近似图标，用户看得出不一样）。
- **提交后弹窗提示**（`settings.notify_popup` 的对等物，存本地 `config.notify_popup`，**默认 False = 不弹**）：
  `Tray.notify()` 始终更新图标颜色与悬停文字（鼠标划过去就能看到结果），只有勾了这个开关才 `icon.notify()` 弹气泡。
  配置界面右下角、托盘菜单里各有一个开关，改完即时生效（托盘菜单走 `_toggle_notify()` → 写配置 + `pipeline.update_config()`）。
- **默认服务器 = `https://print.anticraft.top`**（`vp_config.DEFAULT_SERVER`，2026-09-16 起）：新装的用户不用手填地址，
  只要在配置界面填账号密码即可；`config.example.json` 同步。
- **界面截图验收**（比读代码靠谱，2026-09-17 用它逮到「运行状态页被裁」）：
  `powershell -ExecutionPolicy Bypass -File .tmp-test/capture_close_prompt.ps1 -Source`（源码形态，改完界面立刻能看，
  不用等打包；去掉 `-Source` 则用分发包里的 exe）。脚本会塞一份「有账号 + 队列名不存在」的临时配置，让窗口
  **直接停在「运行状态」页**，截一张，再发 `WM_CLOSE` 截「× 弹窗」，图落在 `.tmp-test/shots/`
  （`vprinter-settings.png` / `vprinter-close-prompt.png`）。
  **两个坑**：① PowerShell 5.1 的 `Set-Content -Encoding UTF8` **带 BOM**，`json.loads` 读到 BOM 会失败并静默
  退回默认配置（表现为「账号明明填了却显示空」）—— 脚本里用 .NET `UTF8Encoding($false)` 覆写；② **UIA 读不到 Tk 控件**
  （Tk 没有 UIA provider），别指望用 UIA 验 Tk 界面，规规矩矩截图。
- **配置界面**（`vp_gui.py`，2026-09-16 重做）：白底 logo 标题条（网站 logo + 版本 + 平台）+ **一排二级菜单**
  （网站账号 / 提交选项 / 运行状态，选中那个是品牌绿底）+ **底部固定操作条**（保存并应用、打开数据目录、
  开机自动启动、提交后弹窗提示）。窗口默认 780×600（`min(600, 屏幕高*0.78)`；分栏前是 770 高，用户要求压短）。
  **底部两个勾选框「勾了即存」**（2026-09-17 用户要求）：`_toggle_autostart()` / `_toggle_notify()` 立刻
  `save_config()` 并给提示 —— 它们读的是配置文件、托盘菜单也读配置文件，不点「保存并应用」也该生效；
  「保存并应用」只管那些输入框（服务器/账号/份数/备注/配送）。
  **点 × 问一句**（2026-09-17 加，见上「退出语义」）：`root.protocol("WM_DELETE_WINDOW", self._on_close)` →
  `ClosePrompt` 小弹窗（只关界面 / 退出程序 / 取消 + 勾「记住我的选择」）+「运行状态」页的单选
  （`self.var_close` / `self.close_radios`，改完立刻 `save_config`）。
  `_on_close()` 的逻辑单独可测：取消 → 什么都不做；`window` → 只 `destroy()`；`quit` → `stop_daemon()` 再 `destroy()`；
  `ask` → 弹窗 + 勾了就写配置。**用例替身要真 Toplevel**（`_on_close` 里 `wait_window(prompt)` 需要真窗口，
  桩对象会 TclError）。
  **「运行状态」页可滚动**（`_page("运行状态", scroll=True)`，2026-09-17 截图验收发现加的）：那页东西会越加越多
  （队列/守护/数据目录/收件目录 + × 的行为 + 最近提交），窗口矮或顶部出现提示条时**会从底部开始裁**
  —— 实测「最近提交」整块被挤出页面区、单选行被裁一半（截图在 `.tmp-test/shots/`）。现在内容放在
  Canvas 里 + 右侧滚动条（`window._scroll_canvas`），鼠标滚轮可用；账号/提交两页不动，保持原布局。
  结构：`outer` 用 grid 分 5 行 —— 0 标题条 / 1 二级菜单 / 2 提示条（缺账号缺队列时才出现）/ 3 页面区（权重 1）/ 4 底部操作条；
  三个子界面**叠在页面区的同一格里**靠 `tkraise()` 切换，`_show_tab()` 只管换按钮样式 + 抬页。
  踩过的点：① 同一个容器里别混用 `pack`/`grid`（直接 TclError；`pack` 还会按创建顺序分配空间，先 pack 的会吃光高度、
  把底部操作条挤没）；② 初始尺寸按 `winfo_screenheight()` 自适应（固定值在 800px 高的远程桌面上会把关键按钮顶到屏幕外）；
  ③ 按钮配色靠 `ttk.Style().theme_use("clam")` 才生效；④ **用例里判断窗口布局别去猜行号**（原来按 `grid_info()["row"] == 2`
  找底部操作条，改成 5 行后取到的是提示条 → `IndexError` 让整段界面用例被 `except` 静默跳过、连带后面的 `--simulate`
  因为配置没保存而失败；现在用例直接用界面暴露的 `window.footer` / `window.footer_row`）。
- 命令行：`--settings` / `--selftest`（配置·登录·收件目录·队列·自启动·托盘逐项给结论，关键项失败退出码 1）/
  `--status`（JSON，含数据模式/实例锁路径）/ `--once` / `--simulate 文件`（把文件当「刚从打印机出来的」走完整链路）/
  `--retry-failed` / `--install-printer`（建/修复队列，要管理员）/ `--uninstall-printer` / `--no-tray` / `--init-config`；
  Windows 上还有 `start-vprinter.bat` / `check-vprinter.bat` / `stop-vprinter.bat`
  （`stop-vprinter.bat` 用 CIM 匹配 `virtual_printer` 的 pythonw 进程与 `AntiPrintVPrinter.exe`，不碰打印代理）。
- **依赖**：`requests` + `pystray` + `Pillow`（tkinter 是标准库；Linux 可能还要 `python3-tk`）。本机验收时是装进
  `backend\.venv` 的（`pip install -i https://mirrors.aliyun.com/pypi/simple/ pystray Pillow`）。没有图形环境就用 `--no-tray`。
- 与现有脚本的关系：`stop.ps1`（= `stop.bat`）按「可执行文件路径含 AntiPrint」杀进程，**会顺带把虚拟打印机一起停掉**；
  `run.bat`/`setup.bat` 不管它（它是给用户用的桌面程序，不是服务的一部分）。Windows 上它自带 `install/`、
  不需要 `agent/` 的任何东西，也不需要 `agent_token`。

### 打成 Windows exe（单文件绿色版，给不装 Python 的用户）

`bash deploy/pack-vprinter.sh` → `dist/AntiPrintVPrinter-<版本>.zip`（exe 23MB + `install/` + README + 三个 bat）
→ 实跑全部 40 项 exe 用例通过（见验证记录）。解压后双击 exe 即用（队列由程序引导安装，见上一节的「绿色版」）。
构建细节与坑：

- **PyInstaller**（`--onefile --windowed`，构建时才 pip 装，不进分发包）：`--icon` 与 `--version-file` 都由打包脚本
  **现场生成**（图标复用 `vp_tray.make_image(BRAND, 256)` 存成多档 .ico；版本信息用 `vp_config.VERSION`）。
  **`--icon`/`--version-file` 必须传绝对路径** —— PyInstaller 会相对 `--specpath` 再解析一层，相对路径会变成
  `dist/.vprinter-build\dist/.vprinter-build/version-info.txt` 这种鬼路径（踩过）。构建产物在 `dist/.vprinter-build/`（gitignore）。
  **单文件冷启动实测 5~7 秒**（每次都要解包到临时目录），托盘常驻后无此开销；`--skip-build` 可只重新组包。
- **打包脚本里跑 exe 自检要给它临时 HOME**：绿色版 exe 会在**自己旁边**建 `AntiPrintVPrinter-data/`，
  直接跑 `$STAGE/AntiPrintVPrinter.exe --selftest` 会把数据目录写进分发包（下一次 `--skip-build` 就把它打进去了）。
  脚本现在给自检设 `ANTIPRINT_VPRINTER_HOME` 到构建目录，并在组包后 `rm -rf` 一遍 + 校验里加了这一项。
- **冻结后三处路径必须走 `vp_platform`**：`IS_FROZEN` / `app_dir()`（= exe 所在目录，自检里提示 install 脚本位置用它）/
  `launch_argv()`（= `[exe, ...]` 或 `[pythonw, virtual_printer.py, ...]`）。**托盘菜单打开配置界面、三条自启动
  （Run 注册表 / LaunchAgent / .desktop）全部改走 `launch_argv()`/`start_command()`** —— 写死 `python_launcher() + 脚本路径`
  在 exe 里会变成「拿 exe 当解释器去跑一个不存在的 .py」，配置窗口和自启动双双击穿。
- **窗口程序从命令行跑要自己接控制台**：`virtual_printer.py` 的 `attach_console()` 在
  **`--selftest/--status/--once/--simulate/--retry-failed/--init-config`** 时 `AttachConsole(-1)` 并重开 `CONOUT$`，
  这样 `check-vprinter.bat` 里能看到输出；**守护模式（托盘/`--no-tray`）绝不能挂** —— `start-vprinter.bat` 用 `start`
  拉起后 bat 自己会退出，控制台一关，Windows 会给挂在它上面的进程发 `CTRL_CLOSE_EVENT`，托盘进程会被连带杀掉。
  自动化里要拿到干净的标准输出就设 `ANTIPRINT_VPRINTER_NO_CONSOLE=1`（会跳过 AttachConsole）。
- **打包脚本里的文本转换不要用 `sed`**：Git Bash 的 sed 对**已带 BOM**的文件不做行尾转换（实测：不带 BOM 的正常转，
  带 BOM 的原样输出），README 会停在 LF。`pack-vprinter.sh` 改用 Python 显式读写字节（`\r\n` + BOM），
  `deploy/pack-agent.sh` 里同样写法的两行**可能有同样的毛病**（未验证、未改动，只是提醒）。
- 校验：包内不得出现 `config.json`/日志/令牌（脚本会查，还查一遍疑似 JWT）；README 加 UTF-8 BOM + CRLF、bat 纯 ASCII+CRLF。
- **单文件 exe 是「父子两个进程」**（父=解包器，子=真正跑程序的）：`Popen.terminate()` / 任务管理器里强杀
  只杀得掉父进程，子进程会活着继续占托盘图标和单实例锁（本机验收时留下过 6 个孤儿进程，溢出层里一堆重复图标）。
  **用户侧**：托盘菜单「退出」，或 `stop-vprinter.bat`（CIM 按进程名 `AntiPrintVPrinter.exe` 把父子一起停，实测剩余 0 个）；
  **脚本侧**：要停 exe 就走 `stop-vprinter.bat`，别自己 terminate（`.tmp-test/vprinter_exe_test.py` 的 `stop_all()` 即此）。

## 微信小程序（kbone，2026-09-16 新增）

`miniprogram/` —— **用户端**小程序：登录 → 选文件 → 填配送 → 提交 → 看任务/余额/配置。
**独立工程，其它端源码不动**；只在用户侧跑，不参与线上部署（部署仍是 `deploy/pack.sh` 那套）。
使用者/开发者说明见 `miniprogram/README.md`。范围：**不做管理端**（审核、队列、管理设置仍只在网站上做）。

- **技术选型**：kbone 三件套 `mp-webpack-plugin@1.6.6` + `miniprogram-render@2.2.29` + `miniprogram-element@2.2.23`，
  **React 固定 17.0.2**（kbone 的事件模拟按 React 17 之前的口径写的，别升 18）；样式是手写 wxss 类名（`src/app.css`），
  不用 Tailwind（kbone 的 CSS 走 `mini-css-extract-plugin` → 小程序 wxss，Tailwind v4 的 vite 插件在这里用不上）。
- **`@shared` 别名 → `../frontend/src`（只读）**：`api.ts`/`util.ts` 直接 `import type {...} from '@shared/types/api'`、
  `import { STATUS_*, PAPER_OPTIONS, describePrintOptions, ROLE_LABEL } from '@shared/constants'`，
  所以状态字面量、打印选项、计费文案与网站是**同一份**。**唯一不共用的是 `formatTime`** —— web 版用 `toLocaleString`，
  小程序的 JSCore 不一定有 Intl，小程序里另写了一份手工拼串的（`src/util.ts`）。
- **入口契约**（kbone 的硬性要求，搞错就是白屏）：
  - app 入口 `src/index.js`：模块顶层直接 `window.appOptions = {...}`（kbone 的 `app.tmpl.js` 读 `fakeWindow.appOptions` 交给 `App()`）
    ——**app 入口里的 window 是空对象 `fakeWindow`，碰 `document` 会崩**。
  - 页面入口：`export default function createApp() { return createPage(window, document, <Page />, ...) }`，
    配合 webpack `output.library = { name: 'createApp', type: 'window', export: 'default' }`
    —— 产物被 kbone 包装成 `module.exports = function(window, document) {...}`，页面模板 `init(window, document)` 之后
    会调用 `window.createApp()`（此时才把我们的 createApp 挂到**页面私有的 window** 上）。
    **页面入口的顶层代码会在 `init` 被调用时执行**，所以「模块顶层直接 render」也能跑，但**不要写成只导出函数不调用**。
  - `router` / `pages` 配置的 key 是**页面名**（`login`，不是 `pages/login/index`）——kbone 内部按 `pages/<页面名>/index` 拼小程序路径；
    `pages[name].defaultTargetUrl` 给每个页面一个 DOM 地址（`/login`、`/jobs`…），`pullDownRefresh` 只给任务列表开。
- **跳转统一走 `src/page.ts` 的 `go()` / `goLogin()`，别在页面里自己写**：`go('/jobs')` 对 **tabBar 页直接调 `wx.switchTab`**
  （**不能带 query** —— 走 kbone 的 `location.href` 时它会拼 `?type=jump&targeturl=…`，微信会一直刷
  「wx.switchTab: url 不支持 queryString」告警，2026-09-16 在开发者工具里实测到）；非 tabBar 页（登录页）才走 `location.href`
  （kbone 要用 targeturl 才能定位到页面）。`goLogin()` 用 `wx.reLaunch`（清页面栈，tab 页里也能跳）。
- **401 自动回登录页**：`api.onAuthExpired` 由 `page.ts` 的 `createPage()` 挂上 `goLogin`，任何请求返回 401 → 清令牌 + reLaunch 回登录页
  （与 web 端 `setOnAuthExpired` 行为一致，不用每个页面自己处理）。
- **tabBar 页切换不会重建页面**（`switchTab` 只切显示，页面实例与 React state 都留着）：所以**结束态要自己清**。
  `page.ts` 把 kbone 的 `wxshow` 接到 `util.triggerShow()`，页面用 `onShow(fn)` 注册——提交页就靠它把「提交成功」卡片清掉、
  切回来回到表单首页（2026-09-16 实测：提交成功 → 看我的任务 → 切回提交页仍停在成功页）。只清成功态、不动正在填写的内容。
- **每个页面是独立 bundle（没有公共 chunk）**：所以**每页各有一份 `api.ts` 实例**，进页面时必须在 `createPage` 里
  `api.restoreToken()` 重新读 `wx.getStorageSync`（否则第二页看到的是空令牌、被当成未登录踢回登录页 —— 2026-09-16 踩过）。
- **登录态存 `wx.getStorageSync`**（token / user / server 三个键）。默认服务器 `http://127.0.0.1:8301`（**故意不默认线上**，
  免得在开发者工具里点到线上打出真纸），登录页「服务器地址」卡片可改；上线要换 https + 在微信后台加 request/uploadFile/downloadFile 合法域名。
- **服务器地址固定**：`src/api.ts` 的 `SERVER = 'https://print.anticraft.top'`，界面上**没有**修改入口
  （用户端不该关心部署位置）。本机联调要改就改这个常量再构建；`urlCheck:false` 只影响开发者工具。
- **提交按「单文件」**：`wx.uploadFile` 一次只能传一个文件，而后端 `POST /api/jobs` 只支持建单时带文件（**没有追加文件接口**），
  所以小程序一次提交 = 一个文件，多文件分多次提交。上传前会把选中的文件**复制成原名**再传（`stageFile()`：`wx.uploadFile`
  用路径末段当文件名，聊天文件的临时名会丢原文件名），传完 `dropStagedFile()` 删掉暂存。
- **文件来源只有两条，且没有「浏览手机文件系统」的接口**（2026-09-17 逐条核对官方 API 类型定义得到的结论，别再去猜）：
  全部 `choose*` 接口只有 `chooseAddress / chooseContact / chooseImage / chooseInvoice / chooseInvoiceTitle /
  chooseLicensePlate / chooseLocation / chooseMedia / chooseMessageFile / choosePoi / chooseVideo`——**没有任何本地文件选择器**；
  `wx.chooseMessageFile` 的官方描述只有「**从客户端会话选择文件**」；`wx.getFileSystemManager()` 只能读写
  `wx.env.USER_DATA_PATH`（小程序沙箱），**看不到手机文件**；`<button>` 也没有能选文件的 `open-type`。
  所以实现是：①「选择文件（聊天记录里选）」= `wx.chooseMessageFile({count:1, type:'all'})`；②「拍照或从相册选图片」= `wx.chooseMedia({mediaType:['image'],
  sourceType:['album','camera']})`。**手机里的文件要在界面上告诉用户**先发给「文件传输助手」再从聊天记录里选（这句话写在文件卡片下方）。
  **2026-09-17 用真浏览器渲染官方文档复核过的原文**（WebFetch 读不到 SPA，搜索引擎直连超时；抓下来的正文存在
  `.tmp-test/shots/wxdocs/*.txt`）：`wx.chooseMessageFile` 的功能描述只有「从客户端会话选择文件。」，`type` 的 `file` = 「**除了图片和视频之外的其它文件**」
  （所以这里必须用 `type:'all'`，原来写 `'file'` + 含 png/jpg 的 extension 过滤是选不到图片的 bug，已修），`extension` 仅 `type==file` 时有效；
  「文件系统」能力页原文：本地文件是**以用户维度隔离的小程序沙箱**（临时/缓存/用户文件共 200MB），「本地临时文件只能通过调用特定接口产生，不能直接写入内容」；
  文件分类里唯一与磁盘有关的是 `wx.saveFileToDisk`（「保存文件系统的文件到用户磁盘，**仅在 PC 端支持**」）——那是**写出**方向。
  **即：小程序没有任何「读入手机/电脑本地文件」的接口。**
- **预览入口要做显眼**（用户反馈「找不到」）：选完文件后文件行下面是一整行 `btn-row`「预览文件 / 移除」（不是小灰字），
  图片还会在文件行里直接给缩略图（`<img mode="aspectFill">`，mode 是微信属性，TS 里靠 `IMG_MODE` 透传）；
  「我的任务」里每个文件右侧是 `btn-ghost` 的「预览文件」按钮。提交前预览用 `api.openLocalFile()`（本地临时路径）。
- **界面字号可调（标准/大/特大）**：偏好存 `wx` 本地缓存 `antiprint_scale`，`page.ts` 的 `applyUiScale()` 把
  `scale-lg` / `scale-xl` 写到 page 的 body 上（kbone 会同步到页面根元素的 class），wxss 里只覆盖几个 CSS 变量
  （`--fs-hero/--fs-title/--fs-btn/--fs-body/--fs-label/--fs-small/--fs-tiny/--fs-amount`）即可整页缩放；
  入口在「我的配置 → 界面字号」，改完立即生效（`applyUiScale()`），进任何页面时也会自动套用。
  **原生 tabBar 与导航栏不跟着变**（那是微信的 UI，改不了），这是已知限制。
- **打印设置只有「份数 + 页面范围」**（2026-09-16 按用户要求）：纸张**固定 A4**，不给用户选（机型与业务都只支持 A4，
  提交时仍带 `paper=A4`）；页面范围走 `pages` 表单字段（只允许数字/逗号/短横线，≤64 字，与后端白名单一致，前端先拦一道）。
  选完文件可以**先预览**再提交：`api.openLocalFile()`（图片 `wx.previewImage`、其余 `wx.openDocument`）。
- **文件预览**：`wx.downloadFile`（带 `Authorization` 头）→ `wx.openDocument`（PDF/Office，后端已把 Office 转成 PDF）；
  **图片走 `wx.previewImage`**（openDocument 不支持图片）。头像同理不可用（`<image src>` 带不了请求头），所以小程序不做头像。
- **构建**：`npm.cmd run build` = `webpack --mode production` + `node scripts/copy-runtime.js`。
  后者把 `node_modules/miniprogram-{render,element}/dist` 拷进 `dist/miniprogram/miniprogram_npm/`
  （等价开发者工具的「构建 npm」，**离线可重复**），并清掉插件生成的 `package.json` 与 `node_modules/.miniprogram` 标记，免得工具反复提示「依赖未构建」。
  产物布局：**`dist/` 本身就是项目根**（`project.config.json` 写在 `dist/` 根上，**不设 `miniprogramRoot`**）：
  `app.js/app.json/app.wxss/config.js/sitemap.json/project.config.json` + `common/`（webpack 产物，含被 `app.wxss` @import 的 `app.css`）
  + `pages/` + `miniprogram_npm/`；**开发者工具导入 `miniprogram/dist/`**。`dist/`、`node_modules/` 已被根 `.gitignore` 覆盖。
- **两条已在开发者工具里实测的硬约束**（2026-09-16，两条都踩过）：
  ① **抽出来的样式必须叫 `.wxss`**：`new MiniCssExtractPlugin({filename: '[name].wxss'})`。小程序的 `@import` 只认 wxss 扩展名，
     用 `.css` 时即使 `dist/common/app.css` 真实存在，开发者工具也报 ``[WXSS 文件编译错误] path `common/app.css` not found from `./app.wxss` ``。
     （`copy-runtime.js` 会顺手清掉历史构建留下的 `common/*.css`。插件侧对 `.css`/`.wxss` 都做了 adjustCss 处理，所以改名是安全的。）
  ② **项目根 = 代码根**：插件生成的路径都按此假设（根上 `app.wxss` 里 `@import "common/…"`、页面 wxss 里 `@import "../../common/…"`、
     `sitemap.json`、tabBar 图标目录）。加 `miniprogramRoot` 把代码根往下挪一层，或把项目根设在代码目录的上一层，
     会报 `[app.json 文件内容错误] app.json: 在项目根目录未找到 app.json`。**判断选对了没有：选中的目录里直接就有 `app.json`。**
- **样式注意**：kbone 的 `adjust-css` 会改写 wxss 里的选择器（`html`→`page`、标签名→taglist、**含 `~` 的选择器直接丢弃**），
  所以 `src/app.css` 只用类选择器 + `page`，类名与网站配方一一对应（`card` / `btn-primary` / `badge-amber` / `step` / `hero`…）。
- **样式不再走 `@import`**：构建后处理会把 `common/app.wxss` 的内容**内联进 `dist/app.wxss`**（并删掉那个文件）。
  原因：kbone 模板会把 `@import` 追加到 400 多行之后（`app.tmpl.wxss` 有 416 行），位置与解析行为都不可控 —— 实测出过
  「path `common/app.css` not found from `./app.wxss`」。内联后 app.wxss 是自包含的，样式一定生效，也不再依赖 `/p` 的解析。
- **界面（2026-09-16 重写）**：导航栏品牌青绿 + 白字（`app.json` window 段）、每页 `navigationBarTitleText`（`pages[name].extra`）；
  页面顶部有同色「色带」（`PageHeader`：标题/说明/信息胶囊），内容卡片上移 24px 压住色带；任务卡带四步进度
  （`util.jobSteps()`：已提交→审核→打印→交接，驳回/撤回/失败不显示进度）；提交页按钮固定在 `.bottom-bar`（fixed，自动让开原生 tabBar）；
  触摸高度 ≥44px。tabBar 图标是自绘的（`scripts/make_tab_icons.py`，纯标准库 PNG），改图标后重跑该脚本再 `npm run build`。
- **本地预览 + 横向溢出检查（没有开发者工具也能看效果）**：`node .tmp-test/miniprogram_preview.mjs [页面...]` ——
  用 kbone 运行时把产物渲染成 HTML、套上真实 `dist/app.wxss` 与导航栏/tabBar 外壳，chromium 截图到
  `.tmp-test/shots/miniprogram/`，并输出每页「右边缘超过 375px 的元素」。两个坑：
  ① 预览外壳**不要写** `* { box-sizing: border-box }`（wxss 不支持 `*`，写了会掩盖按钮顶出屏幕这类问题）——
  样式里的 `box-sizing: border-box` 都写在各个类上，凡 `width:100%` + padding 的容器必须手写；
  ② 预览页面用 `body.h5-body` 覆盖 kbone 的 `.h5-body{display:block}`，否则 flex 外壳失效、tabBar 被顶到屏幕外。
  （反向验证过：把 `.btn` 退回 `content-box`，检查能报出 383/395px 的溢出。）
- **给别人用（不需要 Node / Python）**：`bash deploy/pack-miniprogram.sh` → `dist/AntiPrintMiniProgram-<版本>.zip`
  （构建 + 组装 + 打 zip + 校验：不含 node_modules/*.map/*.log/package.json，含 project.config.json、app.json、
  pages、miniprogram_npm 运行时、logo 与一份「导入说明.txt」）。收包的人只要微信开发者工具，解压导入即可。
- **验证**：`node .tmp-test/miniprogram_test.cjs`（在仓库根跑，**44 项**）—— Node 里直接跑 kbone 的 `miniprogram-render`，
  把 5 个页面的**产物**真的挂起来：断言 React 渲染文本、徽章配色、`location` 兜底，并用 kbone 的冒泡 `CustomEvent` 模拟点击，
  覆盖「选文件 → 提交（校验 multipart 字段 files/delivery_mode/address/copies/paper）→ 成功卡片」「402 → 余额不足提示」
  「撤回 → 二次确认 → 调接口」「点文件名 → 下载（带令牌）」。**未实测**：wxss 实际渲染、`miniprogram-element` 的 wxml 投影、
  真实 `wx.chooseMessageFile`/`openDocument`、合法域名与真机 —— 这些要开发者工具 + 自己的 AppID（现为 `touristappid` 游客模式）。

## 任务状态机

`待审核 → 已通过 → 打印中 → 已打印 →（按配送方式）待配送 / 待取件 → 已完成`；异常支线 `已驳回`（**驳回必填理由**，允许提交人改后重提）、`打印失败`（可重试，回退到「已通过」重新入队）、**`已撤回`**（提交人在出纸前自己撤单：`POST /api/jobs/{id}/withdraw`，仅 `constants.USER_WITHDRAWABLE` = 待审核/已通过 可撤，会被代理抢单时返回 409）。管理员还可以 `POST /api/jobs/{id}/reprint` **重新打印**（已打印/打印失败/待配送/待取件/已完成 → 已通过，清空 printed_at/finished_at/agent_id/print_error；允许的起始状态见 `constants.ADMIN_REPRINTABLE`）与 `DELETE /api/jobs/{id}` **删除**（连文件目录一起删，前端二次确认）。**每次流转写 `print_jobs_logs` 留痕**（操作者、时间、原状态→新状态、备注）。状态取值用固定中文字符串，前后端共享，改动需两端同步（放 `backend/constants.py` + `frontend/src/constants.ts`）。

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
- 表：`users`（含 role、`source`、`anticraft_id`、`default_address` 默认配送地址、`default_delivery` 默认配送方式、**`balance` 余额**）、`print_jobs`（status/address/note/reject_reason/print_error/agent_id/`delivery_mode` 配送方式/claimed_at/printed_at/`finished_at` 完成时间）、`print_job_files`（任务文件）、`print_jobs_logs`（流转留痕）、`agents`（设备+心跳+能力）、`settings`（k/v：agent_token、启动器、打印机、份数、dry_run、agent_enabled、Print_price、free_users、anticraft_* 等）、**`balance_logs`（余额流水：delta / balance_after / reason / job_id / actor）**；`print_jobs` 另有 **`charge`**（本单扣费，退费后归零）。
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
  - 用户管理接口（2026-09-14 新增）：`GET /api/users`（admin/root 可看：角色/来源/anticraft 绑定/任务数/注册时间/**余额**）、`POST /api/users/{id}/role`（**仅 root**，body `{role: 'user'|'admin'}`）。护栏：不能改自己的角色、不能改 root 的角色、**不允许通过接口把谁设成 root**（role 只能 user/admin）。
  - 线上 `end` = root（本机同样）；`end` 是经 anticraft 授权登录自动建号的账号（`source=anticraft`）。前端 `/users` 页（侧栏「用户管理」，**admin/root 都能进**）现在是**账号操作中心**：① 加/收管理员（**仅 root**，`POST /api/users/{id}/role`）；② **免费账户开关**（写 `settings.free_users`，admin/root 都行——白名单**已从管理设置挪到这里**）；③ 调整余额（admin/root）；④ **批量添加免费账号**（用户管理页顶部：一行一个或逗号分隔，可**预登记还没注册的名字**——白名单按用户名判定，所以这个名字一注册/登录就自动免费；页面上会单独列出「名单里还没注册的名字」并可单个移除）；⑤ **删除账号**（**admin/root 都能**，`DELETE /api/users/{id}`：余额必须为 0、不能删自己或 root；只删 `users` 行，**任务与余额流水保留**，任务列表里提交人显示为空）。管理设置的二级菜单因此只剩 **4 栏**（打印设置 / 打印计费 / anticraft 绑定 / 打印代理）——两个名单类分栏都取消了：免费白名单改到用户管理页按账号开关，**管理员名单**（`settings.anticraft_admin_users`）不再有界面（后端 `_promote_if_anticraft_admin` 逻辑仍在，需要时可用接口设置，或直接在用户管理页给已注册的 anticraft 账号「设为管理员」）。
  - anticraft 管理员映射：`_promote_if_anticraft_admin()` 只把 **user** 提升为 admin（不动 admin/root，不降级）；密码登录路径优先用 anticraft 返回的 `role`，OAuth 路径因其开放接口不返回角色，走设置项 `anticraft_admin_users`（逗号分隔用户名）。
- 默认管理员播种（`ADMIN_PASSWORD` 环境变量可覆盖），登录限速（5 次/分钟/IP）。
- **文件下载/预览必须鉴权**：仅任务提交人本人或管理员可取，带 `Content-Disposition` + `X-Content-Type-Options: nosniff`；`agents` 令牌只能领取/回报任务，**不得读他人文件**。

## 账户余额与计费（2026-09-15 新增）

**免费账号**：`role in (admin, root)`、`users.source='anticraft'`、用户名在 `settings.free_users`（逗号分隔）；其余一律计费。

- **单价**：`settings.print_price`，默认 `0.1`（元/张）。管理设置页可改，服务端 `billing.parse_price()` 校验（0 ~ 100、两位小数，非法 400）。
- **张数**（`billing.estimate()`）= Σ 每个文件 `ceil(实际打印页数 ÷ 每张页数) × 份数`：
  页数取**可打印 PDF 的页数**（Office 用转换后的 PDF；图片按 1 页）；`每张页数` 来自该文件的 `nup`（"2,2" = 4 页/张）；
  `实际打印页数` 受该文件的页面范围（"1-3,5"）限制；份数按「文件级 → 任务级 → 1」的优先级。
  PDF 页数用 `billing.count_pdf_pages()`：先数明文 `/Type /Page`，数不到再解压 Flate 流数一遍（PDF 1.5+ 的对象流），解析失败按 1 页。
- **扣款是原子的**：`db.create_job(..., charge=)` 在同一事务里 `UPDATE users SET balance = balance - charge WHERE id=%s AND balance >= charge`，
  影响行数 0 就抛 `db.InsufficientBalance` → 接口回 **402**，**不建单、不扣钱**；并发提交也不会扣成负数。金额一律 `Decimal`（精确到分）。
- **402 的响应体**：`detail = {code: "insufficient_balance", message, cost, balance, sheets}`；前端 `ApiError`（带 status/detail）识别后弹
  「余额不足 → **付款码（暂未实现）**」占位弹窗（`SubmitPage` 的 `paywall`），并给「去我的余额」入口。
- **退款**：`db.refund_job()` 把 `print_jobs.charge` 清零 + 加回余额 + 记流水，**同一事务**且幂等（charge 已 0 就什么都不做）。
  触发点：**驳回**、**撤回**、**管理员删除**（仅当状态是 待审核/已通过/已驳回/已撤回，即没出过纸）。打印失败**不退**（可重新入队/重新打印，不会重复扣款）。
- **余额与流水**：`users.balance`（DECIMAL(10,2)）、`print_jobs.charge`（本单实际扣了多少，退费后归零）、`balance_logs`（每次变动一行：
  delta / balance_after / reason / job_id / actor）。用户侧 `GET /api/balance` 返回余额、是否计费、免费原因、单价与最近 50 条流水。
- **谁可以调账**：`POST /api/users/{id}/balance`（body `{delta, note}`）**admin 与 root 都能**（充值是线下收款后手工记账；与「改单价/加白名单」同级的运营权限）。
  用户管理页有「调整余额」按钮（正数加、负数扣，扣成负数会被拒）。
- **前端**：`/balance`「我的余额」页（余额、账号类型、单价、消费记录、充值占位说明），导航在侧栏底部组；提交页第一步显示
  「按 X 元/张 计费…当前余额 Y 元」（免费账号显示「免费账号（原因）」），成功后卡片显示「本次扣费 / 余额」。
  管理设置页「打印计费」卡片改单价与白名单；用户管理页显示每人余额并可调账。
- **测试注意**：**别把 UI 用例连成一串跑**——每个用例都要登录，登录接口 10 次/分钟/IP，连跑 4~6 个就会 429（现象：用例前半段全绿、后面 0 项通过或断言莫名失败）。中间停 20~60 秒，或重启后端清空计数器。
- **提交纪律（血泪教训）**：**一律用显式路径 `git add <文件1> <文件2>…`，不要 `git add -A`**。工作区里同时可能有别的并行开发（例如 2026-09-15 出现的 `vprinter/` 虚拟打印机客户端，非本代理所作），`-A` 会把别人的在研文件一起提上来；本次还差点把一个**仍在有效期内的本地管理员 JWT**（`.tmp-test/.admin-token.json`）提进历史（该文件已在 `.gitignore` 里，但**行内注释会被 Git 当成模式的一部分**——`foo.json  # 注释` 不生效，注释必须独占一行；已改正，并 `reflog expire + gc` 清掉了那次误提交的对象）。
- **测试注意**：写测试/补丁脚本时，**含换行转义、`\u`、JSX 或模板字符串的内容一律用 Write/Edit 工具写文件**，别塞进 bash heredoc —— 实测被吃掉转义三次（e2e.py、ui-test22、补丁助手各坏一次）。
- **测试注意**：`ui-test*.mjs` 里管理员令牌统一走 `.tmp-test/lib/admin-token.mjs` 的 `adminTokenCached()`（缓存 10 分钟 + 用 GET 抽查），避免连跑多个 UI 用例把登录接口的 10 次/分钟限速打满（2026-09-15 实测：连跑 4 个用例会 429 → 用例 0 项通过）。
- **测试注意**：新注册的本地账号**余额为 0 → 提交会 402**。`.tmp-test` 里的老用例已统一在注册后加一句「管理员充 100 元」
  （`patch_tests_credit.py` 的产物，见 AGENTS.md 验证记录）；新写用例照做，或者把账号加进白名单。

## 上传与安全

- 单文件 ≤10MB、单任务 ≤5 个文件；**扩展名黑名单**（可执行/脚本/网页/Office 宏等一律 400，沿用 `antiClass` 的 `DANGEROUS_EXT` 思路）；sha256 内容去重；文件名净化 + 防目录穿越（存 `backend/data/uploads/<job_id>/`，库内存相对路径）。
- 白名单 `constants.UPLOAD_EXT` = PDF / png / jpg（直接可打印）+ **docx/doc/pptx/ppt（Office，先转 PDF）**；含宏的 docm/pptm/xlsm 仍在黑名单，其余类型 400。
- **一个任务里可以混装**：Office 文件各自转出的 PDF 与原生 PDF/图片一起交给代理打印，代理侧看到的一律是 PDF。

## Office 转 PDF（Word / PPT，2026-09-15 新增）

**放服务端转换**（不是代理端）：提交人要在**提交前**就预览内容（提交页第一步右栏），只有服务端能转；代理于是永远只拿 PDF，SumatraPDF 侧零改动。

- **转换器两个后端，自动挑**（`backend/convert.py`，都不需要 pywin32）：
  ① **LibreOffice headless**（跨平台，**生产 = 阿里云 Linux 走这条**）：`soffice -env:UserInstallation=<临时 profile> --headless --nologo --norestore --convert-to pdf --outdir <目录> <文件>`。
  ② **Microsoft Office COM**（仅 Windows，PowerShell 驱动 Word/PowerPoint，本机开发/验收在用）：PowerPoint `SaveAs(...,32)` / Word `ExportAsFixedFormat(...,17)`。
  查找顺序：`SOFFICE_PATH` 环境变量 → `PATH` 里的 `soffice` → 常见安装路径（`C:\Program Files\LibreOffice\program\soffice.exe`、`/usr/bin/soffice`、`/usr/lib/libreoffice/program/soffice`、snap…）。找不到 LibreOffice 且不是 Windows 时才报错。
- **缓存**：`backend/data/converted/<sha256>.pdf`（内容寻址）。提交页预览转一次 → 正式提交同一份文件**直接命中缓存**；删除任务时若没有别的任务引用同一 sha256 就一并删掉缓存（`db.sha256_in_use()`）。
- **接口行为**：① `POST /api/preview/office`（multipart 单文件，登录即可）返回转换后的 PDF，给提交页预览用；② `GET /api/jobs/{id}/files/{fid}` **inline 时 Office 一律给转换后的 PDF**（文件名变成 `原名.pdf`），`?download=1` 才是用户上传的原文件；③ 代理的 `GET /api/agent/jobs/{id}/files/{fid}` 也给 PDF，并在 claim 里带 `print_name`（`原名.pdf`）。
- **代理约定**：`download_file` 用 `print_name`（没有则退回 `filename`）落盘 —— **后缀必须是 `.pdf`**，否则 SumatraPDF 按 `.docx` 拒打。
- **失败即拒绝**：上传时转换失败直接 400（中文原因），**不让打不出来的任务进队列**；提交页预览失败也会直接显示错误。
- **Office COM 的四个坑（本机实测，改前必读）**：① 输出路径必须在 Python 侧算好、**以字面量传给脚本**——脚本里用 `Join-Path` 拼出来的路径（值一模一样）会让 `ExportAsFixedFormat` 静默卡死到超时；② 必须 `powershell -Command <内联脚本>`，**不能用 `-File 脚本文件`**（同样卡死）；③ 收尾 `Quit` 必须 `try/catch` 包住，否则 `Quit` 报错会留下无窗口僵尸 `WINWORD`，下一次转换直接卡死；④ 转换失败/超时后调 `convert.reset_office_state()`：先 `GetActiveObject` 礼貌退出、再兜底 `Kill` 无窗口实例（用户自己开的 Word 有窗口，不会误杀）、最后清 `HKCU\...\Word\Resiliency\DocumentRecovery`（强杀会让 Word 记崩溃恢复，之后每次启动都可能弹恢复面板卡住）。
- **超时**：LibreOffice `config.CONVERT_TIMEOUT=180s`（首次启动 + 大文档），Office COM `COM_TIMEOUT=90s`（正常 5~25 秒：Word 约 6s、PPT 约 23s）。转换串行（模块级锁），避免多个 LibreOffice/Office 实例互相抢。
- **装机要求**：生产服务器（Linux）必须装 LibreOffice：`apt-get install -y --no-install-recommends libreoffice-writer libreoffice-impress`；Windows 用 `winget install TheDocumentFoundation.LibreOffice`。本机（开发/验收）用 Microsoft Office COM，所以**没装 LibreOffice 也能转**；装了 LibreOffice 会自动优先用它。

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
  - 表格：`w-full` + 表头 `border-b border-gray-100 dark:border-white/10` 与 `px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400` + 行 `group border-b border-gray-50 transition-colors hover:bg-warm dark:border-white/5 dark:hover:bg-white/5`；行内操作按钮一般用 `opacity-0 transition-opacity group-hover:opacity-100`，**但任务队列是例外：操作按钮常显**（触屏没有 hover，`opacity-0` 在手机上等于永久隐藏，2026-09-15 实测踩过）
    - **任务队列表格用 `table-fixed` + `<colgroup>` 定宽**（2026-09-15）：任务 210 / 文件与设置 **auto**（吃剩余宽度）/ 配送方式与地址 220 / 状态 195 / 操作 285，表格 `min-w-[1210px]`。**别改回 `table-layout:auto`** —— 自动布局下各列会互相挤（长地址那一行把地址列压到 120px），于是短地址也换行、**每一行都从 49px 涨到 81px**，还会连累其他列。定宽后除地址列外每列内容都靠 `truncate`（+ `title` 悬停看全文）收敛成一行，行高稳定 49px。① 任务列 = `#号 + 提交人(flex-1 truncate) + 时间`，时间用 `shortTime()` 压成 `09/15 12:45`（完整值在 `title`）；② 文件列每个文件是 `min-w-0` 的可收缩块（文件名/设置摘要各自 `truncate`）；③ 状态列的驳回理由/打印错误用 `shorten(text, 8)` + `truncate`；④ 操作列按钮**不能带 `mt-*`**（会把该行按钮推到与同格其他按钮不同高度）。
  - 徽章：`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium`，配色一律「同色 10% 底 + 本色字」
  - 弹窗：遮罩 `fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm`，面板 `w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl dark:bg-ink-soft`
  - 空状态：`flex flex-col items-center gap-3 rounded-2xl border border-dashed border-gray-200 bg-white/60 px-6 py-16 text-center text-sm text-gray-400 dark:border-white/10 dark:bg-white/5`
  - 提示条：`flex items-start gap-2 rounded-xl px-4 py-3 text-sm` + 语义色
- **弹出 / 收起动画**（`src/index.css` 的 `@theme` + `@keyframes`，**进入与退场成对**）：
  进入：`animate-fade-in`（160ms 遮罩淡入）、`animate-pop-in`（180ms 弹窗淡入+轻微上浮缩小）、`animate-sheet-up`（260ms 底部抽屉从下沿滑上来，`cubic-bezier(0.22,1,0.36,1)`）；
  收起：`animate-fade-out`（140ms）、`animate-pop-out`（160ms，下沉+缩回 98%+淡出）、`animate-sheet-down`（220ms 滑回下沿）。
  实现：`Modal` 用 `mounted/closing` 两个 state —— `open` 变 false 后**先留 170ms 播退场**再卸载（退场期间 `pointer-events-none`，免得挡住下一次点击）；队列页手机端详情抽屉同理（`sheetJob` 保留内容 + `sheetClosing`，230ms）。**一律配 `motion-reduce:animate-none`** 尊重系统「减少动态效果」；退场时长常量（`EXIT_MS` / `SHEET_EXIT_MS`）要与 CSS 时长对齐。新增弹层照此配方，不要再写内联 `style` 动画。
- **状态徽章取色**（6 个状态，勿改）：待审核 `bg-amber/15 text-amber-700 dark:text-amber`；已通过 `bg-brand/10 text-brand-dark dark:text-brand`；打印中 `bg-slate-teal/15 text-slate-teal`；已打印 `bg-emerald-500/10 text-emerald-600 dark:text-emerald-400`；已驳回 `bg-clay/10 text-clay`；打印失败 `bg-red-500/10 text-red-600 dark:text-red-400`。
- **站点图标（favicon）**：`frontend/public/` 下三件套 —— `favicon.svg`（现代浏览器）、`favicon.ico`（老浏览器 / Windows 快捷方式）、`apple-touch-icon.png`（iOS 主屏），`index.html` 里各有一行 `<link rel="icon">` + `<meta name="theme-color" content="#4a9d9a">`。图形**与侧栏 logo 完全一致**：品牌绿圆角方块（36×36、rx=12）+ **lucide-react 的 `Printer` 图标**（h-5 w-5、白色 2px 描边、圆头圆角）——路径数据直接抄 `node_modules/lucide-react/dist/esm/icons/printer.mjs`（勿手绘近似版，用户会看出来）。**改图标时的两个坑**：① 圆角方块的判定只能拿点所在的**那一个**角去比距离（拿四个角一起比会把中间区域也判成外部，画出十字）；② lucide 的三条路径光栅化时要**各自独立**成折线，连成一条会在形状之间画出多余对角线。**要改图标就跑 `backend\.venv\Scripts\python.exe frontend/scripts/make_favicon.py`**（纯标准库手写 PNG/ICO，不引 Pillow），产物在 `frontend/public/`，`npm run build` 会自动拷进 `dist/`（后端静态托管，直接访问 `/favicon.svg` 即可验证）。
- **图标**：一律 `lucide-react`（`h-4 w-4` 行内 / `h-5 w-5` 标题与品牌 / `h-[18px] w-[18px]` 侧栏导航）；`components/Icons.tsx` 已废弃删除，不要再 import。
- **管理设置页（`/admin`）是分栏的**：顶部一排二级菜单按钮（`TABS` 常量：打印设置/打印计费/免费白名单/管理员名单/anticraft 绑定/打印代理），每个分栏是一张独立 `CARD`，**增删类（两个名单）即时保存**、表单类（启动器/单价/anticraft 配置）要点「保存设置」。两个名单（`settings.free_users`、`settings.anticraft_admin_users`）是**表格 + 添加/移除**，并用 `/api/users` 交叉核对「本站有没有这个账号」（写错的名字不会生效，表格里标注出来）。
- **用户头像**（2026-09-15）：`users.avatar` 存**文件名**（空 = 首字母占位），文件放 `data/avatars/<user_id>-<毫秒>.<ext>`——换头像就是换文件名，天然免缓存（**响应仍要 `Cache-Control: no-store`**：删了头像后浏览器会拿旧缓存，实测踩过，侧栏一直显示已删的头像）。
  接口：`POST /api/profile/avatar`（png/jpg/gif/webp、≤2MB，**按文件头 magic 判断**是否真图片，换新的会删旧的）、`DELETE /api/profile/avatar`（清列 + 删文件，重复调用不报错）、`GET /api/users/{id}/avatar`（**登录即可看**，文件名形状限定 `<id>-*` 防穿越）。头像在「我的配置」页上传/预览/移除，并显示在侧栏用户卡片；**换/删头像后前端广播 `AVATAR_EVENT`（`api.ts`）**，`App.tsx` 监听到就重拉一次（否则侧栏要刷新页面才变，实测踩过）。接口都要 Bearer，所以前端是 blob → objectURL 渲染。
- **点当前页的导航项 = 重新进入（回到初始状态）**（2026-09-16，用户反馈「提交后从其他界面切到提交打印界面要回到主界面」）：
  `renderNavLink` 的 `onClick` 里比较 `location.pathname === to`，相同就把挂在 `<Routes key={pageNonce}>` 上的
  `pageNonce` +1 —— react-router 对**同一个地址**不会重挂载，不这么做的话「提交成功」卡片（以及第二步、已选文件）
  会一直留着，用户再点侧栏「提交打印」看不出任何变化。切到别的页面再切回来本来就会重挂载（`<Routes>` 按路由卸载），
  这条补的是「原地再点一次」。用例：`node .tmp-test/ui-test-reset-submit.mjs`。
- **深链与刷新**：`App.tsx` 用 `hydrating` 区分「未登录」与「登录态还在水合」（有 token 但 `/api/me` 未返回）——**水合期间 `RequireAuth` 只显示「正在加载…」，不跳登录页**；否则会先跳 `/login`、水合完再命中 `/login` 的「已登录回角色主页」逻辑，把用户要去的页面丢掉（2026-09-15 修过：刷新 `/users`、`/admin`、`/balance` 全被扔到 `/queue`）。
- **外壳**：`App.tsx` 是参考实现——侧栏导航分**两组**：日常入口（提交打印 / 我的任务 / 任务队列）排在上面、设置类（我的配置 / 管理设置 / 用户管理，`bottom: true`）贴在**底部用户卡片上方**，两组共用 `renderNavLink` 的样式与「小屏点完收起抽屉」逻辑；已登录 = 240px 可折叠侧栏（`w-60`↔`w-0`，主区 `ml-60`↔`ml-0` 过渡）+ 吸顶栏（`sticky top-0 bg-warm/80 backdrop-blur-md`，标题取自 `PAGE_META`）+ 右下角 toast；未登录 = 只有品牌条（登录页/回调页）。新页面照此风格写，不要再造导航。
- **移动端适配（2026-09-15 起）**：断点用 Tailwind 默认（`lg` = 1024px）。① 侧栏：`<lg` 是**抽屉**（`fixed w-60` + `-translate-x-full` 收起，默认收起，点汉堡滑出、点遮罩或点导航自动收起）；`lg` 起才是常驻并把主区推到 `lg:ml-60`。**z 层级有硬性顺序：吸顶栏 `z-30` < 抽屉遮罩 `z-40` < 抽屉 `z-50`**（`App.tsx`）。遮罩必须比吸顶栏高，否则顶栏会压在遮罩上、抽屉滑过时顶栏不被压暗，看起来就是「导航栏和侧边栏互相覆盖」（2026-09-15 修过：两者原来都是 `z-30`，同级时 DOM 靠后的顶栏赢）。② 内边距：`px-4 py-3 md:px-8 md:py-4` 一档缩放，副标题 `<sm` 隐藏。③ 预览高度随屏幕：提交页预览 `h-[300px] sm:h-[480px]`，弹窗 `h-[60vh] lg:h-[80vh]`。④ 表格保持 `min-w-*` + 容器 `overflow-x-auto`（页面本身不允许横向滚动），队列页在 `<lg` 提示「左右滑动查看完整表格」；**队列页专门做了移动端裁剪**：`<md` 时表格 `min-w-[920px]`、「文件与设置」列收成 92px 的图标按钮（带文件数）点了弹窗看明细、**点整行弹出「任务详情」底部抽屉**（提交人/提交时间/配送方式与地址/备注/文件与设置，可滚动）——**操作按钮集中在抽屉底部固定条**（44px 高、`flex-1 basis-[45%]` 两列排布、`padding-bottom` 带 `env(safe-area-inset-bottom)`，拇指够得到），行内只留一个「详情 ›」入口（`md:hidden` 的内联操作换成它，桌面端完全不变）；弹窗底部按钮用 `flex-1 sm:flex-none` 撑满整行。抽屉按 `detailId` 从最新 `jobs` 里取数据，所以 15 秒刷新或操作后状态会自动更新；抽屉里的操作执行完自动关闭。⑤ 新增页面的验收要跑 `.tmp-test/ui-test14.mjs`（390×844 视口，检查每页 `documentElement.scrollWidth <= innerWidth`、抽屉行为、两步提交可走通）。
- 复用组件（勿重造）：`Modal`（确认弹窗统一用它，不用 `window.confirm`）、`DropZone`（`previewInline` 时**选完文件把投放区变成预览面板**：内嵌 iframe/img + 切换文件 + 继续添加 + 清空 + 放大查看）、`FileChips`、`TextField`（所有文本输入）、`ThemeToggle`、**`FilePreview`**（预览弹窗：PDF→iframe、图片→img、其它→提示下载；给 `jobId`+`fileId` 由组件带 Bearer 取 blob，或给 `localUrl` 预览本地文件）。预览入口共三处：提交页（拖入即内嵌预览，可放大到弹窗）、我的任务（本人上传件，弹窗）、任务队列（管理员，弹窗）。
- react-router-dom v7，路由集中在 `App.tsx`，页面在 `src/pages/`。
- 管理端预览 PDF 用**同源** blob→iframe（`/api/jobs/{id}/files/{fid}`，需 Bearer 头，所以走 `fetch` + `URL.createObjectURL`，关闭时 `revokeObjectURL`）；跨域源无法内嵌预览。
- UI 文案、注释、文档、提交信息**一律简体中文**；提交信息结构化（单行标题概括整批 + 正文按模块分节）。

## 部署（Windows → 阿里云 47.100.125.150）

- **已部署（2026-09-14）**：代码在 `/var/www/antiprint`（`backend/` + `frontend/dist` + 文档），venv 在 `backend/.venv`，systemd 单元 `antiprint-api`（`WorkingDirectory=/var/www/antiprint/backend`、`ExecStart=.../uvicorn main:app --host 127.0.0.1 --port 8301`、`Environment=SECRET_KEY=<随机 64 位 hex>`）；MySQL 建了独立库 `antiprint` 与专用账号 `antiprint`（口令与 anticraft 的库口令一致，写在 `/var/www/antiprint/backend/db_config.json`，权限 600）；**前端 dist 随包上传，由后端单进程托管**（同 `antiClass`）。
- **线上已含账号中心 / 头像 / 站点图标 / 任务信息页（2026-09-15 部署，提交 `3c6b30f`）**：重启即自动建表补列（`users.avatar` 已在线上生效——`end` 的 profile 能读到 `avatar` 字段）；核对到线上 `cover_page=1`、`print_price=0.1`、`agent_enabled=1`；favicon 三件套 `/favicon.svg`(image/svg+xml)、`/favicon.ico`、`/apple-touch-icon.png` 全部 200；`/api/users/{id}/avatar` 未登录 401。**任务信息页已在生产 LibreOffice 上实测**：`GET /api/agent/jobs/17/cover.pdf`（带代理令牌）返回 45KB 的 `%PDF`，把该 PDF 拉到服务器渲染成 PNG 目视确认——标题「AntiPrint 打印任务信息」与九个字段（含中文文件名「251184Y332-尤天浩-实验二.docx」、取件 / 24 号楼 1016、提交时间 18:05:12、打印时间 22:59:11）**全部正常、无乱码**。
- **工作区里出现了本代理未参与的另一路并行开发 `vprinter/`（虚拟打印机客户端，2026-09-15 21:12~22:56）**：含 `virtual_printer.py`/`vp_*.py`、托盘 GUI、CUPS PPD 与 Windows 安装脚本、`deploy/pack-vprinter.sh`、`.tmp-test/vprinter_test.py` 等（`config.example.json` 里只有占位值，无凭据）。**本次提交与部署未包含它**：`deploy/pack.sh` 只打 `backend frontend/dist README.md AGENTS.md docs`，vprinter 属用户侧客户端，不会上线；要不要把它也提交由用户决定。
- **线上已含计费与本次交互整理（2026-09-15 部署）**：`deploy/pack.sh` 上传后重启即自动建表补列（`users.balance` / `print_jobs.charge` / `balance_logs` 已在线上生效——`/api/balance` 返回 401 而不是 404、`end` 账号读余额成功）；核对到线上 `print_price=0.1`、`free_users` 空、`agent_enabled=1`、代理在线；新版前端 bundle 含「我的余额」。**提交**：`0ae00b7`（账户余额与计费 + 队列移动端交互整理）。
- **线上已含「断开连接 / 重新连接」（2026-09-15 部署）**：`POST /api/settings/agent-link` 无令牌返回 401（新接口已上线）、前端包内含「断开连接」文案、`settings.agent_enabled='1'`（新键由默认值自动补齐）、部署后两台代理心跳正常。**线上观察到两台代理同时注册**（`miemieTB` 与 `print-agent-1`）：领取是原子的、不会重复出纸，但若它们不在同一台机器上，任务可能落到没打印机的那台——注意只保留接打印机的那个代理进程（分发包与仓库各装一次会各有自己的 `agent.lock`，单实例锁拦不住跨目录的重复启动）。
- **服务器已装 LibreOffice（2026-09-15）**：Ubuntu 24.04 + `apt-get install -y --no-install-recommends libreoffice-writer libreoffice-impress` → **LibreOffice 24.2.7.2**，`/usr/bin/soffice → /usr/lib/libreoffice/program/soffice`（`convert.find_soffice()` 的 PATH/候选路径都能命中），网络净增约 400MB。**已在本机生成测试件、scp 到服务器用后端同款命令实跑**：Word→PDF **2.7s**、PPT→PDF **2.6s**、都是 `%PDF`（比 Windows 的 Office COM 路线快一个数量级）。转换时会出现 `failed to launch javaldx` 警告，**属正常**（`--no-install-recommends` 没装 JRE，PDF 导出不需要 Java）。服务器免密 SSH 可用（密钥认证，`root@47.100.125.150`），**不需要、也不允许读取部署脚本里的口令**。
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

1. ~~**Office（docx/xlsx/pptx）如何转 PDF 才能静默打印**——需本机 Office/WPS COM 还是 LibreOffice headless？~~ **已定案（2026-09-15）**：**服务端**转，优先 LibreOffice headless、Windows 无 LibreOffice 时用 Office COM，见「Office 转 PDF」一节；用户明确要求「支持 Word 和 PPT，在预览前先转换成 PDF」。**xlsx（Excel）暂不支持**（用户只提了 Word/PPT；要加只需把 `.xlsx/.xls` 放进 `OFFICE_EXT`，转换器已能处理）。
2. ~~配送地址是否要打印成**封面页/面单**~~ **已定案（2026-09-15）**：打，见「任务信息页」——每单出纸前先打一张，含提交人 / 文件 / 地址 / 提交时间 / 打印时间；`settings.cover_page` 可关。
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
- **Git Bash 调 schtasks 要先 `export MSYS_NO_PATHCONV=1`**，否则 `/Create`、`/Run` 被 MSYS 当路径转换成 `C:/Program Files/Git/Create` 而报错。**同一条规矩适用于 `cmd /c`**（`/c` 被转成路径后 cmd 会当成交互式启动，脚本根本没跑——2026-09-15 调 `stop-vprinter.bat` 时踩过）。
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
6. 重启后端/代理后状态不丢（状态在 MySQL，不在内存）；
7. **计费**：`backend\.venv\Scripts\python.exe .tmp-test/billing_test.py`（35 项）+ `node .tmp-test/ui-test20.mjs`（12 项）全绿；
   动过张数/扣费逻辑后，另跑 `e2e.py` 与 `ui-test13/16/19.mjs` 确认老用例没被 402 拦住（测试账号要先充值）；
8. **代理断开/重连**：`backend\.venv\Scripts\python.exe .tmp-test/agent_link_test.py` + `node .tmp-test/ui-test18.mjs` 全绿；**跑完必须确认 `settings.agent_enabled` 已回到 `1`**（用例收尾会断言，别把本机留在「已断开」——那样后续 e2e 的代理会全 403）；
9. **Office（Word/PPT）**：`backend\.venv\Scripts\python.exe .tmp-test\office_convert_test.py`（34 项）+ `node .tmp-test\ui-test17.mjs`（13 项）全绿；**动过转换链路或换/重装服务器后**，另跑线上冒烟 `PROD_ADMIN_PW=... backend\.venv\Scripts\python.exe .tmp-test\prod_office_check.py`（提交 docx → 预览是 PDF → 删除任务，**不审批所以不会出纸**）。
10. **虚拟打印机**：`backend\.venv\Scripts\python.exe .tmp-test\vprinter_test.py`（163 项；开头等 61 秒腾清登录限速窗口、收尾删掉自己建的测试任务）全绿；
    动过托盘/配置界面还可以跑 `powershell -File .tmp-test\tray_check.ps1`（列通知栏图标与窗口标题）与 `tray_flyout_check.ps1`（点开溢出层找 AntiPrint）；
    **改了 Windows 建队列脚本**则跑 `powershell -ExecutionPolicy Bypass -File vprinter\install\install-printer-windows.ps1 -DryRun`（不改系统）。
11. **虚拟打印机 exe（绿色版）**：`bash deploy/pack-vprinter.sh` 后跑 `backend\.venv\Scripts\python.exe .tmp-test\vprinter_exe_test.py`（56 项）全绿 ——
    它验的是「exe 真的能跑、绿色模式数据就地存、非提权安装给对提示、能提交、托盘图标真出现、配置窗口真起来、zip 内容对」，
    改过打包脚本或冻结/绿色相关代码必跑。**队列的 UAC 安装（真建队列）在本机非管理员会话里测不了**，
    要在管理员机器上点一次「一键安装打印机队列」确认。

12. **API 文档页 / 虚拟打印机页**：`backend\.venv\Scripts\python.exe .tmp-test\api_docs_test.py`（25 项）+
    `node .tmp-test/ui-test-docs-vprinter.mjs`（26 项）全绿 —— 改过 `api_docs.py`（出厂文档正文）、
    `downloads.py`（安装包清单）、`deploy/pack.sh` 的上传步骤，或动过前端这两页/`index.css` 的 `.md-body`
    必跑。UI 用例会**真下载 23MB 的 zip** 并比对字节数，跑之前确认 `dist/AntiPrintVPrinter-*.zip` 在
    （没有包时用例会失败在「下载到 zip」这一条，属预期）。**文档正文改了要同步改 `api_docs.py`**，
    否则线上「恢复默认」会把用户带回旧文档。
