# vp_tray.py — 系统托盘图标（Windows 右下角 / macOS 菜单栏 / Linux 状态栏）
#
# 依赖 pystray + Pillow（见 requirements.txt）。图标是程序画出来的（不额外放图片文件）：
# 青绿底 + 白色打印机轮廓 = 正常；砖红底 = 最近一次提交失败。
# 配置界面不在本进程里打开（见 virtual_printer.py 的 --settings），
# 这样托盘消息循环与 tkinter 各占各的线程，三个平台都不会抢主线程。

from __future__ import annotations

import subprocess
import sys
import threading
import time
from pathlib import Path

from vp_config import (
    CONFIG_DIR,
    FAILED_DIR,
    INBOX_DIR,
    LOG,
    LOG_FILE,
    SENT_DIR,
    VERSION,
    load_config,
    save_config,
    truthy,
)
from vp_platform import (
    app_dir,
    autostart_enabled,
    close_settings_windows,
    launch_argv,
    open_path,
    queue_exists,
    set_autostart,
    spawn_settings_window,
)

BRAND = (74, 157, 154)      # #4a9d9a 青绿（与前端主色一致）
CLAY = (193, 119, 103)      # #c17767 警示色
ICON_SIZE = 64


def _printer_name() -> str:
    from vp_config import DEFAULT_PRINTER_NAME

    return str(load_config().get("printer_name") or DEFAULT_PRINTER_NAME)


def _fresh_cfg() -> dict:
    """菜单里的勾选状态现读配置文件。

    别读内存里那份（`pipeline.cfg`）：配置界面是**另一个进程**，它改完直接写盘，
    守护进程侧要等热更新线程（2 秒一轮）——菜单上就会先显示改之前的值（用户反馈过）。
    这个回调只在弹出菜单时跑，读一次小 JSON 的开销可以忽略。"""
    try:
        return load_config()
    except Exception as exc:      # 配置坏了也别让菜单弹不出来
        LOG.warning("读配置失败（菜单按未勾选显示）：%s", exc)
        return {}

try:
    import pystray
    from PIL import Image, ImageDraw
    TRAY_AVAILABLE = True
except Exception:               # 缺依赖或没有图形环境（无 DISPLAY）时退化
    pystray = None              # type: ignore[assignment]
    Image = ImageDraw = None    # type: ignore[assignment]
    TRAY_AVAILABLE = False


def draw_printer(draw, size: int, color: tuple[int, int, int], slot: tuple[int, int, int] | None = None):
    """兜底用的实心打印机（正常路径是直接加载网站 logo，见 load_logo）"""
    body = color + (255,)
    draw.rectangle([int(size * .26), int(size * .16), int(size * .74), int(size * .40)], fill=body)
    draw.rounded_rectangle(
        [int(size * .12), int(size * .40), int(size * .88), int(size * .72)],
        radius=int(size * .07), fill=body,
    )
    if slot:
        draw.rectangle(
            [int(size * .30), int(size * .62), int(size * .70), int(size * .88)], fill=slot + (255,)
        )


