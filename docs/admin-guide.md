# AntiPrint 管理员与使用指南

面向**管理员与运维**：怎么配管理员账号、怎么日常审核与交接、怎么在**有打印机的那台电脑**上装打印代理，以及出问题怎么查。
（面向使用者的简介见 `README.md`；面向 AI 代理的契约与坑见 `AGENTS.md`。）

---

## 0. 先理解三个角色

| 角色 | 跑在哪 | 需要打印机吗 | 干什么 |
|---|---|---|---|
| 用户 | 任意浏览器 | 不需要 | 提交打印任务（上传文件 + 选配送方式 + 填地址） |
| **管理员** | 任意浏览器 | **不需要** | 审核任务、勾选交接状态、改系统设置、建管理员账号 |
| 打印代理 | **只在那台接打印机的 Windows 上** | 需要 | 轮询服务器 → 领取已批准的任务 → 静默出纸 → 回报结果 |

要点：**大多数管理员不需要装打印代理**。代理只需要在「那台连着打印机的电脑」上跑**一个**（多跑会被单实例锁拦住，避免重复出纸）。其他人只要能登录后台，就能完成审核与配置。

---

## 1. 管理员账号怎么配

### 1.1 线上现状（2026-09-14）

| 项 | 值 |
|---|---|
| 地址（推荐） | **`https://print.anticraft.top/`**（Let's Encrypt 证书，浏览器绿锁，自动续期） |
| 地址（回退） | `http://47.100.125.150/`（明文）；`https://47.100.125.150/` 是自签证书，浏览器会提示不受信任 |
| 管理员 | `end`（口令由部署者设定） |
| 默认账号 | 播种的 `admin` 口令已随机化，`admin123` 登录返回 401（不可用） |

### 1.2 角色层级与「用户管理」页

| 角色 | 能做什么 |
|---|---|
| `user` 普通用户 | 提交打印、看自己的任务、改自己的默认配置/绑定 anticraft |
| `admin` 管理员 | 上面全部 + 任务队列（审核/驳回/交接勾选）、预览文件、管理设置（打印机/启动器/令牌/anticraft 配置）、用户列表（只读） |
| `root` 超级管理员 | 上面全部 + **用户管理**：把普通用户提拔为管理员 / 收回管理员 |

- 线上 `end` 是 **root**；`end` 那个账号同时也是 anticraft 绑定账号（`source=anticraft`）。
- 提拔操作：登录 root → 侧栏「**用户管理**」→ 目标用户行点「**设为管理员**」（收回同理）。护栏：不能改自己的角色、不能改 root 的角色、接口只能设 `user`/`admin`（**不能通过网页造出新的 root**，root 只能在服务器上设置）。
- 只有 root 能看到「用户管理」入口，其他角色看不到、直接访问也会被重定向。

### 1.3 新建 / 重置管理员（需要服务器 SSH 权限）

服务器上有一个辅助脚本，用户名与口令从**标准输入**读入，不出现在命令行历史里：

```bash
printf 'someone\n<你的口令>\n' | /var/www/antiprint/backend/.venv/bin/python /root/server_create_admin.py
```

它做的事：账号不存在就创建为管理员；已存在就**重设口令并把角色改为 admin**；顺带检查默认 `admin` 是否仍是 `admin123`，是就改成随机值。脚本文件在仓库里也有备份：`.tmp-test/server_create_admin.py`。

> 有了 root 之后，日常提拔管理员用「用户管理」页即可；这个脚本主要用于**第一个**管理员/root、或重置口令（服务器上没有界面能改口令）。

### 1.4 管理员登录后能做什么

- **任务队列**：审核（同意 / 驳回，驳回必填理由）、预览上传的文件、打印完成后勾选交接状态；每行还有 **`重新打印`**（已出纸/已结束的任务再打一份，会把任务打回「已通过」重新入队）与 **`删除`**（二次确认，连上传文件一起删，不可恢复）。
- **管理设置**：启动器（SumatraPDF / 系统默认程序）、目标打印机、份数、演练模式、anticraft 绑定应用（client_id / client_secret / 允许来源）、代理令牌、重置令牌，以及打印代理的**断开连接 / 重新连接**（见 §3.6）。
- **我的配置**：默认配送地址、默认配送方式、绑定 / 解绑 anticraft 账号（每个账号各自设置）。

