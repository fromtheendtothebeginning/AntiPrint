#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""AntiPrint 虚拟打印机（Windows / macOS / Linux）。

在 Word、浏览器、看图软件里按 Ctrl+P，选「ANTIPRINT」这台虚拟打印机，
打印出来的内容会被转成 PDF 并**自动提交到 AntiPrint 网站**（等同于在网站上手动上传），
后台等管理员审核后由本机打印代理出纸。右下角有托盘图标，双击可打开配置界面。

用法示例：
    python virtual_printer.py                常驻运行（托盘图标 + 监听打印任务）
    python virtual_printer.py --settings     只打开配置界面
    python virtual_printer.py --selftest     自检：配置 / 服务器登录 / 收件目录 / 队列 / 自启动
    python virtual_printer.py --once         处理当前积压后退出（调试）
    python virtual_printer.py --simulate a.pdf   把 a.pdf 当成「刚从打印机出来的」走完整流程
    python virtual_printer.py --retry-failed 把之前失败的文件放回队列重试
    python virtual_printer.py --status       打印当前状态（JSON）
    python virtual_printer.py --no-tray      常驻但不显示托盘图标（无图形环境时用）

注意事项（本项目已知坑）：
    1. pythonw.exe 下 sys.stdout / sys.stderr 为 None，任何 print 前必须判空（见 say）。
    2. 子进程（PowerShell、转换器）都要带 CREATE_NO_WINDOW，否则反复闪黑窗。
    3. 单实例运行：两个守护进程同时抢同一个落盘文件会把同一份文档提交两次。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

if not getattr(sys, "frozen", False):        # 打包成 exe 后模块都在包里，不需要这一行
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from vp_api import ApiError, Client                                    # noqa: E402
from vp_config import (                                                # noqa: E402
    CONFIG_PATH,
    DATA_MODE,
    FAILED_DIR,
    INBOX_DIR,
    LOCK_FILE,
    LOG,
    SENT_DIR,
    VERSION,
    ensure_dirs,
    load_config,
    load_recent,
    save_config,
    setup_logging,
    truthy,
    watch_targets,
)
import vp_printer                                                      # noqa: E402
from vp_pipeline import Pipeline, retry_failed, simulate                # noqa: E402
from vp_platform import (                                              # noqa: E402
    CREATE_NO_WINDOW,
    IS_FROZEN,
    SingleInstance,
    app_dir,
    autostart_enabled,
    daemon_running,
    launch_argv,
    platform_label,
    other_instances,
    create_desktop_shortcut,
    queue_detail,
    queue_exists,
    shortcut_exists,
    spawn_settings_window,
    spool_mismatch,
    stop_other_instances,
)

CONFIG_WATCH_INTERVAL = 2.0


def attach_console() -> None:
    """打包成窗口程序（--windowed）后，命令行里跑 --selftest / --status 看不到任何输出 ——
    这里主动挂到调用方的控制台，这样 check-vprinter.bat 里才有字；从资源管理器双击时
    没有父控制台，这一步会失败，也就不会冒出黑窗（保持窗口程序的样子）。"""
    if not IS_FROZEN or os.name != "nt":
        return
    try:
        import ctypes

        if ctypes.windll.kernel32.AttachConsole(-1):        # ATTACH_PARENT_PROCESS
            sys.stdout = open("CONOUT$", "w", encoding="utf-8", buffering=1)
            sys.stderr = open("CONOUT$", "w", encoding="utf-8", buffering=1)
    except (OSError, AttributeError, ImportError):
        pass


def say(text: str = "") -> None:
    """控制台输出：pythonw / 无控制台时退化成写日志"""
    if sys.stdout is not None:
        try:
            print(text, flush=True)
            return
        except (OSError, ValueError):
            pass    # 控制台已经关了（比如 start-vprinter.bat 的窗口被关掉）
    LOG.info(text)


# ---------------------------------------------------------------- 自检

