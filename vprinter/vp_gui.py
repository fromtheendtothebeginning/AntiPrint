# vp_gui.py — 配置界面（tkinter，三个平台通用，无第三方界面库）
#
# 由托盘菜单「打开配置界面」或 `virtual_printer.py --settings` 拉起，跑在**独立进程**里：
#   1) 托盘的消息循环与 tkinter 主循环各占一个进程，macOS 上不会抢主线程；
#   2) 关掉窗口不影响守护进程继续监听（守护进程按配置文件 mtime 热更新）。
# 保存后写 config.json；勾选「开机自动启动」立刻写系统自启动项（注册表 / LaunchAgent / .desktop）。
#
# 界面约定：暖米白底 + 白色卡片（与网站前端同一套配色），标题条用品牌青绿 + 打印机图标；
# 按钮样式统一在 _setup_style() 里定义（clam 主题才允许给按钮上色）。

from __future__ import annotations

import os
import queue
import subprocess
import threading
import time
import tkinter as tk
from datetime import datetime
from tkinter import messagebox, ttk

from vp_api import ApiError, Client
from vp_config import (
    CLOSE_ASK,
    CLOSE_ACTIONS,
    CLOSE_QUIT,
    CLOSE_WINDOW,
    CONFIG_DIR,
    CONFIG_PATH,
    DATA_MODE,
    FAILED_DIR,
    INBOX_DIR,
    LOG,
    LOG_FILE,
    VERSION,
    load_config,
    load_recent,
    save_config,
)
from vp_platform import (
    autostart_enabled,
    daemon_running,
    open_path,
    platform_label,
    queue_detail,
    queue_exists,
    set_autostart,
    shortcut_exists,
    create_desktop_shortcut,
    spool_mismatch,
    stop_daemon,
)

# 与网站前端一致的配色（见 AGENTS.md「前端约定」）
BRAND = "#4a9d9a"
BRAND_DARK = "#3d8784"
CLAY = "#c17767"
AMBER = "#e8b86d"
WARM = "#faf8f5"
CARD = "#ffffff"
BORDER = "#e8e2da"
TEXT = "#2b2b2a"
MUTED = "#6b7280"

# ── 勾选框：clam 主题自带的「选中」标记是个叉（⊠），换成自绘的品牌色方框 + 白对勾 ──
CHECK_SIZE = 16
CHECK_RADIUS = 4.0


def _check_inside(x, y, radius=CHECK_RADIUS):
    """16×16 圆角方框内部判定（点不在四个角上的圆外即算内部）"""
    left = top = 0.5
    right = bottom = CHECK_SIZE - 0.5
    if not (left <= x <= right and top <= y <= bottom):
        return False
    for cx, cy, in_corner in (
        (left + radius, top + radius, x < left + radius and y < top + radius),
        (right - radius, top + radius, x > right - radius and y < top + radius),
        (left + radius, bottom - radius, x < left + radius and y > bottom - radius),
        (right - radius, bottom - radius, x > right - radius and y > bottom - radius),
    ):
        if in_corner:
            return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
    return True


def _check_stroke(x, y, thickness=2.0):
    """对勾：一短撇 + 一长提"""
    def near(x0, y0, x1, y1):
        dx, dy = x1 - x0, y1 - y0
        length2 = dx * dx + dy * dy
        if length2 == 0:
            return (x - x0) ** 2 + (y - y0) ** 2 <= (thickness / 2) ** 2
        t = max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / length2))
        return (x - (x0 + t * dx)) ** 2 + (y - (y0 + t * dy)) ** 2 <= (thickness / 2) ** 2

    return near(4.8, 8.4, 7.2, 11.0) or near(7.2, 11.0, 12.0, 5.2)


def _check_indicators(fill: str):
    """未选中 = 描边空框（内部填容器底色）；选中 = 品牌色填充 + 白色对勾"""
    off = tk.PhotoImage(width=CHECK_SIZE, height=CHECK_SIZE)
    on = tk.PhotoImage(width=CHECK_SIZE, height=CHECK_SIZE)
    for y in range(CHECK_SIZE):
        for x in range(CHECK_SIZE):
            px, py = x + 0.5, y + 0.5
            if _check_inside(px, py):
                on.put("#ffffff" if _check_stroke(px, py) else BRAND, (x, y))
            else:
                on.put(BRAND, (x, y))
            if _check_inside(px, py, CHECK_RADIUS - 1.2):
                off.put(fill, (x, y))
            else:
                off.put(BORDER, (x, y))
    return off, on


def _install_brand_checkbutton(style) -> tuple:
    """把 TCheckbutton 的指示器换成自绘图片（图片对象要一直被引用，否则 Tk 会画成空白）"""
    images = _check_indicators(WARM)
    try:
        style.element_create("Checkbutton.brandindicator", "image", images[0], ("selected", images[1]))
    except tk.TclError:
        pass    # 同一个进程里第二次建窗口时元素已存在，直接用现成的
    style.layout(
        "TCheckbutton",
        [
            (
                "Checkbutton.padding",
                {
                    "sticky": "nswe",
                    "children": [
                        ("Checkbutton.brandindicator", {"side": "left", "sticky": ""}),
                        (
                            "Checkbutton.focus",
                            {
                                "side": "left",
                                "sticky": "nswe",
                                "children": [("Checkbutton.label", {"sticky": "nswe"})],
                            },
                        ),
                    ],
                },
            )
        ],
    )
    return images