---

## 1.5 提交页（两步）与打印参数

**第一步：打印文件与设置**
- 拖入或点选文件（支持 PDF / 图片 / Word / PPT，单文件 ≤10MB、最多 5 个；Word/PPT 会先在服务端转成 PDF，见 §9）；
- 下方文件列表里点某一行选中它，右侧就是**这个文件自己的打印设置**（每个文件一套，互不影响）；
- 右侧预览**按设置显示**：填了页面范围（如 `2-3`）预览会跳到该范围起始页；每张纸页数大于 1 时会提示「打印时按 N 页/张排版，预览为单页视图」；
- 底部「下一步：填写配送信息」。

**第二步：配送方式与备注**
- 配送方式（配送 / 取件）、地址（取件时可空）、备注；可「返回修改打印设置」而不丢已填内容；确认后点「提交打印任务」。

可设的打印参数（默认单面 / A4 / 1 页每张 / 适应纸张 / 1 份）：

| 项 | 可选值 |
|---|---|
| 份数 | 1~99（每个文件可不同） |
| 纸张大小 | A4 / A3 / A5 / B5 / Letter / Legal |
| 页面范围 | 形如 `1-3,5`，留空 = 全部 |
| 每张纸页数 | 1 页 / 2 页（左右） / 2 页（上下） / 4 页 / 9 页 / 16 页 |
| 缩放 | 适应纸张 / 实际大小 / 缩小到可打印区域 |

这些设置随任务下发给打印代理（**逐文件**），代理用 SumatraPDF 的 `-print-settings` 应用；「我的任务」与「任务队列」都会显示设置摘要（如「2 份 · A3 · 第 2-3 页 · 每张 4 页 · 适应纸张」）。
说明：目标机型 `HP LaserJet Professional P1106` 是**黑白激光、无自动双面单元**，所以**不提供「双面」「彩色」选项**（2026-09-15 按需求移除；即使调用接口传了这两个字段也会被忽略）。

**手机端**：界面已适配手机（小屏时侧栏收成抽屉，点左上角图标滑出；表格左右滑动查看）。

**预览**：第一步右侧就是内嵌预览（PDF / 图片；Word/PPT 显示的是服务端转好的 PDF）；提交后到「我的任务」点文件名也能预览自己上传的件；管理员在「任务队列」点文件名预览待审文件。

## 2. 日常使用流程（管理员视角）

```
用户提交 → 待审核
   ├─ 管理员「同意」→ 已通过 → 打印代理自动领取 → 打印中 → 已打印
   │                                             └─ 失败 → 打印失败（可「重新入队」）
   └─ 管理员「驳回」（必填理由）→ 已驳回 → 用户改后重提 → 待审核
已打印 →（配送单）勾「待配送」/（取件单）勾「待取件」→ 再勾「已完成」
```

- 交接勾选只在**任务队列**页出现，按任务自带的配送方式决定能勾哪一项：配送单不能勾「待取件」，反之亦然（服务端会拦）。
- 每一步流转都会写进 `print_jobs_logs`（谁、什么时候、从什么状态到什么状态）。
- 用户在「我的任务」看到同样的状态徽章与提示（待配送=等管理员送达、待取件=到打印点自取、已完成=含完成时间）；**出纸前（待审核 / 已通过）可以点「撤回」自己撤单**，撤回后状态变「已撤回」、需要重新提交才能打印（如果代理已经抢单，会提示无法撤回）。

---

## 3. 部署打印代理（**只在那台接打印机的 Windows 上做，一次**）

### 3.0 两种装法，先选一种

| 装法 | 适合 | 怎么做 |
|---|---|---|
| **分发包（推荐给别的机器/别的管理员）** | 目标机器不想装 Python、不想拉整个仓库 | 在开发机跑 `bash deploy/pack-agent.sh` → 得到 `dist/AntiPrintAgent-<版本>.zip` → 整个发给对方；对方解压后依次双击 `install-agent.bat`（按提示填服务器地址、代理令牌、打印机名）→ `check-agent.bat`（自检）→ `start-agent.bat`（启动）。**包内自带 Python 运行环境**，不需另外装 Python；详细说明见包内 `README.txt` |
| 整仓库 | 就是本机（已 clone 仓库、已建好 `backend\.venv`） | 按下面 3.1 ~ 3.5 做 |

