AntiPrint 虚拟打印机（Windows / macOS / Linux）
================================================

在任意程序里按 Ctrl+P（macOS 是 Cmd+P），选中「AntiPrint-1.0.0」这台虚拟打印机，
打印出来的内容会自动变成 PDF 并**提交到 AntiPrint 网站**（和你手动在网页上传文件等价），
之后照常走管理员审核 → 打印代理出纸的流程。右下角（macOS 是菜单栏）有托盘图标，
双击/点菜单可以打开配置界面。

它不会在本机出纸，也不需要像「打印代理」那样有实体打印机 —— 它是给**用户**用的
投稿客户端；实体打印机那一端仍然由「打印代理」负责。


零、不需要装 Python（推荐）
----------------------------

拿到分发包（`AntiPrintVPrinter-<版本>.zip`）解压后，**不需要装 Python 或任何依赖**：

* **Windows**：双击 `AntiPrintVPrinter.exe` 就开始工作（下面「一」里有三步说明）。
* **macOS / Linux**：解压出来带一个 `AntiPrintVPrinter` 可执行文件，先
  `sudo bash install/setup-cups.sh` 装打印队列，再 `bash start-vprinter.sh` 启动。
* 想放桌面图标：配置界面「运行状态」→「创建桌面快捷方式」（首次启动也会问一次），
  以后双击桌面上的图标就能打开界面；也有命令行开关 `AntiPrintVPrinter --create-shortcut`。
* 检查是否正常：`check-vprinter.bat`（mac/Linux 是 `bash check-vprinter.sh`）。
* 不想看长文档就打开 `快速开始.txt`（三步）。

（本机验证过：exe 在「PATH 里没有 python、PYTHONHOME 指向不存在的目录」的环境下照样跑 ——
它是 PyInstaller 单文件包，Python 与所有依赖都在里面；macOS/Linux 的可执行文件同理。）

用源码跑（开发，或想自己改代码）见「一、方式 B」——那才需要 Python。


一、需要准备什么（绿色版：双击 exe 就能用）
------------------------------------------

**方式 A：用打好的单文件 exe（Windows，推荐，不需要装 Python）**

拿到 `AntiPrintVPrinter-<版本>.zip` 后**解压到任意目录**（桌面、U 盘、D 盘都行），
然后**双击 `AntiPrintVPrinter.exe`** —— 就这么简单，没有安装程序：

    AntiPrintVPrinter.exe        双击就开始工作（右下角出现托盘图标）
    AntiPrintVPrinter-data\      程序自动建的数据目录（配置、日志、待提交文件都在这儿）
    install\                     建打印队列的脚本（一般用不到，程序里有「一键安装」）
    start / check / stop-vprinter.bat    启动 / 自检 / 停止（内部直接调用 exe）
    README.txt                   就是本文件

第一次双击会发生两件事：

1. **配置界面自动弹出** —— 填服务器地址（例如 https://print.anticraft.top）、
   账号密码，点「测试连接」；
2. 如果本机还没装虚拟打印机队列，界面上点**「一键安装打印机队列」** → 弹一次
   Windows 管理员授权（UAC）→ 程序自己用管理员身份把队列装好。装完就能在任意程序里
   Ctrl+P 选「AntiPrint-1.0.0」了。

> **以后双击 exe 就等于「打开配置界面」**（哪怕它已经在托盘里跑着也一样）——
> 想改设置直接双击即可，不用先去找托盘图标。开机自启（勾了那个框）不会弹界面，
> 只在后台常驻托盘；如果哪天弹窗说「检测到另一份正在运行」，那是你机器上还留着
> 一份旧的副本，点「是」结束它换成本次这个版本即可。

