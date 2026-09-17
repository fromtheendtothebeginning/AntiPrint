# -*- coding: utf-8 -*-
"""实验：msvcrt.locking(LK_NBLCK) 在别人已经锁住同一字节时，到底是立刻失败还是会等。
（daemon_running() 用它探测守护进程；如果它会阻塞，GUI/自检就会卡住 —— 2026-09-16 实际卡过一次。）
用法：先跑 A（持锁 20 秒），再跑 B 计时。
"""
import msvcrt
import sys
import time
from pathlib import Path

TARGET = Path(sys.argv[2] if len(sys.argv) > 2 else "C:/Users/86133/AppData/Local/Temp/lock-probe.lock")
mode = sys.argv[1] if len(sys.argv) > 1 else "probe"
TARGET.parent.mkdir(parents=True, exist_ok=True)

if mode == "hold":
    handle = TARGET.open("a+")
    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    print("A: 已锁住第 0 字节，保持 20 秒", flush=True)
    time.sleep(20)
    print("A: 释放退出", flush=True)
else:
    handle = TARGET.open("a+")
    started = time.time()
    try:
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        print(f"B: 居然拿到了锁（耗时 {time.time()-started:.2f} 秒）→ 探测不可靠", flush=True)
    except OSError as exc:
        print(f"B: 立刻失败（耗时 {time.time()-started:.2f} 秒）：{exc}", flush=True)
