# cover.py — 任务信息页（封面页）：每次出纸前先打一张
#
# 为什么要它：线下交付时纸张上没有收件信息，管理员得对着屏幕找。这张页包含
# 提交人、文件名、配送方式与地址、提交时间、打印时间——一页纸说清「这是给谁的、打的是什么」。
#
# 怎么生成：先在内存里拼一份 RTF（纯文本格式，CJK 用 \uNNNN? 转义），
# 再交给已有的转换链路（生产 LibreOffice / 本机 Word）转成 PDF，代理直接用 SumatraPDF 打。
# 复用 convert.py 的两个后端，不额外引入依赖，也不需要在打印那台机器上装任何东西。

import logging
import time
from pathlib import Path

import config
import constants
import convert

LOG = logging.getLogger("antiprint.cover")

LABEL_WIDTH = 12


def _esc(text) -> str:
    """RTF 转义：ASCII 原样，其余按 \\uNNNN? 走（负值补码按 RTF 规定处理）"""
    out = []
    for ch in str(text or ""):
        code = ord(ch)
        if ch in "\\{}":
            out.append("\\" + ch)
        elif 32 <= code < 127:
            out.append(ch)
        else:
            if code > 32767:                     # RTF 的 \u 是有符号 16 位
                code -= 65536
            out.append(f"\\u{code}?")
    return "".join(out)


def _line(label: str, value: str, size: int = 22, bold: bool = False) -> str:
    """一行「标签：值」（标签固定宽度，值里换行会由 RTF 折行）"""
    weight = "\\b " if bold else ""
    return f"\\pard\\fi0\\li0\\f0\\fs{size}{weight}{_esc(label + '：')}{_esc(value)}\\b0\\par\n"


def build_rtf(job: dict, printed_at: str) -> str:
    """拼任务信息页的 RTF（一页：标题 + 若干行）"""
    files = [item.get("filename") or "" for item in (job.get("files") or [])]
    address = (job.get("address") or "").strip() or "（取件，未填地址）"
    note = (job.get("note") or "").strip()
    head = (
        "{\\rtf1\\ansi\\ansicpg936\\deff0"
        "{\\fonttbl{\\f0\\fnil\\fcharset134 Microsoft YaHei;}}"
        "\\viewkind4\\uc1\n"
        "\\pard\\qc\\f0\\fs36\\b " + _esc("AntiPrint 打印任务信息") + "\\b0\\par\n"
        "\\pard\\qc\\f0\\fs20 " + _esc("—————————————————————") + "\\par\n"
    )
    body = [
        _line("任务号", f"#{job.get('id')}", 24, True),
        _line("提交人", job.get("username") or f"用户 #{job.get('user_id')}"),
        _line("文件", "、".join(files) if files else "（无文件）"),
        _line("份数", str(job.get("copies") or 1)),
        _line("配送方式", job.get("delivery_mode") or constants.DELIVER),
        _line("配送地址", address),
    ]
    if note:
        body.append(_line("备注", note))
    body += [
        _line("提交时间", str(job.get("created_at") or "—").replace("T", " ")),
        _line("打印时间", printed_at),
    ]
    tail = "\\pard\\qc\\f0\\fs18 " + _esc("本页为任务信息页，由 AntiPrint 打印代理自动生成") + "\\par\n}"
    return head + "".join(body) + tail


def render(job: dict) -> Path:
    """生成任务信息页 PDF；返回文件路径（每次调用都重新生成，好让「打印时间」是当下的）"""
    printed_at = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
    rtf = build_rtf(job, printed_at)
    config.COVER_DIR.mkdir(parents=True, exist_ok=True)
    # 文件名带任务号与时间戳：内容每次都是新的，不用管缓存
    stamp = time.strftime("%H%M%S", time.localtime())
    src = config.COVER_DIR / f"job-{job.get('id')}-{stamp}.rtf"
    pdf = config.COVER_DIR / f"job-{job.get('id')}-{stamp}.pdf"
    src.write_text(rtf, encoding="ascii", errors="ignore")   # 已全部转义为 ASCII
    try:
        convert.convert_to_pdf(src, pdf)
    finally:
        src.unlink(missing_ok=True)          # 中间产物不留
    LOG.info("任务 #%s 生成信息页：%s（%s 字节）", job.get("id"), pdf.name, pdf.stat().st_size)
    return pdf