两种装法的配置文件、命令行参数完全一样，只是 Python 解释器换成了包内 `runtime\`。
打包脚本会**校验包内没有 `config.json` 与真实代理令牌**，所以分发包可以直接发出去，收包人自己填令牌。

### 3.1 前提

- Windows 电脑 + 一台**真实**打印机（本项目实测机型：`HP LaserJet Professional P1106`，USB 连接）
- 已安装 SumatraPDF（默认装到 `C:\Users\<你>\AppData\Local\SumatraPDF\`；装在别处就往 `config.json` 的 `sumatra_path` 填完整路径，留空＝自动查找）
- 整仓库装法：已把本项目放到这台电脑上（含 `agent/` 与 `backend/.venv`）；分发包装法：只需解压分发包

### 3.2 写代理配置 `agent/config.json`

```json
{
  "server": "http://47.100.125.150",
  "agent_token": "在服务器「管理设置 → 代理令牌」复制",
  "name": "",
  "launcher": "sumatra",
  "printer_name": "default",
  "copies": 1,
  "dry_run": false,
  "poll_interval": 5,
  "sumatra_path": ""
}
```

- `server`：线上填 `http://47.100.125.150`；域名与 HTTPS 就绪后填 `https://print.anticraft.top`。
- `agent_token`：**每套服务各自一份**（本机开发环境与线上不同，换服务器必须换令牌）。
- `name`：留空＝用本机计算机名（多台代理时不要都叫同一个名字）。
- `printer_name`：必须与 Windows「打印机和扫描仪」里的队列名**逐字一致**；`default`＝系统默认打印机；**不要选虚拟队列**（见 §4）。
- `sumatra_path`：留空＝自动查找（配置路径 → `%LOCALAPPDATA%\SumatraPDF` → `Program Files` → `PATH`）。
- 配置会被服务器下发的设置覆盖（启动器/打印机/份数/演练模式以服务器为准）。

### 3.3 安装依赖并注册开机自启

```bat
agent\install-agent.bat      :: 建议「以管理员身份运行」
```