def make_image(color: tuple[int, int, int], size: int = ICON_SIZE):
    """兜底图标：圆角底 + 实心打印机轮廓。只在拿不到网站 logo 时才用（形状与站点图标略有差别）"""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle([1, 1, size - 2, size - 2], radius=size // 5, fill=color + (255,))
    draw_printer(draw, size, (255, 255, 255), slot=color)
    return image


def make_glyph(color: tuple[int, int, int] = (255, 255, 255), size: int = 48):
    """只有一个打印机的图标（透明底）——兜底路径用"""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw_printer(ImageDraw.Draw(image), size, color)
    return image


# ---------------------------------------------------------------- 图标（与网站 logo 同款）

LOGO_RELATIVE = ("assets/antiprint-logo.png", "../frontend/public/apple-touch-icon.png")
_logo_cache: dict[tuple[int, str], object] = {}


def logo_source() -> Path | None:
    """网站 logo 图（品牌绿圆角方块 + 白色描边打印机，见 frontend/public/apple-touch-icon.png）：
    ① exe 打包进去的那份 → ② 程序目录旁边 → ③ 仓库里的 frontend/public（源码方式跑）。
    这条链上的图形是同一个，改图标时以 frontend/scripts/make_favicon.py 为准。"""
    base = Path(getattr(sys, "_MEIPASS", "") or "")            # PyInstaller 解包目录（exe 形态）
    roots = [base] if str(base) else []
    roots.append(Path(__file__).resolve().parent)              # 源码目录
    roots.append(app_dir())                                    # exe 所在目录（有人手动放一份也行）
    for root in roots:
        for rel in LOGO_RELATIVE:
            candidate = (root / rel).resolve()
            if candidate.is_file():
                return candidate
    return None


def _recolor_badge(image, color: tuple[int, int, int]):
    """把 logo 里的品牌色换成另一个颜色（失败态用）：白色图标与透明背景原样保留"""
    try:
        pixels = image.load()
    except Exception:
        return image
    for y in range(image.height):
        for x in range(image.width):
            red, green, blue, alpha = pixels[x, y]
            if alpha < 10 or min(red, green, blue) > 200:      # 透明 / 接近白色 → 不动
                continue
            pixels[x, y] = (color[0], color[1], color[2], alpha)
    return image


def load_logo(size: int = ICON_SIZE, state: str = "ok"):
    """托盘/窗口/程序图标：直接缩放网站那份 logo；失败态换成砖红。拿不到就退回程序画的兜底图标。"""
    key = (size, state)
    if key in _logo_cache:
        return _logo_cache[key]
    source = logo_source()
    image = None
    if source is not None and Image is not None:
        try:
            image = Image.open(source).convert("RGBA").resize((size, size), Image.LANCZOS)
            if state != "ok":
                image = _recolor_badge(image, CLAY)
        except Exception as exc:                               # 图坏了也不该让程序起不来
            LOG.warning("加载网站 logo 失败（改用兜底图标）：%s", exc)
            image = None
    if image is None:
        image = make_image(BRAND if state == "ok" else CLAY, size)
    _logo_cache[key] = image
    return image


class Tray:
    """托盘图标 + 菜单；回调只做轻活（打开窗口/目录、切开关），重活交给流水线线程"""

    def __init__(self, pipeline, stop: threading.Event):
        self.pipeline = pipeline
        self.stop = stop
        self.icon = None
        self.state = "ok"
        self.status_text = "启动中"
        self.ready = False          # 托盘图标是否已挂上系统托盘（_on_tray_ready 里置 True）

    # -------------------------------------------------- 对外接口

    def notify(self, kind: str, text: str) -> None:
        """提交结果反馈：始终更新图标颜色与悬停文字（鼠标划过去就能看到结果），
        气泡提示则看「提交后弹窗提示」这个勾选（**默认勾上 = 默认弹窗**，取消勾选就不弹）。"""
        self.set_state("ok" if kind == "ok" else "error", text)
        if self.icon is None or not self.popup_enabled():
            return
        try:
            self.icon.notify(text[:240], "AntiPrint 虚拟打印机")
        except Exception:              # Linux 上部分后端没有气泡通知，忽略
            pass

    def popup_enabled(self) -> bool:
        return truthy(self.pipeline.cfg.get("notify_popup")) if self.pipeline else False

    def set_state(self, state: str, text: str = "") -> None:
        self.state = state
        if text:
            self.status_text = text
        if self.icon is None:
            return
        self.icon.icon = load_logo(ICON_SIZE, "ok" if state == "ok" else "error")
        self.icon.title = f"AntiPrint 虚拟打印机 · {self.status_text}"[:120]

    # -------------------------------------------------- 菜单

    def _menu(self):
        return pystray.Menu(
            pystray.MenuItem(lambda item: self.status_text[:80] or "空闲", None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(
                lambda item: "安装虚拟打印机队列（管理员）" if not queue_exists(_printer_name())
                else "修复虚拟打印机队列（管理员）",
                self._install_printer,
            ),
            pystray.MenuItem("卸载虚拟打印机队列", self._uninstall_printer),
            pystray.MenuItem("重启后台服务", self._restart_daemon),
            pystray.MenuItem("创建桌面快捷方式", self._create_shortcut),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("打开配置界面", self._open_settings),
            pystray.MenuItem("打开收件目录", lambda: open_path(INBOX_DIR)),
            pystray.MenuItem("已被提交的文件", lambda: open_path(SENT_DIR)),
            pystray.MenuItem("提交失败的文件", lambda: open_path(FAILED_DIR)),
            pystray.MenuItem("重试失败的文件", self._retry_failed),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(
                "暂停监听",
                self._toggle_pause,
                checked=lambda item: bool(_fresh_cfg().get("paused")),
            ),
            pystray.MenuItem(
                "提交后弹窗提示",
                self._toggle_notify,
                checked=lambda item: truthy(_fresh_cfg().get("notify_popup")),
            ),
            pystray.MenuItem(
                "开机自动启动",
                self._toggle_autostart,
                checked=lambda item: autostart_enabled(),
            ),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("打开数据目录", lambda: open_path(CONFIG_DIR)),
            pystray.MenuItem("打开日志", lambda: open_path(LOG_FILE)),
            pystray.MenuItem(f"退出（v{VERSION}）", self._quit),
        )

    def _install_printer(self) -> None:
        """提权安装/修复队列：在后台线程里等（UAC 弹窗期间不能卡住托盘消息循环）"""
        self.set_state("error", "正在安装虚拟打印机队列（请在 UAC 窗口里点「是」）…")
        threading.Thread(target=self._install_worker, daemon=True).start()

    def _install_worker(self) -> None:
        import vp_printer

        ok, message = vp_printer.elevate_and_wait(["--install-printer"])
        if ok and queue_exists(_printer_name()):
            self.notify("ok", f"虚拟打印机已就绪：{_printer_name()}，现在可以 Ctrl+P 选它了")
            self.set_state("ok", "正在监听打印任务")
        else:
            self.notify("error", message if not ok else "安装似乎没成功，可再看一眼 README.txt")

    def _uninstall_printer(self) -> None:
        import vp_printer

        if not queue_exists(_printer_name()):
            self.notify("ok", f"队列 {_printer_name()} 本来就没装")
            return
        if not vp_printer.ask_yes_no(
            "AntiPrint 虚拟打印机",
            f"要删除虚拟打印机「{_printer_name()}」吗？\n\n"
            "删掉之后就打印不了（要恢复就再点一次「安装」）。\n"
            "程序本身不动：不想要了直接删掉文件夹即可。",
        ):
            return
        self.set_state("error", "正在卸载虚拟打印机队列…")
        threading.Thread(target=self._uninstall_worker, daemon=True).start()

    def _uninstall_worker(self) -> None:
        import vp_printer

        ok, message = vp_printer.elevate_and_wait(["--uninstall-printer"])
        self.notify("ok" if ok else "error", message)
        if ok:
            self.set_state("error", "虚拟打印机队列已卸载（右键菜单可重新安装）")

    def _create_shortcut(self) -> None:
        from vp_platform import create_desktop_shortcut, shortcut_exists

        if shortcut_exists():
            self.notify("ok", "桌面上已经有快捷方式了")
            return
        ok, message = create_desktop_shortcut()
        self.notify("ok" if ok else "error", message)

    def _restart_daemon(self) -> None:
        """重启后台服务：结束当前实例，再由一个**新进程**接管（托盘图标随之重新注册）。

        用途：Windows 的通知区偶尔会把图标整条丢掉（托盘菜单就点不到了），
        这时从配置界面（双击 exe 就能打开）点「重启后台服务」，图标就回来了。"""
        self.set_state("error", "正在重启后台服务…")
        threading.Thread(target=self._restart_worker, daemon=True).start()

    def _restart_worker(self) -> None:
        from vp_platform import stop_other_instances

        try:
            stopped = stop_other_instances()
            time.sleep(1.2)
            subprocess.Popen(launch_argv())
            time.sleep(2.5)
            LOG.info("后台服务已重启（结束 %s 个旧进程）", stopped)
        except Exception as exc:
            LOG.warning("重启后台服务失败：%s", exc)

    def _open_settings(self) -> None:
        # exe 形态 = 再起一个自己（exe --settings），源码形态 = pythonw virtual_printer.py --settings
        try:
            spawn_settings_window()
            LOG.info("已打开配置界面窗口")
        except OSError as exc:
            self.notify("error", f"打不开配置界面：{exc}")

    def _retry_failed(self) -> None:
        from vp_pipeline import retry_failed

        count = retry_failed()
        self.notify("ok", f"已把 {count} 个失败文件放回队列重试" if count else "没有失败的文件")

    def _toggle_pause(self) -> None:
        cfg = load_config()
        cfg["paused"] = not bool(cfg.get("paused"))
        save_config(cfg)
        self.pipeline.update_config(cfg)
        self.set_state("ok", "已暂停监听（打印不会提交）" if cfg["paused"] else "已恢复监听")

    def _toggle_notify(self) -> None:
        """提交后是否弹提示气泡（默认关：只更新图标颜色与悬停文字）"""
        cfg = load_config()
        cfg["notify_popup"] = not truthy(cfg.get("notify_popup"))
        save_config(cfg)
        if self.pipeline:
            self.pipeline.update_config(cfg)
        self.set_state(self.state, "提交后会弹提示气泡" if cfg["notify_popup"]
                       else "提交后不弹窗（鼠标划过图标能看到结果）")

    def _toggle_autostart(self) -> None:
        target = not autostart_enabled()
        ok, message = set_autostart(target)
        cfg = load_config()
        cfg["autostart"] = target if ok else autostart_enabled()
        save_config(cfg)
        self.notify("ok" if ok else "error", message)

    def _quit(self) -> None:
        LOG.info("用户选择退出：正在关闭配置界面与后台服务")
        self.stop.set()
        closed = close_settings_windows()
        LOG.info("配置界面窗口已关闭 %s 个", closed)
        if self.icon is not None:
            self.icon.stop()

    # -------------------------------------------------- 生命周期

    def run(self) -> None:
        """阻塞式运行托盘（必须放主线程）"""
        if not TRAY_AVAILABLE:
            LOG.warning("没有可用的托盘后端（pystray/Pillow 缺失或无图形环境），请用 --no-tray 常驻")
            raise SystemExit(1)
        if not self.status_text or self.status_text == "启动中":
            self.status_text = "正在监听打印任务"
        # 注意：这里必须沿用调用方（run_daemon）刚设好的状态，别写死成「正在监听」——
        # 否则「队列还没安装」「配置不完整」这类启动提示会被盖掉，首次使用的人就看不到该看的那句话。
        self.icon = pystray.Icon(
            "antiprint-vprinter",
            load_logo(ICON_SIZE, "ok" if self.state == "ok" else "error"),
            f"AntiPrint 虚拟打印机 · {self.status_text}"[:120],
            self._menu(),
        )
        # setup 回调在图标窗口就绪之后执行。**注意 pystray 的坑**：一旦传了 setup 回调，
        # 它就不再执行默认那句 `visible = True`（见 pystray/_base.py 的 setup_handler），
        # 于是图标**永远不会被 Shell_NotifyIcon(NIM_ADD) 加进托盘** —— 必须自己设。
        # 2026-09-16 踩过：为了记一行「图标已显示」加了回调，图标从此没出现过，
        # 那行日志还让人误以为是系统把图标弄丢了（回调里记的那句是假证据）。
        self.icon.run(setup=self._on_tray_ready)

    def _on_tray_ready(self, icon) -> None:
        try:
            icon.visible = True              # 真正把图标加进系统托盘（NIM_ADD）
        except Exception as exc:             # 比如没有图标数据
            LOG.warning("托盘图标显示失败：%s", exc)
            return
        self.ready = bool(icon.visible)
        source = logo_source()
        LOG.info("托盘图标已显示（图标取自 %s；状态：%s）",
                 source.name if source else "兜底图标", self.status_text)