def manage_printer(cfg: dict, install: bool) -> int:
    """--install-printer / --uninstall-printer：这两个模式由提权后的自己跑（UAC 之后），
    也可能被运维直接从管理员命令行里调。结果既写日志也弹窗（窗口程序没有控制台可看）。"""
    printer = str(cfg.get("printer_name") or "")
    if install:
        ok, message = vp_printer.install(printer)
    else:
        ok, message = vp_printer.uninstall(printer)
    say(("[OK] " if ok else "[FAIL] ") + message)
    if sys.stdout is None:
        # 窗口程序（exe / pythonw）：没有控制台，只能用弹窗把结果告诉用户
        vp_printer.info_box("AntiPrint 虚拟打印机", message)
    return 0 if ok else 1


def selftest(cfg: dict) -> int:
    """逐项检查并打印结果；返回退出码（0 = 关键项全通过）"""
    checks: list[tuple[str, bool, bool, str]] = []      # (项目, 关键?, 通过?, 说明)

    printer = str(cfg.get("printer_name") or "")
    configured = bool(cfg.get("server")) and bool(cfg.get("username")) and bool(cfg.get("password"))
    checks.append((
        "配置", True,
        bool(cfg.get("server")),
        f"{CONFIG_PATH}（{DATA_MODE}；服务器 {cfg.get('server') or '未填'}，账号 {cfg.get('username') or '未填'}）",
    ))
    if not configured:
        checks.append(("账号", False, False, "还没填写用户名/密码，配置界面里填好再打印"))

    balance_text = ""
    try:
        client = Client(cfg)
        client.health()
        token = client.token()
        info = client.balance(token)
        if info.get("billable"):
            balance_text = f"余额 {info.get('balance')} 元，单价 {info.get('price')} 元/张"
        else:
            balance_text = f"余额 {info.get('balance')} 元，免费账号（{info.get('free_reason')}）"
        checks.append(("服务器登录", True, True, f"{cfg.get('server')} → {balance_text}"))
    except ApiError as exc:
        checks.append(("服务器登录", True, False, exc.message))
    except Exception as exc:
        checks.append(("服务器登录", True, False, str(exc)))

    installed = queue_exists(printer)
    detail = queue_detail(printer)

    problems = []
    for directory in watch_targets(cfg):
        if directory.is_dir():
            if not os.access(directory, os.R_OK):
                problems.append(f"{directory} 不可读")
        elif directory.suffix:                       # Windows 的落盘文件
            if not directory.parent.exists():
                problems.append(f"落盘目录 {directory.parent} 不存在（装队列的脚本会建）")
        else:
            problems.append(f"{directory} 不存在")
    checks.append((
        "收件目录", installed, not problems,
        "；".join(problems) or "；".join(str(p) for p in watch_targets(cfg)),
    ))

    mismatch = spool_mismatch(printer)
    if installed and mismatch:
        checks.append((
            "落盘文件", True, False,
            f"队列的端口还指着 {mismatch}，不是本程序目录 —— 打印会写进那个老文件夹、这边收不到。"
            "在配置界面点「一键安装打印机队列」把它指过来",
        ))
    checks.append((
        "虚拟打印机队列", False, installed,
        f"{printer} 已安装（{detail}）" if installed else
        f"{printer} 未安装：Windows 用 {app_dir()}\\install\\install-printer-windows.ps1（管理员），"
        f"macOS/Linux 用 {app_dir()}/install/setup-cups.sh（详见 README.txt）",
    ))

    autostart = autostart_enabled()
    checks.append(("开机自启动", False, autostart, "已开启" if autostart else "未开启（配置界面里勾选即可）"))

    try:
        from vp_tray import TRAY_AVAILABLE
        tray_ok = TRAY_AVAILABLE
    except Exception:
        tray_ok = False
    checks.append(("托盘图标", False, tray_ok, "可用" if tray_ok else "不可用：pip install pystray Pillow"))

    say(f"AntiPrint 虚拟打印机 v{VERSION} 自检（{platform_label()}，"
        f"{'exe' if IS_FROZEN else 'Python 源码'} 形态，程序目录 {app_dir()}）")
    say("─" * 68)
    failed_critical = False
    for name, critical, ok, message in checks:
        mark = "OK  " if ok else ("FAIL" if critical else "WARN")
        if not ok and critical:
            failed_critical = True
        say(f"[{mark}] {name}：{message}")
    say("─" * 68)
    if failed_critical:
        say("关键项有问题，请先按上面的提示处理。")
    else:
        say("关键项全部通过。" if installed else "打印机能用（落盘链路已就绪），但打印队列还没装 —— 装好才能在打印对话框里看到它。")
    return 1 if failed_critical else 0