它做三件事：缺 `config.json` 时从模板复制、准备好 Python 与依赖、注册登录自启任务 `AntiPrintAgent`。
脚本会**依次问三个问题**（直接回车＝保留原值）：`server`（服务器地址）、`agent token`（后台「管理设置 → 代理令牌」里复制）、`printer`（打印机队列名，可留空）。
有自带 `runtime\`（分发包）时不再装依赖；整仓库装法是把依赖装进 `backend\.venv`。
**没有管理员权限时**：注册计划任务会被系统拒绝（`Access is denied`，实测如此），脚本会自动退回普通权限再试一次；仍失败就用启动文件夹替代：

```bat
:: 把启动命令丢进「启动」文件夹（不需要管理员）
echo start "" "D:\anticraft\AntiPrint\backend\.venv\Scripts\pythonw.exe" "D:\anticraft\AntiPrint\agent\print_agent.py" > "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AntiPrintAgent.cmd"
```

### 3.4 启动并自检

```bat
agent\check-agent.bat     :: 自检：本机打印机队列 + 配置 + 服务端心跳 + SumatraPDF（排查时先跑它）
agent\start-agent.bat     :: 无窗口启动（pythonw）
agent\stop-agent.bat      :: 停止
agent\print_agent.py --printers   :: 只列本机打印机队列
agent\print_agent.py --once       :: 只跑一轮（调试）
```

带上 `--printers / --selftest / --once` 这些参数，要显式用某个解释器跑：整仓库装法是
`backend\.venv\Scripts\python.exe agent\print_agent.py --selftest`，分发包是 `runtime\python.exe print_agent.py --selftest`。

自检通过后，到「管理设置」页看**打印代理在线**，然后走一遍真实出纸（§5）。

### 3.5 只用跑一个代理

代理有单实例锁（`agent/agent.lock`）：第二个进程会打印「检测到已有打印代理在运行」并退出。这是刻意的——同一台打印机重复出纸不可逆。

### 3.6 临时停掉代理（断开连接 / 重新连接）

「管理设置 → 打印代理」区右上角有 **`断开连接`**（二次确认）。断开后：

- 代理的**注册、心跳、领取任务、下载文件、回报结果**都会被服务器拒绝（服务端日志与代理 `agent/log/agent.log` 里会各留一条记录），**期间不会有任何任务出纸**；已通过的任务只是排队等待，不会被领走。
- 界面上状态会立刻变成「**打印代理已断开**」（不等 90 秒超时），随时点 **`重新连接`** 恢复，代理在下一个心跳（最多 30 秒）内自动继续领任务。
- **代理进程本身不用停**：它是被服务端拒之门外的，「断开」期间照旧轮询，恢复后自己就接上了；想彻底停进程用 `agent\stop-agent.bat`。

什么时候用：换耗材/维修打印机时要防止任务被领走、怀疑代理配置不对想先隔离、或者临时不想出纸但保留队列。

---

## 4. 目标打印机必须选真实队列（最容易翻车的地方）

- 管理设置里的「目标打印机」如果选成 **`Microsoft Print to PDF`** 或 **`OneNote`** 这类虚拟队列，SumatraPDF 的 `-silent` 会卡到 **90 秒超时**，任务最终判「打印失败」（2026-09-14 实测踩过）。
- 正确值是代理上报的真实队列（如 `HP LaserJet Professional P1106`）；下拉选项来自代理上报的本机队列列表，改完记得回读确认。

---

## 5. 验证一次真实出纸

1. 用任意账号在提交页上传一个 PDF（`delivery_mode` 选配送或取件），提交。
2. 管理员在**任务队列**「同意」。
3. 5 秒内代理会领取（状态变「打印中」），随后变「已打印」。
4. **看打印机是否真的吐纸**；没吐纸就查 §6 第一条。
5. 出纸后在任务队列勾「待配送 / 待取件」，再勾「已完成」。

---

## 6. 故障排查（都是实测过的坑）

| 现象 | 原因 / 处理 |
|---|---|
| 任务显示**已打印但没出纸** | 「已打印」= SumatraPDF 正常退出并把任务交给了 Windows 打印后台，**不等于**纸出来了。查队列：`powershell "Get-PrintJob -PrinterName 'HP LaserJet Professional P1106'"`（或「设置 → 打印机 → 打开打印队列」）。实测案例：队列里两条任务 `JobStatus=Normal` 长时间不动 → 打印机电源/USB/纸张问题，唤醒或重插 USB 后队列会自动排空 |
| 任务判「打印失败」，代理日志出现 90 秒超时 | 目标打印机是虚拟队列（§4） |
| 管理页显示**代理离线** | ① 代理是单线程：打印期间（最长 90 秒）不心跳不领任务，属正常；② 代理进程没起来，看 `agent/log/agent.log` 尾部 |
| 代理启动即退出 | 已有实例在跑（`agent.lock`），用 `agent\stop-agent.bat` 停掉旧的 |
| `--selftest` 报连不上服务器 | `config.json` 的 `server` 写错、或服务器没起（`curl <server>/api/health` 应返回 `{"ok":true,"db":"ok"}`） |
| 登录后看不到「任务队列 / 管理设置」 | 该账号角色不是 admin（用 §1.2 的脚本提升） |
| anticraft 登录报「不在绑定白名单内」/「回调地址与登记值不一致」 | 需在 anticraft 后台登记本应用，且回调地址**逐字符**匹配：`<你的访问地址>/api/oauth/anticraft/callback` |
| 浏览器提示证书不受信任 | 现在是 IP + 自签证书（CA 不给纯 IP 签证书）。加好域名解析后跑服务器上的 `/root/finish-antiprint-deploy.sh` 即可签发受信任证书 |
| 外网连不上 8301 | 阿里云安全组只放行了 80/443；后端只监听 `127.0.0.1:8301`，由 nginx 反代对外。用主入口 `https://print.anticraft.top/` |
| 浏览器打不开域名，提示找不到服务器 | 本机/路由器的 DNS 缓存里还留着旧的「无此域名」。公共 DNS（8.8.8.8、223.5.5.5）已能解析；`ipconfig /flushdns`，仍不行就重启路由器，或临时改用 `http://47.100.125.150/` |
| 保存设置后打印突然失败 | 检查「目标打印机」是否被改成了虚拟队列（`Microsoft Print to PDF` / OneNote）：那会让静默打印卡 90 秒超时。管理页选到虚拟队列时会有红色警告 |

