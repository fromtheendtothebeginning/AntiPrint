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
| 地址 | `http://47.100.125.150/`（80 端口；`https://47.100.125.150/` 是自签证书，浏览器会提示不受信任） |
| 管理员 | `end`（口令由部署者设定） |
| 默认账号 | 播种的 `admin` 口令已随机化，`admin123` 登录返回 401（不可用） |

### 1.2 新建 / 重置管理员（需要服务器 SSH 权限）

服务器上有一个辅助脚本，用户名与口令从**标准输入**读入，不出现在命令行历史里：

```bash
printf 'someone\n<你的口令>\n' | /var/www/antiprint/backend/.venv/bin/python /root/server_create_admin.py
```

它做的事：账号不存在就创建为管理员；已存在就**重设口令并把角色改为 admin**；顺带检查默认 `admin` 是否仍是 `admin123`，是就改成随机值。脚本文件在仓库里也有备份：`.tmp-test/server_create_admin.py`。

> **目前没有「用户管理」网页界面**，建管理员只能走上面的脚本（或用 `db.create_user` 自行调用）。这是已知待补功能。

### 1.3 管理员登录后能做什么

- **任务队列**：审核（同意 / 驳回，驳回必填理由）、预览上传的文件、打印完成后勾选交接状态。
- **管理设置**：启动器（SumatraPDF / 系统默认程序）、目标打印机、份数、演练模式、anticraft 绑定应用（client_id / client_secret / 允许来源）、代理令牌、重置令牌。
- **我的配置**：默认配送地址、默认配送方式、绑定 / 解绑 anticraft 账号（每个账号各自设置）。

---

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
- 用户在「我的任务」看到同样的状态徽章与提示（待配送=等管理员送达、待取件=到打印点自取、已完成=含完成时间）。

---

## 3. 部署打印代理（**只在那台接打印机的 Windows 上做，一次**）

### 3.1 前提

- Windows 电脑 + 一台**真实**打印机（本项目实测机型：`HP LaserJet Professional P1106`，USB 连接）
- 已安装 SumatraPDF（本项目实测路径：`C:\Users\<你>\AppData\Local\SumatraPDF\SumatraPDF.exe`）
- 已把本项目放到这台电脑上（含 `agent/` 与 `backend/.venv`）

### 3.2 写代理配置 `agent/config.json`

```json
{
  "server": "http://47.100.125.150",
  "agent_token": "在服务器「管理设置 → 代理令牌」复制",
  "name": "print-agent-1",
  "launcher": "sumatra",
  "printer_name": "HP LaserJet Professional P1106",
  "copies": 1,
  "dry_run": false,
  "poll_interval": 5,
  "sumatra_path": "C:\\Users\\86133\\AppData\\Local\\SumatraPDF\\SumatraPDF.exe"
}
```

- `server`：线上填 `http://47.100.125.150`；域名与 HTTPS 就绪后填 `https://print.anticraft.top`。
- `agent_token`：**每套服务各自一份**（本机开发环境与线上不同，换服务器必须换令牌）。
- `printer_name`：必须与 Windows「打印机和扫描仪」里的队列名**逐字一致**；**不要选虚拟队列**（见 §4）。
- 配置会被服务器下发的设置覆盖（启停器/打印机/份数/演练模式以服务器为准）。

### 3.3 安装依赖并注册开机自启

```bat
agent\install-agent.bat      :: 建议「以管理员身份运行」
```

它做三件事：缺 `config.json` 时从模板复制、把依赖装进 `backend\.venv`、注册登录自启任务 `AntiPrintAgent`。
**没有管理员权限时**：注册计划任务会被系统拒绝（`Access is denied`，实测如此），脚本会自动退回普通权限再试一次；仍失败就用启动文件夹替代：

```bat
:: 把启动命令丢进「启动」文件夹（不需要管理员）
echo start "" "D:\anticraft\AntiPrint\backend\.venv\Scripts\pythonw.exe" "D:\anticraft\AntiPrint\agent\print_agent.py" > "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AntiPrintAgent.cmd"
```

### 3.4 启动并自检

```bat
agent\start-agent.bat                                        :: 无窗口启动（pythonw）
backend\.venv\Scripts\python.exe agent\print_agent.py --selftest   :: 自检：配置 / 打印机 / 心跳
backend\.venv\Scripts\python.exe agent\print_agent.py --printers   :: 列出本机打印机队列
backend\.venv\Scripts\python.exe agent\print_agent.py --once       :: 只跑一轮（调试）
agent\stop-agent.bat                                         :: 停止
```

自检通过后，到「管理设置」页看**打印代理在线**，然后走一遍真实出纸（§5）。

### 3.5 只用跑一个代理

代理有单实例锁（`agent/agent.lock`）：第二个进程会打印「检测到已有打印代理在运行」并退出。这是刻意的——同一台打印机重复出纸不可逆。

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
| 外网连不上 8301 | 阿里云安全组只放行了 80/443；后端只监听 `127.0.0.1:8301`，由 nginx 反代对外 |

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
| 更新部署 | 本地 `tar czf` 打包 `backend` + `frontend/dist`（排除 `.venv/data/log/db_config.json`）→ `scp` 到服务器 `/tmp` → 解包覆盖 → `systemctl restart antiprint-api`；前端改了要先 `npm.cmd run build` 再打包 |

---

## 8. 安全提醒

- 线上现在是 **HTTP 明文**（IP 访问）：口令与代理令牌会明文过网。域名 + 证书弄好后尽快切到 HTTPS，并同步更新 `agent/config.json` 的 `server`。
- **代理令牌**等同于「领取任务 / 下载待打印文件 / 回报结果」的钥匙，泄露后请到「管理设置 → 重置令牌」并同步更新每台代理的 `config.json`。
- 默认账号 `admin` 的口令已随机化；如果你要重新启用它，请用 §1.2 的脚本显式设置口令。
- 上传只允许 PDF / 图片（png、jpg），单文件 ≤10MB、单任务 ≤5 个；下载接口需要登录，只有本人或管理员能取。