**绿色体现在哪**：配置、日志、临时文件都在 exe 旁边的 `AntiPrintVPrinter-data\` 里，
不动注册表（除非你自己勾了「开机自动启动」）；不想要了 → 托盘菜单点「卸载虚拟打印机队列」
把系统里的打印机删掉，再把整个文件夹删掉就干净了（整个文件夹拷到别的机器也能直接用，
只有队列需要在新的机器上重装一次）。

> exe 里已经打包了 Python 与全部依赖（requests / pystray / Pillow / tkinter）。
> **双击到界面出现约 1.7 秒**（单文件版每次启动都要把自己解包到临时目录，约 1.4 秒；
> 嫌慢可以换成 onedir 文件夹版，见 AGENTS.md 里的说明）。托盘常驻之后一直是即时的。

**方式 B：用源码跑（macOS / Linux，或想改代码）**

Python 3.9 以上（Windows 装 python.org 版本时记得勾选 "Add python.exe to PATH"），
然后安装依赖：

    pip install -r requirements.txt

* tkinter 是 Python 标准库（配置界面用），Windows/macOS 自带；
  Ubuntu/Debian 若报 No module named tkinter：sudo apt install python3-tk
* 托盘图标来自 pystray + Pillow；Linux 桌面需要常见的那套（X11/AppIndicator）支持，
  没有图形环境时用 `--no-tray` 常驻、不会崩。
* 想自己在 Windows 上打出那个 exe（需要后端 venv，构建用的 PyInstaller 会自动装）：

      bash deploy/pack-vprinter.sh          # 产物：dist/AntiPrintVPrinter-<版本>.zip
      bash deploy/pack-vprinter.sh --skip-build   # 只重新组包（改过 README/bat 时很快）

Windows 用「本仓库的 backend\.venv」或系统 Python 都行；仓库里的 start-vprinter.bat
会按「同目录 AntiPrintVPrinter.exe → 同目录 runtime\ → ..\backend\.venv → PATH」的顺序自己找。
源码方式运行时数据写在 `%USERPROFILE%\.antiprint-vprinter\`（不往仓库目录里写东西）。


二、安装（随时可做，程序会引导）
--------------------------------

**最省事的路子：双击 exe → 弹配置界面 → 点「一键安装打印机队列」（UAC 一次）→ 填账号 → 完成。**
下面这些是给「想自己控制、或要批量装」的人看的。

1) 装虚拟打印机队列（让打印对话框里能看到它）

   程序里点「一键安装打印机队列」即可（等价于下面这条命令）。也可以用管理员身份跑脚本：

   Windows（**必须以管理员身份**打开 PowerShell，右键「以管理员身份运行」）：

       powershell -ExecutionPolicy Bypass -File install\install-printer-windows.ps1

   它做三件事：建落盘目录 C:\ProgramData\AntiPrint\spool（并给 Users 读写权限）、
   建一个指向固定文件的本机端口、用系统自带的「Microsoft Print To PDF」驱动建队列。
   想先看看它准备干什么、又不想改动系统，加 -DryRun（这条不需要管理员）：

       powershell -ExecutionPolicy Bypass -File install\install-printer-windows.ps1 -DryRun

   macOS / Linux：

       sudo bash install/setup-cups.sh

   脚本会把 CUPS 后端装进 backend 目录、建收件目录 /var/spool/antiprint、用 lpadmin
   建一台名叫 AntiPrint-<版本> 的队列（默认 AntiPrint-1.0.0，脚本会自己从程序里读版本号）。卸载：sudo bash install/uninstall-cups.sh [--purge]

2) 启动并填配置

   Windows：双击 start-vprinter.bat（右下角出现托盘图标），点托盘菜单「打开配置界面」。
   macOS / Linux：python3 virtual_printer.py

   **手动启动时配置界面会自己弹出来**（双击 exe / 点快捷方式 / 双击 bat 都算），省得你去找托盘图标；
   开机自启（就是上面说的「开机自动启动」，带 --silent）**不会**弹，免得一开机就糊你一脸窗口。

   配置界面里填：服务器地址（例如 https://print.anticraft.top 或 http://127.0.0.1:8301）、
   登录方式（本站账号 / anticraft 账号）、用户名、密码，然后点「测试连接」确认能登录。
   想开机自动跑，勾选「开机自动启动」（勾上就生效，不用点保存）。

3) 自检 + 试打

   Windows：双击 check-vprinter.bat；macOS / Linux：python3 virtual_printer.py --selftest
   然后随便打印一份文档，选 AntiPrint-1.0.0 —— 几秒后网站上就能看到待审核任务，托盘图标的悬停文字
   会变成「已提交任务 #123：报告.pdf（扣费 0.10 元，余额 0.90 元）」。
   （默认**不弹提示气泡**；想要打印完弹一下，在配置界面右下角或托盘菜单里勾「提交后弹窗提示」。）


三、配置界面各项说明
---------------------

窗口顶部是一排**二级菜单**，点一下切换子界面（当前那个是绿底）：

    [网站账号]  服务器地址、登录方式、用户名密码、测试连接
    [提交选项]  份数、备注、配送方式、配送地址
    [运行状态]  装机按钮（一键安装 / 卸载队列 / 重启后台服务）、队列与守护进程状态、
                点窗口 × 时的行为（每次询问 / 只关界面 / 退出程序）、最近 10 次提交

下面这些是各子界面里的项目：

服务器地址      默认已经是线上站点 https://print.anticraft.top（一般不用改）；结尾的 / 会自己去掉
登录方式        本站账号 = 在 AntiPrint 注册的账号；anticraft 账号 = 用 anticraft.top 的账号
用户名 / 密码   密码只写在本机配置文件里，仅供本用户读取（文件权限 0600）。
                登录成功后令牌会缓存 24 小时，不会每打一次就登录一次（服务端登录有每分钟限速）
份数            本次打印打几份（1~99，按张数计费；网页上提交时的「份数」是同一个意思）
备注            会显示在任务备注里，便于管理员认单
配送方式        「跟随网站默认」= 用网站「我的配置」里的默认值；也可固定成「配送」或「取件」
配送地址        留空 = 用网站上的默认地址；选了「配送」且这里也留空时同样用网站默认地址
提交后弹窗提示  默认**不勾**：提交结果只更新托盘图标颜色与悬停文字（鼠标划过去就能看到）、
               写进日志和界面上的「最近提交」，不弹气泡打扰你。想要弹窗就勾上（钩子也在托盘菜单里）
开机自动启动    勾上立刻生效（Windows 写 HKCU 的 Run 项，不需要管理员）

窗口底部固定一条操作栏（切子界面时不会跑）：保存并应用 / 打开数据目录 / 收件目录 /
失败目录 / 查看日志，右边两个勾选项（开机自动启动、提交后弹窗提示）——
**这两个勾选一勾就存盘**（和「运行状态」页里那几个单选一样），不用再点「保存并应用」；
托盘菜单里这两项也会跟着显示当前值（配置界面改完，托盘里立刻就是新的）。
「保存并应用」管的是上面那些输入框（服务器/账号/份数/备注/配送）。
界面顶部的图标与网站 logo 是同一份图（frontend/public/apple-touch-icon.png），改网站图标时
打包脚本会自动跟着换；整个窗口高度会按屏幕自适应（小屏也不会把按钮顶出屏幕）。
「运行状态」页内容多时可上下滚动（右侧有滚动条，鼠标滚轮也管用）。


四、托盘图标（Windows 右下角）
------------------------------

点一下（或右键）能看到菜单：

    状态：正在监听（服务器 ...）      当前状态/最近一次提交结果
    安装 / 修复虚拟打印机队列          一键装队列（会弹一次 UAC 授权）
    卸载虚拟打印机队列                把系统里的 AntiPrint-<版本> 队列删掉（二次确认）
    打开配置界面                      等于 start-vprinter.bat 之外的那个配置窗口
    打开收件目录 / 已被提交的文件 / 提交失败的文件
    重试失败的文件                    补好余额、改对配置后用它把失败的文件重新提交
    暂停监听                          暂停期间打印出来的文件会留在收件目录，恢复后自动补交
    提交后弹窗提示                    默认关闭（只更新图标与悬停文字）；勾上才弹气泡
    开机自动启动                      和配置界面里的勾选框同步
    打开数据目录 / 打开日志 / 退出

图标颜色：青绿 = 正常；砖红 = 最近一次提交失败或队列还没装（鼠标悬停有文字说明）。
图标就是网站左上角那个 logo（青绿圆角方块 + 白色打印机），窗口图标、exe 图标也是它。
Windows 上图标可能被折叠进「显示隐藏的图标」里，拖出来即可（想让它一直显示：
任务栏设置 → 其他系统托盘图标 → 把 AntiPrint 打开）。

> 用 exe 时，退出请走托盘菜单的「退出」。若在任务管理器里强杀进程，Windows 会先留一个
> 灰色的「幽灵图标」，鼠标划过去或重启就没了。
> **点配置界面右上角的 × 会先问一句**：「只关界面」（后台服务继续监听打印任务，右下角托盘图标
> 还在，下次双击图标就能打开）还是「退出程序」（连后台服务一起停，托盘图标消失）。勾上
> 「记住我的选择」以后就不再问 —— 想改回去：配置界面「运行状态」页 →「点窗口的 × 时」，
> 选「每次询问 / 只关界面 / 退出程序」。
> 托盘菜单的「退出」**总是**连配置界面窗口一起关掉（任务管理器里不留残留，日志里会写
> 「用户选择退出：正在关闭配置界面与后台服务」）。
> 同一台机器上**只允许跑一个**（不管是同一个文件夹还是两个绿色副本）—— 否则两份副本会
> 盯着同一个落盘文件，把同一份打印提交两次（重复扣费）。第二个实例会自己退出并在日志里说明。


五、文件都在哪儿
----------------

**程序产生的东西全部在一个文件夹里**（绿色版就是 exe 旁边那个），随手拷走：

**绿色版（exe）**：`<exe 所在文件夹>\AntiPrintVPrinter-data\`
**源码方式**：`%USERPROFILE%\.antiprint-vprinter\`（macOS/Linux: ~/.antiprint-vprinter/）
**程序旁边写不了时**（比如放在 C:\Program Files）：自动回落到上面这个用户目录 ——
配置界面「运行状态」里会写明当前用的是哪个。

    config.json     配置（含账号密码，权限 0600）
    spool\          打印数据的落盘目录：驱动每打一份就把 PDF 重写到
                    spool\AntiPrint-1.0.0.pdf，程序复制走后再提交
    inbox\          已接手、等待提交的文件（守护进程没跑时会堆在这里）
    sent\           提交成功的 PDF（留档，可随时删）
    failed\         提交失败的 PDF（界面上「重试失败的文件」会重新排队）
    log\vprinter.log  运行日志（轮转，单文件 1MB）
    vprinter.lock   单实例锁（一个程序目录同时只跑一个守护进程）
    cache\          界面图标等缓存

只有**打印队列本身**还在系统里 —— 它是 Windows 的系统对象（注册表 + 假脱机服务管着），
放不进文件夹；但它的**端口指向上面那个 `spool\AntiPrint-1.0.0.pdf`**，所以打印数据也在你的
文件夹里。换机器/换目录后，去配置界面点一次「一键安装打印机队列」把端口指过来即可
（自检和配置界面会提示「端口还指着老位置」；不点的话打印会写进老文件夹、这边收不到）。

    AntiPrint-1.0.0 打印队列   装一次即可，换机器要重装（配置界面/托盘菜单一键）；
                              名字带版本号，升级后旧名字会在下次安装时被自动清掉


六、命令行参数
--------------

用 exe 时把下面的 `python virtual_printer.py` 换成 `AntiPrintVPrinter.exe`（参数完全一样）：

    python virtual_printer.py                  常驻（托盘 + 监听）
    python virtual_printer.py --settings       只打开配置界面
    python virtual_printer.py --selftest       自检（退出码 0 = 关键项通过）
    python virtual_printer.py --status         打印当前状态（JSON）
    python virtual_printer.py --once           处理一轮后退出（调试）
    python virtual_printer.py --simulate 文件  把该文件当成「刚从打印机出来的」走完整流程（验收用）
    python virtual_printer.py --retry-failed   把 failed\ 里的文件放回队列重试
    python virtual_printer.py --no-tray        常驻但不显示托盘图标（无图形环境）
    python virtual_printer.py --install-printer    建/修复打印队列（要管理员；程序里点按钮会自动提权）
    python virtual_printer.py --uninstall-printer  删除打印队列（要管理员）
    python virtual_printer.py --init-config    生成空白配置文件后退出
    python virtual_printer.py -v               输出调试日志

exe 是窗口程序（双击不弹黑窗），但从命令行/批处理里跑 --selftest、--status 时它会
主动挂到那个窗口上，输出照常看得到；如果要把输出接进管道（自动化），设环境变量
`ANTIPRINT_VPRINTER_NO_CONSOLE=1`。


七、常见问题
------------

1) 打印对话框里找不到 AntiPrint-1.0.0
   * Windows：确认队列已建（check-vprinter.bat 的「虚拟打印机队列」一项；或
     `Get-Printer` 看看）。没建就提权重跑 install-printer-windows.ps1。建完可能需要
     重开一次 Word / 浏览器才会刷新打印机列表。
   * macOS/Linux：`lpstat -p AntiPrint-1.0.0` 看队列在不在。如果队列在但打印没反应，
     多半是 CUPS 没找到后端：`lpinfo -v | grep antiprint` 应该能列出来，列不出来就
     重启 CUPS（sudo systemctl restart cups）或看 setup-cups.sh 结尾的提示。

2) 打印了，但网站上没有出现任务
   * 看托盘提示与日志（托盘菜单「打开日志」）。常见原因：
     - 守护进程没跑（托盘图标不在）→ 跑 start-vprinter.bat；
     - 忘了填账号密码 → 配置界面「测试连接」会提示；
     - 余额不足 → 提示会写明「余额不足：本单需 X 元…」，找管理员充值后
       用「重试失败的文件」；
     - 服务器地址填错 / 服务未启动 → 连不上会有明确提示。
   * 收件目录里的文件就是证据：inbox\ 还没处理、sent\ 已提交、failed\ 失败。

3) 连续打印两份，只提交了一份
   Windows 的「本机端口」在驱动里是**一个固定文件**，两份同时排队时后一份会覆盖前一份。
   等托盘弹出「已提交」提示后再打下一份即可（这是文件端口方案的固有限制；
   macOS/Linux 走 CUPS 后端，不受影响）。

4) 上传到网站的文件名是「虚拟打印-20260915-214000.pdf」而不是我的文档名
   Windows 侧拿不到可靠的文档名时就会这样（系统只在打印队列里短暂记录它）。
   macOS/Linux 会直接用打印对话框里的标题，一般是「报告.docx → 报告.pdf」。

5) 提示「打印数据不是 PDF 且转换失败」
   macOS/Linux 的 CUPS 队列是 raw 的，某些程序送的是 PostScript，需要 Ghostscript：
   Ubuntu/Debian: sudo apt install ghostscript；macOS: brew install ghostscript。
   （Windows 用 Microsoft Print To PDF 驱动，输出本来就是 PDF，不会遇到。）

6) 换队列名 / 换落盘目录
   队列名改了要同时改配置里的 printer_name；Windows 的落盘目录改了要重新跑
   install-printer-windows.ps1 -SpoolDir <新目录>（端口与队列都会指向新路径）。
   mac/Linux 改收件目录：在 cups-backend-antiprint 顶部把 ANTIPRINT_SPOOL 默认值改掉后重装，
   或给后端进程设置同名环境变量；同时在配置里把 watch_dirs 填成新目录。

7) 不想让它自己占端口 / 想装到别的机器
   整个 vprinter\ 目录拷过去即可（Windows 只需再跑一次 install-printer-windows.ps1）。
   用 exe 的话把 exe 和 install\ 一起拷过去（exe 要靠 install\ 里的脚本建队列；
   README.txt 也一起带上给使用者看）。

8) 右下角找不到托盘图标了
   * 先点任务栏那个「^」（显示隐藏的图标）——Windows 11 默认把新图标收在里面；
     想让它一直显示：任务栏设置 → 其他系统托盘图标 → 把 AntiPrint 打开。
   * 溢出层里也没有？那是通知区把图标整条丢了（常见于同一身份被反复注册、
     或程序被反复强杀之后）。**双击 exe 打开配置界面 →「运行状态」页 → 点「重启后台服务」**，
     它会结束旧的后台进程再起一个新的，图标就回来了。
   * 配置界面随时可以「双击 exe」打开，所以哪怕图标没了也不会进不去设置。

9) exe / 绿色模式相关
   * 双击之后没反应？正常流程是：托盘图标出现 + 配置界面自动弹出（第一次）。
     若只看到托盘图标没弹窗，说明之前配过账号了，点托盘菜单「打开配置界面」即可。
   * 双击没反应 / 半天才出现图标：单文件 exe 每次启动都要把自己解包（冷启动 5~7 秒），
     等一会儿即可；托盘常驻之后一直是最快的状态。
   * 点「一键安装打印机队列」之后弹了 UAC：那是 Windows 在问「要不要用管理员身份装打印机」，
     点「是」，几秒后托盘会提示装好了。点了「否」也没关系，随时可以再点一次。
   * 数据在哪：默认就在 exe 旁边的 `AntiPrintVPrinter-data\`（绿色模式，拷走文件夹就是拷走配置）。
     如果 exe 放在受保护目录（如 C:\Program Files）导致旁边写不了，会自动改用
     `%USERPROFILE%\.antiprint-vprinter\`；配置界面「运行状态」里会写明当前用的是哪个。
   * 拷到别的机器：整个文件夹拷过去，双击 exe 即可。**打印队列要重新装一次**（它属于系统，
     不跟着文件夹走）—— 托盘菜单点「安装虚拟打印机队列」就行；账号配置是跟着走的。
   * 想彻底卸载：托盘菜单「卸载虚拟打印机队列」→ 删掉那个文件夹 → 完事（注册表只剩你自己
     勾过「开机自动启动」时写的那一项，取消勾选会自动删掉）。
   * SmartScreen 提示「Windows 已保护你的电脑」：自签名/无签名程序的正常提示，
     点「更多信息 → 仍要运行」。想避免就给它签个名（企业代码签名证书）。
   * 杀毒软件误报：PyInstaller 打的包偶尔会被报毒，加入信任即可；介意的话改用源码方式跑。
   * **任务管理器里有两个 AntiPrintVPrinter.exe 进程是正常的**（一个是解包器、一个是程序本身）。
     强杀其中任何一个都可能留下「孤儿」半截进程，托盘图标也还在 —— 想干净地停就用托盘菜单
     「退出」，或双击 stop-vprinter.bat（它按进程名把父子两个一起停）。
   * 开机自动启动用的是 `HKCU\...\Run` 里的 `AntiPrintVPrinter` 项（不需要管理员）；
     绿色模式下**不会**写别的地方。移动了文件夹记得重新勾一次（旧路径会失效）。


八、计费与权限（和网页提交完全一致）
------------------------------------

* 提交时会按打印张数乘以单价扣余额（比如 0.1 元/张，打 3 张扣 0.3 元），管理员/root、anticraft 账号、白名单账号免费；
  驳回、撤回、删除未出纸的任务会自动退费。余额不足时提交会被拒绝并提示，
  文件留在 failed\ 里，充值后「重试失败的文件」即可。
* 提交人取的是你在配置界面填的那个账号 —— 谁打印就算谁提交，任务是「待审核」状态，
  管理员审核通过后才会由打印代理出纸。
* 账号密码保存在本机配置文件（0600），能拿到这台机器上你的用户目录的人就能看到它。
  介意的话：不填密码时无法提交，用完可以清空密码或退出托盘程序。