---

## 7. 服务器运维速查（给有 SSH 权限的人）

| 项 | 值 |
|---|---|
| 代码目录 | `/var/www/antiprint`（`backend/` + `frontend/dist`） |
| 服务 | `systemctl status\|restart antiprint-api`（开机自启已启用，`SECRET_KEY` 在单元文件里，随机生成） |
| 日志 | `journalctl -u antiprint-api -n 100 --no-pager`；应用日志 `/var/www/antiprint/backend/log/server.log` |
| 数据库 | MySQL 库 `antiprint`，专用账号 `antiprint`（凭据在 `/var/www/antiprint/backend/db_config.json`，权限 600） |
| nginx | `/etc/nginx/sites-available/antiprint`（软链到 `sites-enabled`），反代到 `127.0.0.1:8301` |
| 辅助脚本 | `/root/server_create_admin.py`（建管理员）、`/root/finish-antiprint-deploy.sh`（写线上设置 + 启用 nginx + 申请证书，幂等） |
| 更新部署 | 在仓库根目录（Git Bash）跑 **`bash deploy/pack.sh`**：按正确排除清单打包 → 上传 → 解包 → 重启 → 自测；前端改了要先 `npm.cmd run build`。只想看包内容用 `bash deploy/pack.sh --dry-run`（脚本会拒绝包含 `db_config.json`/`data` 的包） |
| ⚠️ 部署踩坑（实测） | 打包漏排除 `db_config.json` 会把**线上的库凭据覆盖成本机凭据**，服务立刻连不上库（健康检查变 `db:error`）。恢复：在服务器上按 §7「数据库」重写 `db_config.json`（用 anticraft 那份库口令）并 `chmod 600`，再重启服务 |

---

## 8. 安全提醒

- 线上现在是 **HTTP 明文**（IP 访问）：口令与代理令牌会明文过网。域名 + 证书弄好后尽快切到 HTTPS，并同步更新 `agent/config.json` 的 `server`。
- **代理令牌**等同于「领取任务 / 下载待打印文件 / 回报结果」的钥匙，泄露后请到「管理设置 → 重置令牌」并同步更新每台代理的 `config.json`。
- 默认账号 `admin` 的口令已随机化；如果你要重新启用它，请用 §1.2 的脚本显式设置口令。
- 上传允许 PDF / 图片（png、jpg）/ Word / PPT（docx、doc、pptx、ppt），单文件 ≤10MB、单任务 ≤5 个；含宏的 docm/pptm 等危险类型一律拒绝；下载接口需要登录，只有本人或管理员能取。

---

## 9. Word / PPT 转 PDF（2026-09-15 新增）

用户上传的 **Word / PPT 会在服务器端先转成 PDF**：提交页右侧预览、管理员预览、打印代理出纸用的都是转换后的 PDF（代理拿到的永远只有 PDF，不需要在打印那台机器上再转换）。

- **线上服务器必须装 LibreOffice**（没有它 Word/PPT 会转不了，提交会明确报错）：
  ```bash
  apt-get update && apt-get install -y --no-install-recommends libreoffice-writer libreoffice-impress
  # 装完重启后端：systemctl restart antiprint-api
  soffice --version     # 能看到版本即成功
  ```
- 装在非默认路径时，给服务加环境变量即可：`SOFFICE_PATH=/opt/libreoffice/program/soffice`（写在 systemd 单元的 `Environment=` 里）。
- **Windows 机器（本机开发/验收）**：装 Microsoft Office 就够（走 Office 自动化导出 PDF），也可以用 `winget install TheDocumentFoundation.LibreOffice` 装 LibreOffice —— 两者都有时**优先用 LibreOffice**。
- 转换结果是按文件内容（sha256）缓存的：同一份文件重复提交只转一次；删除任务时若没有别的任务还在用同一份文件，缓存会一并清理（`backend/data/converted/`）。
- 耗时参考：本机 Word 约 6 秒、PPT 约 23 秒（页面提交时会转圈等待，属正常；提交页选文件后的预览也会等几秒）。
- **排查**：`"文件 xxx 转换失败"` 说明转换器装没装好或文件本身有问题（加密文档、损坏、纯改名的假 docx 都会失败）——先看 `backend/log/server.log` 里 `antiprint.convert` 的日志。