def _icon_report() -> str:
    """图标用的是哪一份（诊断用）：网站 logo 还是兜底画的"""
    try:
        from vp_tray import logo_source

        source = logo_source()
        return str(source) if source else "兜底图标（没找到网站 logo）"
    except Exception as exc:
        return f"图标不可用：{exc}"


def status(cfg: dict) -> int:
    """给脚本/运维看的当前状态（JSON）"""
    printer = str(cfg.get("printer_name") or "")
    data = {
        "version": VERSION,
        "平台": platform_label(),
        "运行形态": "exe" if IS_FROZEN else "python",
        "程序目录": str(app_dir()),
        "数据目录": str(CONFIG_PATH.parent),
        "数据模式": DATA_MODE,
        "实例锁": str(LOCK_FILE),
        "图标": _icon_report(),
        "守护进程": daemon_running(),
        "已暂停": bool(cfg.get("paused")),
        "服务器": cfg.get("server"),
        "账号": cfg.get("username"),
        "登录方式": cfg.get("auth_mode"),
        "队列": {"名称": printer, "已安装": queue_exists(printer), "驱动端口": queue_detail(printer)},
        "开机自启动": autostart_enabled(),
        "监听目标": [str(p) for p in watch_targets(cfg)],
        "待处理": len(list(INBOX_DIR.glob("*"))) if INBOX_DIR.is_dir() else 0,
        "已提交": len(list(SENT_DIR.glob("*"))) if SENT_DIR.is_dir() else 0,
        "失败": len(list(FAILED_DIR.glob("*"))) if FAILED_DIR.is_dir() else 0,
        "最近": load_recent()[:5],
    }
    say(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


# ---------------------------------------------------------------- 常驻

def watch_config(stop: threading.Event, pipeline: Pipeline) -> None:
    """配置文件被配置界面改了就热加载，不用重启守护进程"""
    last = CONFIG_PATH.stat().st_mtime if CONFIG_PATH.exists() else 0.0
    while not stop.wait(CONFIG_WATCH_INTERVAL):
        try:
            current = CONFIG_PATH.stat().st_mtime
        except OSError:
            continue
        if current != last:
            last = current
            cfg = load_config()
            pipeline.update_config(cfg)
            LOG.info("配置已热更新：服务器 %s，账号 %s，监听 %s",
                     cfg.get("server"), cfg.get("username"), [str(p) for p in watch_targets(cfg)])


def open_settings_window() -> None:
    """另起一个进程开配置界面（关窗口不影响守护进程；macOS 上也不跟托盘抢主线程）"""
    try:
        spawn_settings_window()
    except OSError as exc:
        LOG.warning("打不开配置界面：%s", exc)


def needs_first_run_guide(cfg: dict) -> bool:
    """要不要弹首次使用引导（单独拿出来是为了能测，不用真去开窗口）"""
    unconfigured = not (cfg.get("username") and cfg.get("password"))
    no_queue = os.name == "nt" and not queue_exists(str(cfg.get("printer_name") or ""))
    return bool(unconfigured or (no_queue and not cfg.get("queue_warned")))


def wants_settings_window(silent: bool, has_tray: bool) -> bool:
    """手动启动（双击 exe / 点快捷方式 / start-vprinter.bat）要不要顺手把配置界面打开。

    用户的说法：「如果不是自启动打开的软件，打开软件后打开配置界面」——双击的人总得看见点什么，
    而不是只在右下角多一个图标（Win11 还会把它收进溢出区）。
    开机自启走的是 `--silent`，自动化/无界面场景设 `ANTIPRINT_VPRINTER_NO_GUI=1`，两者都不弹。"""
    return bool(has_tray and not silent and not truthy(os.environ.get("ANTIPRINT_VPRINTER_NO_GUI")))


def first_run_guide(cfg: dict, silent: bool = False) -> bool:
    """绿色版首次使用引导：双击 exe 之后总得让人知道该干什么 ——

    ① 没配账号 → 直接把配置界面打开；
    ② 队列没装 → 也打开配置界面（里面有「一键安装打印机队列」按钮，会弹 UAC），只提示一次。
    返回是否真的开了配置界面（调用方据此决定还要不要补开一个）。"""
    if silent or truthy(os.environ.get("ANTIPRINT_VPRINTER_NO_GUI")):
        return False
    if not needs_first_run_guide(cfg):
        return False
    if windowless() and IS_FROZEN and not cfg.get("shortcut_asked") and not shortcut_exists():
        # 没装 Python 的用户最容易卡在「去哪找这个程序」——顺手问一句要不要放桌面快捷方式（只问一次）
        if vp_printer.ask_yes_no(
            "AntiPrint 虚拟打印机",
            "要在桌面上放一个「AntiPrint 虚拟打印机」快捷方式吗？\n\n"
            "以后双击桌面上的它就能打开配置界面，不用每次去翻解压出来的文件夹。\n"
            "（不想要就点「否」，以后也可以在配置界面「运行状态」里再创建）",
        ):
            ok, message = create_desktop_shortcut()
            LOG.info("创建桌面快捷方式：%s（%s）", ok, message)
        cfg["shortcut_asked"] = True
        save_config(cfg)
    LOG.info("首次使用引导：打开配置界面")
    open_settings_window()
    if not cfg.get("username") and not cfg.get("password"):
        return True                  # 还没配账号：下次启动继续引导，直到填好
    if not queue_exists(str(cfg.get("printer_name") or "")):
        cfg["queue_warned"] = True   # 队列提示只弹一次，别每次都来
        save_config(cfg)
    return True


ALREADY_RUNNING_TEXT = (
    "检测到**另一份** AntiPrint 虚拟打印机正在运行（多半是旧版本或另一个副本）\n"
    "%s\n\n"
    "要结束它、换成本次这个版本吗？\n"
    "（点「是」＝ 停掉旧的那份并由本次启动接管；账号配置、待提交的文件都不会丢）"
)


def windowless() -> bool:
    """是不是「窗口程序、没人能看输出」的形态（双击 exe / pythonw）：
    这种时候任何只写日志的退出路径都等于「用户看不见」，必须弹窗或干脆把界面开出来。"""
    return sys.stdout is None


def handle_already_running(lock, silent: bool) -> bool:
    """已经有实例在跑时怎么办。返回 True = 已接管、可以继续启动。

    三种情况分开处理（2026-09-16 用户实际踩过：以前一律弹「要不要接管」，他每次双击
    都点「是」→ 把自己刚起的那份杀掉重启 → 又看到同一个窗口，像卡住一样）：
      ① 有控制台 / --silent（命令行、自动化、开机自启）→ 只打印一句，不弹窗、不接管；
      ② **同一份程序又点了一次**（双击桌面图标）→ 他想要的是「打开界面」：直接把配置界面开出来，不弹窗；
      ③ **另一份副本还在跑**（升级场景）→ 才弹窗问要不要接管。
    """
    others = other_instances()
    same_copy = all(_same_program(item.get("path", "")) for item in others) if others else True
    if not windowless() or silent:
        say("已经有一个虚拟打印机守护进程在跑了（托盘图标应该已经在右下角）。这里直接退出。")
        if not silent:
            say("要换成现在这个版本，先从托盘菜单退出旧的那份，或双击 stop-vprinter.bat。")
        return False
    if same_copy:
        LOG.info("同一份程序已经在跑（托盘里那个图标就是它）；这次双击按「打开配置界面」处理")
        open_settings_window()
        return False
    LOG.info("检测到另一份副本在跑：%s", "; ".join(f"{i['pid']} {i['path']}" for i in others))
    if not vp_printer.ask_yes_no("AntiPrint 虚拟打印机",
                                 ALREADY_RUNNING_TEXT % "\n".join(f"· {i['path']}" for i in others)):
        return False
    LOG.info("用户选择接管：结束其它实例后重试单实例锁")
    stopped = stop_other_instances()
    LOG.info("已结束 %s 个旧实例进程", stopped)
    for _ in range(20):                        # 等操作系统的文件锁释放（一般几十毫秒）
        time.sleep(0.3)
        if lock.acquire():
            open_settings_window()             # 双击来的，接管完顺便把界面开出来
            return True
    vp_printer.info_box("AntiPrint 虚拟打印机",
                        "旧的那份没能停干净，本次启动先退出。\n"
                        "可以在任务管理器里结束 AntiPrintVPrinter.exe，或双击 stop-vprinter.bat 后再试。")
    return False


def _same_program(path: str) -> bool:
    """运行中的实例是不是「就是本程序这一份」（路径相同 → 用户只是又点了一次图标）"""
    if not path:
        return True
    mine = Path(sys.executable if IS_FROZEN else __file__).resolve()
    try:
        return Path(path).resolve() == mine
    except OSError:
        return False


def run_daemon(cfg: dict, use_tray: bool, silent: bool = False) -> int:
    ensure_dirs()
    lock = SingleInstance(LOCK_FILE)
    if not lock.acquire() and not handle_already_running(lock, silent):
        return 1
    stop = threading.Event()
    tray = None
    if use_tray:
        try:
            from vp_tray import Tray

            tray = Tray(None, stop)
        except Exception as exc:                     # 缺 pystray / 没有图形环境
            LOG.warning("托盘不可用，改为无界面常驻：%s", exc)

    pipeline = Pipeline(cfg, notify=(tray.notify if tray else lambda kind, text: LOG.info("[%s] %s", kind, text)))
    if tray:
        tray.pipeline = pipeline

    worker = threading.Thread(target=pipeline.run_forever, args=(stop,), name="vp-pipeline", daemon=True)
    worker.start()
    watcher = threading.Thread(target=watch_config, args=(stop, pipeline), name="vp-config", daemon=True)
    watcher.start()

    # 启动时先做一次温和的提示，让用户知道它在哪儿
    if tray:
        printer = str(cfg.get("printer_name") or "")
        if not queue_exists(printer):
            tray.set_state("error", "虚拟打印机队列还没安装：右键图标 →「安装虚拟打印机队列」")
        elif spool_mismatch(printer):
            # 端口是程序按自己所在目录算出来的绝对路径：换过目录/换过版本后要对齐，
            # 不然 PDF 会写进老文件夹、这边收不到（打印看起来「没反应」）
            tray.set_state("error", "队列端口还指着老位置：进「运行状态」页点「一键安装打印机队列」")
        else:
            tray.set_state("ok", f"正在监听（服务器 {cfg.get('server')}）")

    guided = first_run_guide(cfg, silent)   # 绿色版：没配账号/没装队列就把配置界面打开，别让人对着托盘发呆
    if not guided and wants_settings_window(silent, tray is not None):
        # 手动打开软件（不是开机自启）：把配置界面亮出来，双击的人总得看见点什么
        LOG.info("手动启动：打开配置界面")
        open_settings_window()

    try:
        if tray:
            tray.run()                               # 阻塞：Windows/macOS/Linux 的托盘消息循环
        else:
            say(f"无托盘模式常驻中（Ctrl+C 退出）。收件目录：{INBOX_DIR}")
            while not stop.wait(0.5):
                pass
    except KeyboardInterrupt:
        say("收到中断，正在退出…")
    finally:
        stop.set()
        lock.release()
    return 0


# ---------------------------------------------------------------- 入口

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="AntiPrint 虚拟打印机：打印到 ANTIPRINT 队列 = 转 PDF + 提交到网站",
    )
    parser.add_argument("--settings", action="store_true", help="只打开配置界面")
    parser.add_argument("--selftest", action="store_true", help="自检并退出（退出码 0/1）")
    parser.add_argument("--status", action="store_true", help="打印当前状态（JSON）")
    parser.add_argument("--once", action="store_true", help="处理一轮后退出（调试）")
    parser.add_argument("--simulate", metavar="文件", help="把该文件当成打印输出走完整流程")
    parser.add_argument("--retry-failed", action="store_true", help="把失败的文件放回队列重试")
    parser.add_argument("--no-tray", action="store_true", help="常驻但不显示托盘图标")
    parser.add_argument("--silent", action="store_true", help="常驻且不主动弹界面（开机自启用它）")
    parser.add_argument("--create-shortcut", action="store_true", help="在桌面上创建快捷方式后退出")
    parser.add_argument("--init-config", action="store_true", help="生成空白配置文件后退出")
    parser.add_argument("--install-printer", action="store_true", help="建/修复虚拟打印机队列（需要管理员身份）")
    parser.add_argument("--uninstall-printer", action="store_true", help="删除虚拟打印机队列（需要管理员身份）")
    parser.add_argument("-v", "--verbose", action="store_true", help="输出调试日志")
    args = parser.parse_args(argv)

    # 只有「跑完就退出」的命令行模式才挂控制台：常驻（托盘/无托盘）绝不能挂 ——
    # start-vprinter.bat 用 start 拉起后 bat 自己会退出，控制台一关，Windows 会给所有
    # 挂在上面的进程发 CTRL_CLOSE_EVENT，守护进程会被连带杀掉。
    # 自动化/管道场景可用 ANTIPRINT_VPRINTER_NO_CONSOLE=1 关掉，让输出留在标准输出里。
    if os.environ.get("ANTIPRINT_VPRINTER_NO_CONSOLE") != "1" and (
            args.selftest or args.status or args.once or args.simulate or args.retry_failed
            or args.init_config or args.install_printer or args.uninstall_printer):
        attach_console()
    ensure_dirs()
    setup_logging(args.verbose)

    if args.init_config:
        save_config(load_config())
        say(f"已生成配置文件：{CONFIG_PATH}（{DATA_MODE}）")
        return 0

    cfg = load_config()

    if args.create_shortcut:
        ok, message = create_desktop_shortcut()
        say(("[OK] " if ok else "[FAIL] ") + message)
        if windowless() and not ok:
            vp_printer.info_box("AntiPrint 虚拟打印机", message)
        return 0 if ok else 1

    if args.install_printer:
        return manage_printer(cfg, install=True)

    if args.uninstall_printer:
        return manage_printer(cfg, install=False)

    if args.settings:
        from vp_gui import open_settings_window

        open_settings_window()
        return 0

    if args.selftest:
        return selftest(cfg)

    if args.status:
        return status(cfg)

    if args.simulate:
        source = Path(args.simulate).expanduser()
        if not source.is_file():
            say(f"找不到文件：{source}")
            return 1
        result = simulate(source, cfg, notify=lambda kind, text: LOG.info("[%s] %s", kind, text))
        say(("成功：" if result.ok else "失败：") + result.message)
        return 0 if result.ok else 1

    if args.retry_failed:
        count = retry_failed()
        pipeline = Pipeline(cfg)
        handled = pipeline.run_once()
        say(f"移回 {count} 个文件，处理了 {handled} 个")
        return 0

    if args.once:
        pipeline = Pipeline(cfg)
        say(f"处理了 {pipeline.run_once()} 个文件")
        return 0

    return run_daemon(cfg, use_tray=not args.no_tray, silent=args.silent)


if __name__ == "__main__":
    # 兜底：任何没接住的异常都写进日志再退出。打包成窗口程序后，未接住的异常会让
    # PyInstaller 弹一个「Fatal error」对话框在那儿等人点 —— 命令行模式下就成了
    # 「进程不退出、输出为空、卡到天荒地老」（2026-09-16 实际卡过一次，查了半天）。
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except BaseException:                       # noqa: BLE001 - 顶层兜底，就是要抓全部
        try:
            import traceback

            LOG.error("未处理的异常，进程退出：\n%s", traceback.format_exc())
            if sys.stderr is not None:
                traceback.print_exc()
        finally:
            raise SystemExit(1)
