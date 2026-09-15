# convert.py — Office（Word / PPT）转 PDF：结果按 sha256 缓存
#
# 为什么放服务端：提交人要在**提交前**就预览到内容（提交页第一步），只有服务端能转换。
# 两个后端，按可用性自动挑（都不需要 pywin32）：
#   ① LibreOffice headless（跨平台，生产 = 阿里云 Linux 上走这条；Windows 装了也能用）
#   ② Microsoft Office COM（仅 Windows，用 PowerPoint/Word 自己的导出 PDF；本机开发/验收用）
# 缓存目录 data/converted/<sha256>.pdf 内容寻址：同一份文件重复上传/预览只转一次，
# 预览与打印都取这一份 PDF（打印代理拿到的就是 PDF，无需自己转换）。

import hashlib
import logging
import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

import config
import constants

LOG = logging.getLogger("antiprint.convert")

# LibreOffice 常见安装位置（PATH 与 SOFFICE_PATH 都找不到时兜底）
_CANDIDATES = (
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    "/usr/bin/soffice",
    "/usr/local/bin/soffice",
    "/usr/lib/libreoffice/program/soffice",
    "/opt/libreoffice/program/soffice",
    "/snap/bin/libreoffice",
)

# 转换一次只跑一个（LibreOffice 单实例上百 MB；Office COM 更不该并发抢前台进程）
_LOCK = threading.Lock()
# Office COM 的单次超时（秒）：正常几秒；卡住时尽快放弃并复位，别让后续转换陪跑
COM_TIMEOUT = 90
_soffice_cache: list[str | None] = []      # 缓存查找结果：[] = 未查找过，[None] = 找过但没有
_powershell_cache: list[str | None] = []

INSTALL_HINT = (
    "服务器上没有可用的 Office 转换器：请安装 LibreOffice"
    "（Linux：apt-get install -y --no-install-recommends libreoffice-writer libreoffice-impress；"
    "Windows：winget install TheDocumentFoundation.LibreOffice），"
    "或用环境变量 SOFFICE_PATH 指定 soffice 路径；Windows 上装了 Microsoft Office 也可直接使用。"
)

# Microsoft Office COM 导出 PDF 脚本体：PowerPoint 走 SaveAs(ppSaveAsPDF=32)，Word 走 ExportAsFixedFormat(17)。
# 三条实战经验（2026-09-15 在本机反复踩过，勿改回去）：
#   ① **输出路径必须在 Python 侧算好、以字面量传给脚本**：脚本里用 Join-Path 拼出来的路径
#      （值完全一样！）会让 ExportAsFixedFormat 静默卡死到超时。
#   ② 别设 Word 的 DisplayAlerts；别用 `powershell -File 脚本文件`（同样会卡死，`-Command` 内联才正常）。
#   ③ 收尾 Quit 必须包 try/catch：Quit 报错会留下无窗口的僵尸 WINWORD，下一次 COM 转换就卡死。
_OFFICE_COM_SCRIPT = r"""$ErrorActionPreference = 'Stop'
if ($Ext -eq '.ppt' -or $Ext -eq '.pptx') {
    $app = New-Object -ComObject PowerPoint.Application
    try {
        $pres = $app.Presentations.Open($Src, $true, $false, $false)
        $pres.SaveAs($Out, 32)
        $pres.Close()
    } finally { try { $app.Quit() } catch { } }
} else {
    $app = New-Object -ComObject Word.Application
    try {
        $app.Visible = $false
        $doc = $app.Documents.Open($Src, $false, $true)
        $doc.ExportAsFixedFormat($Out, 17)
        $doc.Close(0)
    } finally { try { $app.Quit() } catch { } }
}
if (-not (Test-Path $Out)) { throw 'Office 未能导出 PDF' }
"""


def _ps_quote(value) -> str:
    """Python 字符串 → PowerShell 单引号字面量（路径里可能有空格/中文；单引号本身翻倍转义）"""
    return "'" + str(value).replace("'", "''") + "'"


class ConvertError(RuntimeError):
    """转换失败；消息是可以直接展示给用户的中文。"""


def is_office(filename: str | None) -> bool:
    """是否是「需要先转 PDF」的 Office 文件（按扩展名判断）"""
    return Path(str(filename or "")).suffix.lower() in constants.OFFICE_EXT


def find_soffice() -> str | None:
    """按 SOFFICE_PATH → PATH → 常见安装位置 查找 LibreOffice 可执行文件（结果缓存）"""
    if _soffice_cache:
        return _soffice_cache[0]
    found = (os.environ.get("SOFFICE_PATH") or "").strip() or shutil.which("soffice") or ""
    if not found:
        found = next((path for path in _CANDIDATES if os.path.isfile(path)), "")
    _soffice_cache.append(found or None)
    if found:
        LOG.info("Office 转换器：LibreOffice（%s）", found)
    return _soffice_cache[0]