AUTH_LABELS = {"本站账号": "local", "anticraft 账号": "anticraft"}
DELIVERY_LABELS = {"跟随网站默认": "", "配送": "配送", "取件": "取件"}
ICON_SIZE = 44


def _font(size: int = 10, bold: bool = False):
    family = "Microsoft YaHei UI" if os.name == "nt" else ""
    return (family, size, "bold") if bold else (family, size)


def _header_icon(size: int = ICON_SIZE):
    """页面顶部的 logo：直接用网站那份（品牌绿圆角方块 + 白色描边打印机）。
    走「Pillow 缩放 → 存 png → tk.PhotoImage 读」这条路，不依赖 PIL.ImageTk（打包成 exe 更稳）。"""
    try:
        from vp_tray import load_logo

        cache = CONFIG_DIR / "cache"
        cache.mkdir(parents=True, exist_ok=True)
        path = cache / f"logo-{size}.png"
        load_logo(size).save(path)
        return tk.PhotoImage(file=str(path)), path
    except Exception:                      # 没装 Pillow / 写不了目录：没有图标也能用
        return None, None


def close_action_of(cfg: dict) -> str:
    """点 × 时该干什么（读配置 + 兜底），单独拿出来是为了能直接测"""
    value = str(cfg.get("close_action") or "").strip()
    return value if value in CLOSE_ACTIONS else CLOSE_ASK


