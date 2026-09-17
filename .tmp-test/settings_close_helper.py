# -*- coding: utf-8 -*-
"""从另一个进程调产品代码「列出/关闭配置界面窗口」（临时脚本，不算交付代码）。

为什么要单独一个文件：产品的匹配规则是「命令行里带 --settings」，
如果把这些字面量塞进 `python -c "..."`，调用者自己的命令行就会命中规则而被自己停掉。
文件方式的命令行只有脚本路径，干净。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "vprinter"))

import vp_platform   # noqa: E402

# 匹配规则按「本程序这一形态」算：exe 形态 = AntiPrintVPrinter.exe，源码形态 = python* 跑 virtual_printer.py。
# 这个 helper 跑在源码 python 里，但验的是**分发包 exe** 的窗口，所以要先冒充成 exe 形态。
if "--frozen" in sys.argv:
    vp_platform.IS_FROZEN = True

args = [a for a in sys.argv[1:] if not a.startswith("--")]
action = args[0] if args else "list"
if action == "list":
    print(json.dumps(vp_platform.settings_window_pids()))
else:
    print(json.dumps(vp_platform.close_settings_windows()))