def find_powershell() -> str | None:
    """Windows 上用 PowerShell 驱动 Office COM（仅当本机装有 Microsoft Office 时才真正可用）"""
    if os.name != "nt":
        return None
    if _powershell_cache:
        return _powershell_cache[0]
    _powershell_cache.append(shutil.which("powershell") or shutil.which("powershell.exe"))
    return _powershell_cache[0]


def converted_path(sha256: str) -> Path:
    """转换结果缓存路径（内容寻址：同一份文件共用一份 PDF）"""
    return config.CONVERTED_DIR / f"{str(sha256 or '').strip().lower()}.pdf"


def drop_cached(sha256: str) -> None:
    """删除某份文件的转换缓存（任务被删除且没有其它任务引用时调用）；失败只记日志"""
    try:
        converted_path(sha256).unlink(missing_ok=True)
    except OSError as exc:                                  # pragma: no cover - 磁盘异常
        LOG.warning("删除转换缓存 %s 失败：%s", sha256, exc)


def _run(command: list[str], cwd: Path, timeout: int) -> subprocess.CompletedProcess:
    """跑转换子进程：带超时、隐藏窗口（pythonw 下不闪黑窗）"""
    return subprocess.run(
        command,
        capture_output=True,
        timeout=timeout,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        cwd=str(cwd),
    )


def _timeout(soffice: str | None) -> int:
    """超时上限：LibreOffice 首次启动 + 大文档给足；Office COM 一般几秒，卡住就尽快放弃"""
    return config.CONVERT_TIMEOUT if soffice else COM_TIMEOUT


