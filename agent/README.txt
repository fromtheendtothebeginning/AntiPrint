AntiPrint 打印代理 · 安装说明
======================================================================

这个程序干什么
  常驻在那台【连着打印机】的 Windows 电脑上：轮询服务器 → 领取审核通过的任务 →
  下载文件 → 让打印机静默出纸 → 回报结果。审核、交接仍在网页后台做。

  只有「有打印机的那台机器」需要装它，一台机器装一个就够。其他管理员用浏览器登录
  后台就能审核，不用装这个。

运行前提
  1. Windows 电脑，打印机驱动已装好（「设置 → 蓝牙和其他设备 → 打印机和扫描仪」里
     能看到队列名）。
  2. 装一个免费的 SumatraPDF（静默打印靠它，必须装）：
     https://www.sumatrapdfreader.org/download-free-pdf-viewer
     默认安装位置即可；装在别处也行，见下面「打印机/SumatraPDF 找不到」。
  3. 不需要装 Python —— 压缩包里的 runtime\ 就是自带的 Python 运行环境（含 requests）。

安装（三步）
  1. 把整个文件夹解压到任意目录，例如 D:\AntiPrintAgent
     （路径里不要有中文和特殊符号，避免个别环节踩坑）

  2. 双击 install-agent.bat，它会依次问三件事（直接回车＝保留原值）：
        server      : 服务器地址，例如 https://print.anticraft.top 或 http://47.100.125.150
        agent token : 代理令牌 —— 用管理员账号登录后台，在「管理设置」页的
                      「代理令牌」处复制
        printer     : 打印机队列名（写法要和 Windows 里显示的完全一致）；
                      直接回车＝保持原值，填 default＝用系统默认打印机
     这一步会写入 config.json，并注册开机自启（登录后自动启动代理）：优先用计划任务
     AntiPrintAgent；没有管理员权限时脚本会**自动退回「启动」文件夹**，两种方式都会在
     屏幕上报出实际用了哪个，不需要你手动做别的。

  3. 双击 check-agent.bat 自检。看到下面三行就说明通了：
        自检 2/4 打印机枚举：OK（…）
        自检 3/4 服务端心跳：OK（…）
        自检 4/4 SumatraPDF：OK（…）
     然后双击 start-agent.bat 启动代理（无窗口，后台运行）。

怎么确认真的能打印
  1. 后台「管理设置」页应显示【打印代理在线】（离线时先看 §常见问题 3）。
  2. 让同事提交一个 PDF → 你在「任务队列」点同意 → 几秒内任务变成「打印中」→「已打印」，
     同时打印机真的吐纸。
  3. 注意：「已打印」只代表 SumatraPDF 正常退出、任务交给了 Windows 打印后台，
     **不等同于纸已经出来**；没吐纸请看 §常见问题 1。

日常命令
  check-agent.bat   自检：本机打印机队列 + 连服务器 + 查 SumatraPDF（排查问题时把这个
                    窗口的内容发出来即可）
  start-agent.bat   后台启动（开机自启已由 install-agent.bat 注册）
  stop-agent.bat    停止所有打印代理进程
  手动跑一轮调试：
      runtime\python.exe print_agent.py --once      只跑一轮：心跳 → 领取 → 打印 → 回报
      runtime\python.exe print_agent.py --dry-run   只打印将要执行的命令，不出纸
      runtime\python.exe print_agent.py --printers  只列出本机打印机队列

文件说明
  print_agent.py      代理主程序
  config.json         本机配置（server / agent_token 必须正确）
  config.example.json 配置模板；config.json 填坏了可以复制它重来
  runtime\            自带 Python 运行环境（含 requests），删掉就没法运行
  install-agent.bat   安装 / 改配置 / 重新注册自启
  start-agent.bat     启动      stop-agent.bat   停止      check-agent.bat  自检
  log\agent.log       运行日志（超过 1MB 自动轮转，最多留 4 份）
  tmp\                下载的待打印文件（不会自动清理，可定期删）

常见问题
  1. 任务显示「已打印」但没出纸
     「已打印」= SumatraPDF 正常退出并把任务交给了 Windows 打印后台。查真实队列：
       powershell "Get-PrintJob -PrinterName 'HP LaserJet Professional P1106'"
     队列里有任务长时间不动，一般是打印机电源/USB/缺纸问题，唤醒或重插 USB 后会自动排空。

  2. 任务判「打印失败」，日志里出现 90 秒超时
     服务器上的「目标打印机」被设成了虚拟队列（Microsoft Print to PDF / OneNote 之类），
     静默打印会一直等保存文件对话框。让 root 在「管理设置 → 目标打印机」里选真实队列。

  3. 后台显示「打印代理离线」
     代理是单线程的：打印期间（最长 90 秒）不心跳也不领任务，属正常现象。
     一直离线就看 log\agent.log 结尾，或跑 check-agent.bat。

  4. 双击 start-agent.bat 后没有任何反应 / 日志说「检测到已有打印代理在运行」
     本机已经有一个代理在跑了（单实例锁，防止同一台打印机重复出纸）。
     先 stop-agent.bat，再 start-agent.bat。

  5. 自检报「服务端心跳：失败」
     地址写错（server）、令牌不对（agent_token），或服务器没开。浏览器打开
     <server>/api/health 应返回 {"ok":true,"db":"ok"}。

  6. 自检报「SumatraPDF：未找到」
     没装 SumatraPDF，或装在了非常规位置。装好后重试；装在别处就把完整路径填进
     config.json 的 sumatra_path（例如 "D:\\tools\\SumatraPDF\\SumatraPDF.exe"）。

  7. 打印机队列名不知道填什么
     跑 check-agent.bat，第一段「local printer queues」列出的就是本机所有队列名。
     也可以先不填（回车），由服务器上的「目标打印机」统一决定。

注意：服务器上的「目标打印机 / 启动器 / 份数 / 演练模式」是**全局设置**，每次心跳都会
     下发给所有代理，会覆盖本机的同名配置。所以多台代理连着不同型号打印机时，打印机
     这一项需要 root 在「管理设置」里统一切换。

卸载
  1. stop-agent.bat
  2. 取消开机自启：删除计划任务 schtasks /Delete /TN AntiPrintAgent /F；
     若安装时用的是启动文件夹，删掉
     %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AntiPrintAgent.cmd
  3. 删除本文件夹即可（config.json 里的令牌随之作废；如需彻底失效，
     到后台「管理设置 → 重置令牌」，但注意会影响其它代理）