class ClosePrompt(tk.Toplevel):
    """点配置界面窗口的 × 时问一句：只关这个界面，还是连后台服务一起退出？

    result 为 None = 取消（什么都不做）。勾了「记住我的选择」由调用方写进配置。
    说明文案把两种选择的后果写清楚 —— 用户投诉过「以为关了、其实还在后台跑」。
    """

    def __init__(self, master, remember_default: bool = False):
        super().__init__(master)
        self.result: str | None = None
        self.remember = tk.BooleanVar(value=remember_default)
        self.title("关闭 AntiPrint 虚拟打印机")
        self.configure(bg=WARM)
        self.resizable(False, False)
        self.transient(master)
        body = ttk.Frame(self, padding=(18, 16, 18, 12))
        body.pack(fill="both", expand=True)
        ttk.Label(body, text="要关闭哪个？", style="Card.TLabel", font=_font(12, True)).pack(anchor="w")
        ttk.Label(body, justify="left", wraplength=430, style="Card.TLabel", font=_font(9),
                  text=("只关界面：关掉这个配置窗口，后台服务继续监听打印任务（右下角托盘图标还在），"
                        "下次双击图标就能打开。\n\n"
                        "退出程序：连后台服务一起停掉，托盘图标消失。之后想打印得重新启动程序。")
                  ).pack(anchor="w", pady=(8, 10))
        self.chk_remember = ttk.Checkbutton(body, text="记住我的选择（以后不再询问，可在「运行状态」页改回来）",
                                           variable=self.remember)
        self.chk_remember.pack(anchor="w")
        row = ttk.Frame(body)
        row.pack(fill="x", pady=(14, 0))
        self.btn_window = ttk.Button(row, text="只关界面", style="Brand.TButton",
                                     command=lambda: self._choose(CLOSE_WINDOW))
        self.btn_window.pack(side="left")
        self.btn_quit = ttk.Button(row, text="退出程序", style="Danger.TButton",
                                   command=lambda: self._choose(CLOSE_QUIT))
        self.btn_quit.pack(side="left", padx=(8, 0))
        self.btn_cancel = ttk.Button(row, text="取消", style="Ghost.TButton", command=self._cancel)
        self.btn_cancel.pack(side="left", padx=(8, 0))
        self.protocol("WM_DELETE_WINDOW", self._cancel)
        self.bind("<Escape>", lambda _event: self._cancel())
        # 居中到父窗口
        self.update_idletasks()
        x = master.winfo_rootx() + max(0, (master.winfo_width() - self.winfo_reqwidth()) // 2)
        y = master.winfo_rooty() + max(0, (master.winfo_height() - self.winfo_reqheight()) // 3)
        self.geometry(f"+{x}+{y}")
        self.grab_set()
        self.focus_set()

    def _choose(self, action: str) -> None:
        self.result = action
        self.destroy()

    def _cancel(self) -> None:
        self.result = None
        self.destroy()


class SettingsWindow:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.cfg = load_config()
        self.queue = queue.Queue()
        self.icon_photo = None
        self.active_tab = "account"
        root.title("AntiPrint 虚拟打印机 · 配置")
        # 尺寸按屏幕自适应；分成子界面之后窗口本身就矮了，这里再压一档
        width = min(780, int(root.winfo_screenwidth() * 0.92))
        height = min(600, int(root.winfo_screenheight() * 0.78))
        root.geometry(f"{width}x{height}")
        root.minsize(680, 520)
        root.resizable(True, True)
        root.protocol("WM_DELETE_WINDOW", self._on_close)   # × 时问一句：只关界面 / 退出程序
        self._setup_style()
        self._build()
        self._load_into_form()
        self._refresh_status()
        self.root.after(150, self._drain_queue)

    # -------------------------------------------------- 样式

    def _setup_style(self) -> None:
        style = ttk.Style(self.root)
        try:
            style.theme_use("clam")         # clam 才允许给按钮/输入框上自定义底色
        except tk.TclError:
            pass
        style.configure("TFrame", background=WARM)
        style.configure("Card.TFrame", background=CARD)
        style.configure("TLabel", background=WARM, foreground=TEXT, font=_font())
        style.configure("Card.TLabel", background=CARD, foreground=TEXT, font=_font())
        style.configure("Muted.TLabel", background=CARD, foreground=MUTED, font=_font(9))
        style.configure("Title.TLabel", background=CARD, foreground=BRAND_DARK, font=_font(15, True))
        style.configure("Sub.TLabel", background=CARD, foreground=MUTED, font=_font(9))
        style.configure("TEntry", fieldbackground=CARD, bordercolor=BORDER, font=_font(), padding=4)
        style.configure("TCombobox", fieldbackground=CARD, bordercolor=BORDER, font=_font(), padding=3)
        style.configure("TSpinbox", fieldbackground=CARD, bordercolor=BORDER, font=_font(), padding=3)
        style.configure("TCheckbutton", background=WARM, foreground=TEXT, font=_font())
        # 自绘勾选框：clam 自带的选中标记是个「叉」，用户要求改成「打钩」
        self._check_images = _install_brand_checkbutton(style)
        style.configure("Brand.TButton", background=BRAND, foreground="#ffffff", font=_font(10, True),
                        borderwidth=0, focusthickness=0, padding=(14, 8))
        style.map("Brand.TButton",
                  background=[("active", BRAND_DARK), ("disabled", "#a8cfcd")],
                  foreground=[("disabled", "#f2f7f7")])
        style.configure("Ghost.TButton", background=CARD, foreground=TEXT, font=_font(9),
                        bordercolor=BORDER, borderwidth=1, padding=(10, 6))
        style.map("Ghost.TButton", background=[("active", "#f1efec")])
        # 二级菜单：未选中浅色、选中品牌色（和网站管理页的分栏按钮一个意思）
        style.configure("Tab.TButton", background=CARD, foreground=MUTED, font=_font(10),
                        bordercolor=BORDER, borderwidth=1, padding=(14, 7))
        style.map("Tab.TButton", background=[("active", "#f1efec")])
        style.configure("TabActive.TButton", background=BRAND, foreground="#ffffff", font=_font(10, True),
                        borderwidth=0, padding=(14, 7))
        style.map("TabActive.TButton", background=[("active", BRAND_DARK)])
        style.configure("Danger.TButton", background=CLAY, foreground="#ffffff", font=_font(9),
                        borderwidth=0, padding=(10, 6))
        style.map("Danger.TButton", background=[("active", "#ad6a5c")])

    def _card(self, parent, number: str = "", title: str = "") -> ttk.Frame:
        """一张白卡片；带编号小标题，方便第一次用的人按顺序看。
        返回的是**卡片内部的内容框**（标题单独占一行，调用方只管往里 grid 自己的控件）。"""
        card = ttk.Frame(parent, style="Card.TFrame", padding=14)
        card.pack(fill="x", pady=(0, 10))
        if title:
            head = ttk.Frame(card, style="Card.TFrame")
            head.pack(fill="x", pady=(0, 8))
            if number:
                tk.Label(head, text=f" {number} ", bg=BRAND, fg="#ffffff",
                         font=_font(9, True), padx=4, pady=1).pack(side="left")
            ttk.Label(head, text=title, style="Card.TLabel", font=_font(11, True)).pack(side="left", padx=(6, 0))
        content = ttk.Frame(card, style="Card.TFrame")
        content.pack(fill="both", expand=True)
        return content

    # -------------------------------------------------- 界面

    def _build(self) -> None:
        outer = ttk.Frame(self.root, padding=0)
        outer.pack(fill="both", expand=True)
        # 纵向分三层：顶部 logo 条 / 中间「二级菜单 + 子界面」/ 底部固定操作条
        outer.columnconfigure(0, weight=1)
        outer.rowconfigure(3, weight=1)

        # ── 顶部：网站 logo + 标题（与网站侧栏同一套配色）──
        header = tk.Frame(outer, bg=CARD)
        header.grid(row=0, column=0, sticky="ew")
        inner = tk.Frame(header, bg=CARD, padx=16, pady=10)
        inner.pack(fill="x")
        self.icon_photo, _ = _header_icon()
        if self.icon_photo is not None:
            tk.Label(inner, image=self.icon_photo, bg=CARD).pack(side="left", padx=(0, 12))
        text_box = tk.Frame(inner, bg=CARD)
        text_box.pack(side="left", fill="x", expand=True)
        ttk.Label(text_box, text="AntiPrint 虚拟打印机", style="Title.TLabel").pack(anchor="w")
        ttk.Label(text_box, text=f"v{VERSION} · {platform_label()} · 打印即自动转 PDF 提交到网站",
                  style="Sub.TLabel").pack(anchor="w")
        tk.Frame(header, bg=BORDER, height=1).pack(fill="x")
        self.root.iconphoto(True, self.icon_photo or tk.PhotoImage(width=1, height=1))

        # ── 二级菜单（和网站管理页一个路子：一排按钮切换子界面）──
        tabbar = ttk.Frame(outer, padding=(14, 8, 14, 0))
        tabbar.grid(row=1, column=0, sticky="ew")
        self.tab_buttons: dict[str, ttk.Button] = {}
        for key, label in (("account", "网站账号"), ("submit", "提交选项"), ("status", "运行状态")):
            button = ttk.Button(tabbar, text=label, style="Tab.TButton",
                                command=lambda name=key: self._show_tab(name))
            button.pack(side="left", padx=(0, 6))
            self.tab_buttons[key] = button

        # ── 首次使用提示条（缺账号/缺队列时显示，所有子界面都能看到）──
        self.banner = tk.Label(outer, text="", bg="#fdf4e3", fg="#8a6116", font=_font(9),
                               justify="left", anchor="w", padx=10, pady=8, wraplength=700)

        # ── 子界面：每个页面单独一张卡片，切换时只显示其中一个 ──
        self.page_area = ttk.Frame(outer, padding=(14, 12, 14, 0))
        self.page_area.grid(row=3, column=0, sticky="nsew")
        self.page_area.columnconfigure(0, weight=1)
        self.page_area.rowconfigure(0, weight=1)
        self.pages: dict[str, ttk.Frame] = {
            "account": self._build_account_page(),
            "submit": self._build_submit_page(),
            "status": self._build_status_page(),
        }
        for page in self.pages.values():
            page.grid(row=0, column=0, sticky="nsew")      # 叠在同一格，用 tkraise 切换

        self._build_footer(outer)
        self._show_tab(self._initial_tab())

    def _page(self, title: str, scroll: bool = False) -> ttk.Frame:
        """一个子界面（白卡片 + 标题），返回卡片内部的内容框。

        scroll=True 时内容可滚动：「运行状态」那页东西会越加越多（状态、队列、× 的行为、最近提交），
        窗口矮一点或提示条出现时会被裁掉半行 —— 2026-09-17 截图验收时真撞到过。"""
        page = ttk.Frame(self.page_area, style="Card.TFrame", padding=14)
        ttk.Label(page, text=title, style="Card.TLabel", font=_font(11, True)).pack(anchor="w", pady=(0, 10))
        if not scroll:
            content = ttk.Frame(page, style="Card.TFrame")
            content.pack(fill="both", expand=True)
            return page, content
        holder = ttk.Frame(page, style="Card.TFrame")
        holder.pack(fill="both", expand=True)
        canvas = tk.Canvas(holder, bg=CARD, highlightthickness=0, borderwidth=0)
        bar = ttk.Scrollbar(holder, orient="vertical", command=canvas.yview)
        canvas.configure(yscrollcommand=bar.set)
        canvas.pack(side="left", fill="both", expand=True)
        bar.pack(side="right", fill="y")
        content = ttk.Frame(canvas, style="Card.TFrame")
        inner = canvas.create_window((0, 0), window=content, anchor="nw")
        content.bind("<Configure>", lambda _e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.bind("<Configure>", lambda e: canvas.itemconfigure(inner, width=e.width))   # 内容跟窗口同宽
        self._scroll_canvas = canvas
        for widget in (canvas, content):
            widget.bind("<MouseWheel>", lambda e: canvas.yview_scroll(-1 if e.delta > 0 else 1, "units"))
            widget.bind("<Button-4>", lambda _e: canvas.yview_scroll(-1, "units"))     # Linux 滚轮
            widget.bind("<Button-5>", lambda _e: canvas.yview_scroll(1, "units"))
        return page, content

    def _show_tab(self, key: str) -> None:
        """切换子界面：选中的按钮用品牌色，其余是浅色"""
        self.active_tab = key
        for name, button in self.tab_buttons.items():
            button.configure(style="TabActive.TButton" if name == key else "Tab.TButton")
        self.pages[key].tkraise()

    def _initial_tab(self) -> str:
        """打开时停在哪个子界面：缺东西就停在需要处理的那一页"""
        cfg = self.cfg
        if not (cfg.get("username") and cfg.get("password")):
            return "account"
        if not queue_exists(str(cfg.get("printer_name") or "")):
            return "status"
        return "account"

    # -------------------------------------------------- 三个子界面

    def _build_account_page(self) -> ttk.Frame:
        page, account = self._page("网站账号")
        account.columnconfigure(1, weight=1)
        ttk.Label(account, text="服务器地址", style="Card.TLabel").grid(row=0, column=0, sticky="w", pady=5)
        self.var_server = tk.StringVar()
        ttk.Entry(account, textvariable=self.var_server).grid(row=0, column=1, columnspan=2,
                                                             sticky="ew", padx=8, pady=5)
        ttk.Label(account, text="登录方式", style="Card.TLabel").grid(row=1, column=0, sticky="w", pady=5)
        self.var_auth = tk.StringVar()
        ttk.Combobox(account, textvariable=self.var_auth, values=list(AUTH_LABELS),
                     state="readonly", width=14).grid(row=1, column=1, sticky="w", padx=8, pady=5)
        ttk.Label(account, text="用户名", style="Card.TLabel").grid(row=2, column=0, sticky="w", pady=5)
        self.var_user = tk.StringVar()
        ttk.Entry(account, textvariable=self.var_user).grid(row=2, column=1, sticky="ew", padx=8, pady=5)
        ttk.Label(account, text="密码", style="Card.TLabel").grid(row=3, column=0, sticky="w", pady=5)
        self.var_password = tk.StringVar()
        ttk.Entry(account, textvariable=self.var_password, show="*").grid(
            row=3, column=1, sticky="ew", padx=8, pady=5)
        self.btn_test = ttk.Button(account, text="测试连接", style="Ghost.TButton", command=self._test_connection)
        self.btn_test.grid(row=3, column=2, sticky="e", padx=(6, 0), pady=5)
        ttk.Label(account, text="密码只存在本机配置文件里（仅供本用户读取）。anticraft 账号 = 用 anticraft.top 的账号密码。",
                  style="Muted.TLabel", wraplength=680, justify="left").grid(
            row=4, column=0, columnspan=3, sticky="w", pady=(4, 0))
        return page

    def _build_submit_page(self) -> ttk.Frame:
        page, submit = self._page("提交选项")
        submit.columnconfigure(3, weight=1)
        ttk.Label(submit, text="份数", style="Card.TLabel").grid(row=0, column=0, sticky="w", pady=5)
        self.var_copies = tk.IntVar(value=1)
        ttk.Spinbox(submit, from_=1, to=99, width=5, textvariable=self.var_copies).grid(
            row=0, column=1, sticky="w", padx=8, pady=5)
        ttk.Label(submit, text="备注", style="Card.TLabel").grid(row=0, column=2, sticky="e", pady=5)
        self.var_note = tk.StringVar()
        ttk.Entry(submit, textvariable=self.var_note).grid(row=0, column=3, sticky="ew", padx=8, pady=5)

        ttk.Label(submit, text="配送方式", style="Card.TLabel").grid(row=1, column=0, sticky="w", pady=5)
        self.var_delivery = tk.StringVar()
        ttk.Combobox(submit, textvariable=self.var_delivery, values=list(DELIVERY_LABELS),
                     state="readonly", width=14).grid(row=1, column=1, sticky="w", padx=8, pady=5)
        ttk.Label(submit, text="配送地址", style="Card.TLabel").grid(row=1, column=2, sticky="e", pady=5)
        self.var_address = tk.StringVar()
        ttk.Entry(submit, textvariable=self.var_address).grid(row=1, column=3, sticky="ew", padx=8, pady=5)
        ttk.Label(submit, text="配送方式与地址留空 = 用网站「我的配置」里的默认值；份数越多，按张数计的费用越高。",
                  style="Muted.TLabel").grid(row=2, column=0, columnspan=4, sticky="w", pady=(4, 0))
        return page

    def _build_status_page(self) -> ttk.Frame:
        page, status = self._page("运行状态", scroll=True)      # 内容会越来越长，能滚才不会被裁
        status.columnconfigure(0, weight=1)
        tools = ttk.Frame(status, style="Card.TFrame")
        tools.grid(row=0, column=0, sticky="ew")
        self.btn_install = ttk.Button(tools, text="一键安装打印机队列", style="Brand.TButton",
                                      command=self._install_printer)
        self.btn_install.pack(side="left")
        ttk.Button(tools, text="卸载队列", style="Ghost.TButton", command=self._uninstall_printer).pack(
            side="left", padx=6)
        ttk.Button(tools, text="重启后台服务", style="Ghost.TButton", command=self._restart_daemon).pack(
            side="left", padx=(0, 6))
        ttk.Button(tools, text="创建桌面快捷方式", style="Ghost.TButton",
                   command=self._create_shortcut).pack(side="left", padx=(0, 6))
        ttk.Button(tools, text="刷新状态", style="Ghost.TButton", command=self._refresh_status).pack(side="left")
        self.lbl_status = ttk.Label(status, text="读取中…", style="Card.TLabel", justify="left",
                                    wraplength=680, font=_font(9))
        self.lbl_status.grid(row=1, column=0, sticky="w", pady=(10, 0))

        # 点窗口的 × 时干什么：跟「托盘退出」是两回事，问清楚、可记住、也能在这儿改回来
        ttk.Label(status, text="点窗口的 × 时", style="Card.TLabel", font=_font(10, True)).grid(
            row=2, column=0, sticky="w", pady=(12, 2))
        close_row = ttk.Frame(status, style="Card.TFrame")
        close_row.grid(row=3, column=0, sticky="w")
        self.var_close = tk.StringVar(value=CLOSE_ASK)
        self.close_radios = []
        for label, value in (("每次询问", CLOSE_ASK),
                             ("只关界面（后台继续跑）", CLOSE_WINDOW),
                             ("退出程序（连后台服务）", CLOSE_QUIT)):
            radio = ttk.Radiobutton(close_row, text=label, value=value, variable=self.var_close,
                                    command=self._set_close_action)
            radio.pack(side="left", padx=(0, 14))
            self.close_radios.append(radio)

        ttk.Label(status, text="最近提交", style="Card.TLabel", font=_font(10, True)).grid(
            row=4, column=0, sticky="w", pady=(10, 2))
        self.txt_recent = tk.Text(status, height=5, wrap="word", relief="flat", borderwidth=0,
                                  bg="#fbfaf8", fg=TEXT, font=_font(9), padx=8, pady=6)
        self.txt_recent.grid(row=5, column=0, sticky="nsew")
        status.rowconfigure(5, weight=1)
        self.txt_recent.configure(state="disabled")
        return page

    def _build_footer(self, outer: ttk.Frame) -> None:
        """底部操作条：固定在窗口下沿（不跟着子界面切换跑掉）"""
        footer = ttk.Frame(outer, padding=(14, 8, 14, 12))
        footer.grid(row=4, column=0, sticky="ew")
        self.footer = footer
        tk.Frame(footer, bg=BORDER, height=1).pack(fill="x", pady=(0, 8))
        # 按钮一行、勾选项一行：7 个控件挤一行要 781px，窗口只有 780（最小 680）时
        # 勾选项会被按钮压住（用户反馈的「这个选项有一点遮挡」）
        row = ttk.Frame(footer)
        row.pack(fill="x")
        self.footer_row = row
        ttk.Button(row, text="保存并应用", style="Brand.TButton", command=self._save).pack(side="left")
        for text, target in (("打开数据目录", CONFIG_DIR), ("收件目录", INBOX_DIR),
                             ("失败目录", FAILED_DIR), ("查看日志", LOG_FILE)):
            ttk.Button(row, text=text, style="Ghost.TButton",
                       command=lambda path=target: open_path(path)).pack(side="left", padx=(6, 0))

        checks = ttk.Frame(footer)
        checks.pack(fill="x", pady=(8, 0))
        self.footer_checks = checks                     # 用例用（断言两行都不超宽）
        self.var_autostart = tk.BooleanVar(value=False)
        self.chk_autostart = ttk.Checkbutton(checks, text="开机自动启动", variable=self.var_autostart,
                                            command=self._toggle_autostart)
        self.chk_autostart.pack(side="left")
        self.var_notify = tk.BooleanVar(value=True)      # 默认勾上：提交后弹提示气泡
        # 勾选即保存（用户要求）：托盘菜单与守护进程都读配置文件，点完不用再按「保存并应用」
        self.chk_notify = ttk.Checkbutton(checks, text="提交后弹窗提示", variable=self.var_notify,
                                         command=self._toggle_notify)
        self.chk_notify.pack(side="left", padx=(16, 0))

        self.lbl_hint = tk.Label(footer, text="", fg=BRAND, bg=WARM, wraplength=740,
                                 justify="left", font=_font(9), anchor="w")
        self.lbl_hint.pack(fill="x", pady=(6, 0))

    def _load_into_form(self) -> None:
        cfg = self.cfg
        self.var_server.set(cfg.get("server") or "")
        self.var_auth.set("anticraft 账号" if cfg.get("auth_mode") == "anticraft" else "本站账号")
        self.var_user.set(cfg.get("username") or "")
        self.var_password.set(cfg.get("password") or "")
        self.var_copies.set(int(cfg.get("copies") or 1))
        self.var_note.set(cfg.get("note") or "")
        self.var_delivery.set(cfg.get("delivery_mode") or "跟随网站默认")
        self.var_address.set(cfg.get("address") or "")
        self.var_autostart.set(autostart_enabled())
        self.var_notify.set(bool(cfg.get("notify_popup")))
        self.var_close.set(close_action_of(cfg))

    # -------------------------------------------------- 动作

    def _collect(self) -> dict:
        cfg = dict(self.cfg)
        cfg["server"] = self.var_server.get().strip().rstrip("/")
        cfg["auth_mode"] = AUTH_LABELS.get(self.var_auth.get(), "local")
        cfg["username"] = self.var_user.get().strip()
        cfg["password"] = self.var_password.get()
        cfg["copies"] = max(1, min(99, int(self.var_copies.get() or 1)))
        cfg["note"] = self.var_note.get().strip()
        cfg["delivery_mode"] = DELIVERY_LABELS.get(self.var_delivery.get(), "")
        cfg["address"] = self.var_address.get().strip()
        cfg["autostart"] = bool(self.var_autostart.get())
        cfg["notify_popup"] = bool(self.var_notify.get())
        return cfg

    def _save(self) -> None:
        cfg = self._collect()
        if not cfg["server"]:
            messagebox.showwarning("缺服务器地址", "请填写服务器地址，例如 https://print.anticraft.top")
            return
        if not cfg["username"] or not cfg["password"]:
            if not messagebox.askyesno("还没填账号", "现在没有用户名/密码，打印出来的文件将无法提交。仍要保存吗？"):
                return
        if cfg["delivery_mode"] == "配送" and not cfg["address"]:
            self._set_hint("提示：配送方式选了「配送」但没填地址，将使用网站「我的配置」里的默认地址。")
        # 换了账号就丢掉旧令牌
        if cfg["username"] != self.cfg.get("username") or cfg["server"] != self.cfg.get("server"):
            cfg["token"] = ""
            cfg["token_at"] = 0
        save_config(cfg)
        self.cfg = cfg
        self._set_hint(f"已保存（{CONFIG_PATH}）；守护进程会自动读取，不用重启。"
                       + ("提交后会弹提示气泡。" if cfg["notify_popup"]
                          else "提交后不弹窗（鼠标划过托盘图标能看到结果）。"))
        self._refresh_status()

    def _toggle_autostart(self) -> None:
        """勾选即保存（用户要求）：写系统自启动项 + 存配置，不用再按「保存并应用」"""
        ok, message = set_autostart(bool(self.var_autostart.get()))
        if not ok:
            self.var_autostart.set(autostart_enabled())
        cfg = load_config()
        cfg["autostart"] = bool(autostart_enabled())
        save_config(cfg)
        self.cfg = cfg
        self._set_hint(message)

    def _toggle_notify(self) -> None:
        """勾选即保存（用户要求）：托盘菜单与守护进程都读配置文件，改完立刻生效"""
        cfg = load_config()
        cfg["notify_popup"] = bool(self.var_notify.get())
        save_config(cfg)
        self.cfg = cfg
        self._set_hint("已保存：" + ("提交后会弹提示气泡。" if cfg["notify_popup"]
                                    else "提交后不弹窗（鼠标划过托盘图标能看到结果）。"))

    def _set_hint(self, text: str, error: bool = False) -> None:
        self.lbl_hint.configure(text=text, foreground=CLAY if error else BRAND)

    # -------------------------------------------------- 关窗口（只关界面 / 退出程序）

    def _set_close_action(self) -> None:
        """「运行状态」页的单选：改完立刻落盘（下次点 × 就按它来）"""
        action = self.var_close.get() or CLOSE_ASK
        cfg = load_config()
        cfg["close_action"] = action
        save_config(cfg)
        self.cfg = cfg
        self._set_hint("已保存：点窗口的 × " + {
            CLOSE_ASK: "时每次询问。",
            CLOSE_WINDOW: "只关这个窗口，后台服务继续监听打印任务。",
            CLOSE_QUIT: "会连后台服务一起退出（托盘图标消失）。",
        }[action])

    def _on_close(self) -> None:
        """窗口右上角的 ×：默认问一句（可记住），也可以直接按配置里的选择办"""
        action = close_action_of(self.cfg)
        if action == CLOSE_ASK:
            prompt = ClosePrompt(self.root)
            self.root.wait_window(prompt)
            if prompt.result is None:
                return                       # 取消：窗口留着
            if prompt.remember.get():
                cfg = load_config()
                cfg["close_action"] = prompt.result
                save_config(cfg)
                self.cfg = cfg
                self.var_close.set(prompt.result)
                LOG.info("记住关闭选择：%s", prompt.result)
            action = prompt.result
        if action == CLOSE_QUIT:
            stopped = stop_daemon()
            LOG.info("配置界面里选择「退出程序」：后台服务已停 %s 个进程", stopped)
        self.root.destroy()

    # -------------------------------------------------- 测试连接（后台线程）

    def _test_connection(self) -> None:
        cfg = self._collect()
        save_config(cfg)          # 先存下来，避免测试用的账号与下次打印用的不一致
        self.cfg = cfg
        self.btn_test.configure(state="disabled")
        self._set_hint(f"正在连接 {cfg.get('server')} …")
        threading.Thread(target=self._test_worker, args=(cfg,), daemon=True).start()

    def _test_worker(self, cfg: dict) -> None:
        """线程里只做网络请求，结果丢进队列交给主线程显示"""
        try:
            client = Client(cfg)
            client.health()
            token = client.login()
            info = client.balance(token)
            profile = client.profile(token).get("profile") or {}
            money = f"{info.get('balance')} 元"
            if not info.get("billable"):
                money += f"（免费账号：{info.get('free_reason') or '免计费'}）"
            else:
                money += f"，单价 {info.get('price')} 元/张"
            self.queue.put((
                "hint",
                f"连接成功：{cfg.get('username')}；余额 {money}；网站默认："
                f"{profile.get('default_delivery') or ''} / {profile.get('default_address') or '（没填）'}",
                False,
            ))
        except ApiError as exc:
            self.queue.put(("hint", f"连接失败：{exc.message}", True))
        except Exception as exc:                      # 兜底，别让线程静默死掉
            self.queue.put(("hint", f"连接失败：{exc}", True))
        finally:
            self.queue.put(("enable_test", "", False))

    # -------------------------------------------------- 打印机队列（一键安装 / 卸载）

    def _install_printer(self) -> None:
        """一键安装：由程序发起 UAC 提权，用管理员身份再跑一遍自己建队列"""
        import vp_printer

        if not vp_printer.ask_yes_no(
            "AntiPrint 虚拟打印机",
            "要在本机安装虚拟打印机「ANTIPRINT」吗？\n\n"
            "接下来会弹出管理员授权窗口（UAC），点「是」即可。\n"
            "装好后任意程序都能在打印对话框里选到它。",
        ):
            return
        self.btn_install.configure(state="disabled")
        self._set_hint("正在安装…（请在 UAC 窗口里点「是」）")
        threading.Thread(target=self._printer_worker, args=("install",), daemon=True).start()

    def _uninstall_printer(self) -> None:
        import vp_printer

        if not vp_printer.ask_yes_no(
            "AntiPrint 虚拟打印机",
            "要删除虚拟打印机「ANTIPRINT」吗？\n\n"
            "删掉之后就打印不了（要恢复就再点一次「安装」）。\n"
            "程序本身不动：不想要了直接删掉装它的文件夹即可。",
        ):
            return
        self._set_hint("正在卸载…（请在 UAC 窗口里点「是」）")
        threading.Thread(target=self._printer_worker, args=("uninstall",), daemon=True).start()

    def _create_shortcut(self) -> None:
        """在桌面上放一个快捷方式（可选）：没装 Python 的用户不用每次去翻解压出来的文件夹"""
        if shortcut_exists():
            self._set_hint("桌面上已经有「AntiPrint 虚拟打印机」快捷方式了。")
            return
        ok, message = create_desktop_shortcut()
        self._set_hint(message, not ok)

    def _restart_daemon(self) -> None:
        """重启后台服务（= 结束旧实例再起一个）。

        为什么需要它：Windows 的通知区偶尔会把托盘图标整条丢掉（尤其是一晚上被"接管"了好几次、
        留下幽灵图标之后），图标没了就点不到托盘菜单 —— 这个按钮是**不看托盘也能用**的入口。
        配置界面本身可以从「双击 exe」打开，所以这条路一定走得通。"""
        self._set_hint("正在重启后台服务…")
        threading.Thread(target=self._restart_worker, daemon=True).start()

    def _restart_worker(self) -> None:
        import vp_printer
        from vp_platform import launch_argv, stop_other_instances

        try:
            stopped = stop_other_instances()
            time.sleep(1.0)                       # 等旧实例退出、锁释放
            subprocess.Popen(launch_argv())       # 起一个新的守护进程（它会挂托盘图标）
            time.sleep(2.5)
            message = (f"已重启后台服务（结束 {stopped} 个旧进程）；"
                       f"托盘图标应该回来了 —— 在右下角「显示隐藏的图标」里找 AntiPrint。")
            if not daemon_running():
                message = "后台服务还没起来，可能是配置有问题：看一眼「打开日志」，或双击 start-vprinter.bat 再试。"
            self.queue.put(("hint", message, not daemon_running()))
        except Exception as exc:                  # 兜底，别让线程静默死掉
            self.queue.put(("hint", f"重启失败：{exc}", True))
        finally:
            self.queue.put(("refresh", "", False))

    def _printer_worker(self, action: str) -> None:
        """后台等提权子进程结束（UAC 期间不能卡住界面），结果丢回队列让主线程显示"""
        import vp_printer

        flag = "--install-printer" if action == "install" else "--uninstall-printer"
        try:
            ok, message = vp_printer.elevate_and_wait([flag])
        except Exception as exc:                      # 提权本身失败也别让线程静默死掉
            ok, message = False, f"操作失败：{exc}"
        self.queue.put(("hint", message, not ok))
        self.queue.put(("refresh", "", False))

    # -------------------------------------------------- 状态

    def _refresh_status(self) -> None:
        cfg = load_config()
        printer = str(cfg.get("printer_name") or "")
        installed = queue_exists(printer, refresh=True)   # 用户点了刷新/刚装完，要最新状态
        detail = queue_detail(printer)
        running = daemon_running()
        dot = "●"
        lines = [
            f"{dot} 虚拟打印机队列：{printer} —— " + (
                f"已安装（{detail}）" if installed and detail
                else ("已安装" if installed else "还没装：点左边「一键安装打印机队列」（需要管理员授权）")
            ),
            f"{dot} 守护进程：{'运行中' if running else '未运行（双击 start-vprinter.bat 启动）'}"
            f"{'，已暂停监听' if cfg.get('paused') else ''}",
            f"{dot} 数据目录（{DATA_MODE}）：{CONFIG_PATH.parent}",
            f"{dot} 收件目录：{INBOX_DIR}",
        ]
        if cfg.get("token_user"):
            lines.append(f"{dot} 最近登录账号：{cfg['token_user']}")
        self.lbl_status.configure(text="\n".join(lines))

        # 首次使用提示：缺账号 / 缺队列 / 守护进程没跑，各说一句该干什么。
        # 提示条放在二级菜单下面（所有子界面都看得到），位置用 grid 的 row=2 固定。
        tips = []
        if not (cfg.get("username") and cfg.get("password")):
            tips.append("还没填账号：「网站账号」页里填服务器地址、用户名、密码，先点「测试连接」。")
        if not installed:
            tips.append(f"本机还没装「{printer}」：「运行状态」页里点「一键安装打印机队列」。")
        if not running:
            tips.append("守护进程没在跑：双击 start-vprinter.bat（或从 exe 直接启动）后在托盘里常驻。")
        mismatch = spool_mismatch(printer)
        if installed and mismatch:
            tips.append(f"队列的落盘文件还指着 {mismatch}：点「一键安装打印机队列」把它指到本程序目录"
                        "（否则打印会写进那个老文件夹，这边收不到）")
        if tips:
            self.banner.configure(text="　".join(f"· {tip}" for tip in tips))
            self.banner.grid(row=2, column=0, sticky="ew", padx=14, pady=(8, 0))
        else:
            self.banner.grid_forget()

        items = load_recent()
        self.txt_recent.configure(state="normal")
        self.txt_recent.delete("1.0", "end")
        if not items:
            self.txt_recent.insert("end", "（还没有提交记录）\n")
        for item in items[:10]:
            stamp = datetime.fromtimestamp(item.get("ts") or 0).strftime("%m-%d %H:%M:%S")
            flag = "成功" if item.get("ok") else "失败"
            self.txt_recent.insert(
                "end", f"{stamp}  [{flag}]  {item.get('file') or ''}\n      {item.get('message') or ''}\n")
        self.txt_recent.configure(state="disabled")

    def _drain_queue(self) -> None:
        """主线程轮询后台线程的结果（tkinter 不允许别的线程直接改控件）。

        窗口关掉后这个 after 回调还可能再跑一次，得先看根窗口还在不在 —— 否则 Tk 会往
        标准错误打一句 "invalid command name …"（窗口程序没控制台，但日志里会看到，容易被当成故障）。"""
        try:
            if not self.root.winfo_exists():
                return
        except tk.TclError:
            return
        while True:
            try:
                action, text, is_error = self.queue.get_nowait()
            except queue.Empty:
                break
            if action == "hint":
                self._set_hint(text, is_error)
            elif action == "enable_test":
                self.btn_test.configure(state="normal")
            elif action == "refresh":
                self.btn_install.configure(state="normal")
                self._refresh_status()
        try:
            self.root.after(200, self._drain_queue)
        except tk.TclError:          # 窗口已经销毁
            pass


def open_settings_window() -> None:
    root = tk.Tk()
    SettingsWindow(root)
    LOG.info("配置界面已打开")     # 计时/排查用：从进程启动到这行的耗时就是「打开软件」的体感
    root.mainloop()


if __name__ == "__main__":
    open_settings_window()