def reset_office_state() -> None:
    """复位 Office COM 自动化状态（只在转换失败/超时后调用）。

    为什么需要：Word/PowerPoint 自动化实例没被 Quit 干净时（脚本超时被强杀、Office 自身报错），
    遗留的「无窗口」实例会让**下一次**转换卡死到超时；强杀又会让 Word 记下「崩溃恢复」条目，
    之后每次启动都可能弹恢复面板同样卡住。所以这里三件事一起做：
      ① 用 GetActiveObject 找到正在跑的实例，礼貌 Close + Quit（不留崩溃记录）；
      ② 兜底把仍然「没有窗口」的 WINWORD/POWERPNT 进程杀掉（用户自己开的 Word 有窗口，不会误杀）；
      ③ 清掉 Word 的崩溃恢复残留（HKCU，Word 自己会重建）。
    """
    if os.name != "nt":
        return
    powershell = find_powershell()
    if not powershell:
        return
    script = (
        "foreach ($progId in @('Word.Application','PowerPoint.Application')) {\n"
        "  try {\n"
        "    $app = [Runtime.InteropServices.Marshal]::GetActiveObject($progId)\n"
        "    try { foreach ($d in @($app.Documents)) { $d.Close(0) } } catch { }\n"
        "    try { foreach ($p in @($app.Presentations)) { $p.Close() } } catch { }\n"
        "    try { $app.Quit() } catch { }\n"
        "  } catch { }\n"
        "}\n"
        "Get-Process WINWORD,POWERPNT -ErrorAction SilentlyContinue |\n"
        "  Where-Object { $_.MainWindowHandle -eq 0 } | ForEach-Object { $_.Kill() }\n"
        "Remove-Item 'HKCU:\\Software\\Microsoft\\Office\\16.0\\Word\\Resiliency\\DocumentRecovery' "
        "-Recurse -Force -ErrorAction SilentlyContinue\n"
    )
    try:
        subprocess.run(
            [powershell, "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            timeout=60,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        LOG.warning("已复位 Office 自动化状态（上一次转换没有正常退出）")
    except Exception as exc:                                # pragma: no cover - 尽力而为
        LOG.warning("复位 Office 自动化状态失败：%s", exc)


def _convert_with_soffice(soffice: str, src: Path, out_dir: Path) -> None:
    """LibreOffice headless：独立用户配置目录，避免「另一个实例正在运行」与并发抢锁"""
    profile_dir = out_dir / "profile"
    _run(
        [
            soffice,
            f"-env:UserInstallation={profile_dir.as_uri()}",
            "--headless",
            "--nologo",
            "--norestore",
            "--convert-to",
            "pdf",
            "--outdir",
            str(out_dir),
            str(src),
        ],
        out_dir,
        config.CONVERT_TIMEOUT,
    )


def _convert_with_office_com(powershell: str, src: Path, out_dir: Path) -> None:
    """Microsoft Office COM：把脚本体连同参数内联给 powershell -Command 执行（三条经验见脚本上方的注释）

    只看「PDF 有没有生成」：PowerShell 退出码可能因 Office 自身的收尾报错而不为 0，
    真失败了会在下面由调用方报「未能生成 PDF」。
    """
    # 输出路径在这里算好以字面量传入：脚本内用 Join-Path 拼会让 Word 导出卡死（见 _OFFICE_COM_SCRIPT 注释）
    command_text = (
        f"$Src = {_ps_quote(src)}\n"
        f"$Out = {_ps_quote(out_dir / f'{src.stem}.pdf')}\n"
        f"$Ext = {_ps_quote(src.suffix.lower())}\n" + _OFFICE_COM_SCRIPT
    )
    result = _run(
        [powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command_text],
        out_dir,
        COM_TIMEOUT,
    )
    detail = (result.stderr or b"").decode("utf-8", "ignore").strip()
    if result.returncode != 0 and detail:
        # 退出码不为 0 也可能是 Office 收尾报错（PDF 已经出来了，下面按文件判断），所以只记日志不抛错
        LOG.info("Office COM 转换退出码 %s：%s", result.returncode, detail.splitlines()[0][:200])


def convert_to_pdf(src: Path, pdf_path: Path) -> Path:
    """把 src（Word/PPT）转成 PDF 落到 pdf_path；已有同内容缓存时直接返回。

    失败抛 ConvertError（中文消息）。转换是同步阻塞的：单文件几秒到几十秒，
    调用方要么在请求里等（上传/预览），要么自己起线程。
    """
    src, pdf_path = Path(src).resolve(), Path(pdf_path)
    if pdf_path.is_file() and pdf_path.stat().st_size > 0:
        return pdf_path
    soffice = find_soffice()
    powershell = None if soffice else find_powershell()
    if not soffice and not powershell:
        raise ConvertError(INSTALL_HINT)

    out_dir = Path(tempfile.mkdtemp(prefix="antiprint-convert-"))
    try:
        with _LOCK:
            if soffice:
                _convert_with_soffice(soffice, src, out_dir)
            else:
                _convert_with_office_com(powershell or "", src, out_dir)
        produced = out_dir / f"{src.stem}.pdf"
        if not produced.is_file():
            raise ConvertError(
                "LibreOffice 未能生成 PDF（源文件可能已损坏或加密）"
                if soffice
                else "Microsoft Office 打不开这个文件（文件已损坏、被加密，或本机没装 Word/PowerPoint）"
            )
        if produced.read_bytes()[:4] != b"%PDF":
            raise ConvertError("转换结果不是有效的 PDF")
        config.CONVERTED_DIR.mkdir(parents=True, exist_ok=True)
        # 原子落盘：并发/中断时不会留下半份 PDF 被当成缓存命中
        tmp_out = pdf_path.with_suffix(f".{os.getpid()}.part")
        shutil.move(str(produced), str(tmp_out))
        os.replace(tmp_out, pdf_path)
        LOG.info(
            "Office 转 PDF 完成：%s（%s 字节，转换器 %s）",
            pdf_path.name, pdf_path.stat().st_size, "LibreOffice" if soffice else "Office COM",
        )
        return pdf_path
    except subprocess.TimeoutExpired:
        if not soffice:
            reset_office_state()
        raise ConvertError(f"转换超时（超过 {_timeout(soffice)} 秒），文件可能过于复杂")
    except ConvertError:
        if not soffice:
            reset_office_state()
        raise
    except OSError as exc:                                  # COM 起不来 / 临时目录不可写等
        if not soffice:
            reset_office_state()
        raise ConvertError(f"无法调用转换器：{exc}")
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


def convert_bytes(content: bytes, filename: str) -> tuple[Path, str]:
    """预览用：把内存里的 Office 文件转成 PDF，返回 (缓存 PDF 路径, sha256)。

    sha256 与上传时一致 → 用户随后提交同一份文件会直接命中缓存，不再转第二次。
    """
    sha256 = hashlib.sha256(content).hexdigest()
    pdf_path = converted_path(sha256)
    if pdf_path.is_file():
        return pdf_path, sha256
    # 源文件用 sha 命名（纯 ASCII），避免中文名/特殊字符让 LibreOffice 输出名不好预测
    with tempfile.TemporaryDirectory(prefix="antiprint-src-") as tmp_dir:
        src = Path(tmp_dir) / f"{sha256[:16]}{Path(filename).suffix.lower() or '.bin'}"
        src.write_bytes(content)
        convert_to_pdf(src, pdf_path)
    return pdf_path, sha256


def pdf_for(source_path, filename: str, sha256: str) -> tuple[Path, str]:
    """取某个已落盘的 Office 文件对应的 PDF：命中缓存直接用，缺失时当场补转。

    返回 (PDF 绝对路径, 展示用文件名「原名.pdf」)。失败抛 ConvertError。
    （正常都在上传时转好了；这里的补转是缓存被手工清理时的兜底。）
    """
    source_path = Path(source_path)
    pdf_path = converted_path(sha256)
    if not pdf_path.is_file():
        LOG.info("转换缓存缺失，补转：%s", source_path.name)
        convert_to_pdf(source_path, pdf_path)
    return pdf_path, f"{Path(filename).stem}.pdf"
