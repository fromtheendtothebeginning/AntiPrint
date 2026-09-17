# 临时验收脚本（不算交付代码）：起一次真配置界面，截两张图 —— ①界面本身 ②点 × 后的询问弹窗
# 跑法：
#   powershell -ExecutionPolicy Bypass -File .tmp-test/capture_close_prompt.ps1            # 用 dist 里的 exe
#   powershell -ExecutionPolicy Bypass -File .tmp-test/capture_close_prompt.ps1 -Source    # 源码形态（改完界面先看效果，不用等打包）
param([string]$Exe = "D:\anticraft\AntiPrint\dist\AntiPrintVPrinter\AntiPrintVPrinter.exe", [switch]$Source)

$ErrorActionPreference = "Stop"
$repo = "D:\anticraft\AntiPrint"
$work = Join-Path $env:TEMP ("vp-shot-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
$env:ANTIPRINT_VPRINTER_HOME = Join-Path $work "home"
New-Item -ItemType Directory -Path $env:ANTIPRINT_VPRINTER_HOME | Out-Null
$env:ANTIPRINT_VPRINTER_NO_GUI = "1"          # 别让首次引导再开一个窗口
$out_dir = Join-Path $repo ".tmp-test\shots"

# 先塞一份配置：有账号 + 一个不存在的队列名 → 打开时直接停在「运行状态」页（截的就是它）
$cfg = @'
{
  "server": "https://print.anticraft.top",
  "username": "截图用",
  "password": "占位",
  "printer_name": "AntiPrint-不存在-截图用",
  "close_action": "ask"
}
'@
Set-Content -Path (Join-Path $env:ANTIPRINT_VPRINTER_HOME "config.json") -Value $cfg -Encoding UTF8
# PowerShell 5.1 的 -Encoding UTF8 会带 BOM，我们的 json 解析会失败（会退回默认值）——
# 所以再用 .NET 无 BOM 覆写一遍
[System.IO.File]::WriteAllText((Join-Path $env:ANTIPRINT_VPRINTER_HOME "config.json"), $cfg,
                               (New-Object System.Text.UTF8Encoding($false)))

if ($Source) {
    $file = "$repo\backend\.venv\Scripts\pythonw.exe"
    $args_ = @("$repo\vprinter\virtual_printer.py", "--settings")
    $match_cmd = "*virtual_printer.py --settings*"
    $label = "源码形态"
    $wait = 8
} else {
    $file = Join-Path $work "AntiPrintVPrinter.exe"
    Copy-Item $Exe $file
    $args_ = @("--settings")
    $match_cmd = $null                        # 按可执行文件路径匹配
    $label = "exe 形态"
    $wait = 14
}

function Mine() {
    if ($Source) { Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like $match_cmd } }
    else { Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $file } }
}

function Shot([string]$match, [string]$name) {
    $path = Join-Path $out_dir $name
    & powershell -NoProfile -ExecutionPolicy Bypass -File "$repo\.tmp-test\capture_window.ps1" -Match $match -Out $path | Out-Null
    if (Test-Path $path) { Write-Host "  截图 $name <- $match ($((Get-Item $path).Length) 字节)" }
    else { Write-Host "  [WARN] 没截到 $name（没找到标题含「$match」的窗口）" }
}

Write-Host "1) 启动配置界面（$label）：$file $args_"
$proc = Start-Process -FilePath $file -ArgumentList $args_ -PassThru
Start-Sleep -Seconds $wait
Shot "AntiPrint 虚拟打印机 · 配置" "vprinter-settings.png"

Write-Host "2) 点窗口的 × （发 WM_CLOSE）"
foreach ($p in (Mine)) {
    $g = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if ($g -and $g.MainWindowHandle -ne 0) { $g.CloseMainWindow() | Out-Null; Write-Host "  已向 PID $($p.ProcessId) 发送关闭" }
}
Start-Sleep -Seconds 3
Shot "关闭 AntiPrint 虚拟打印机" "vprinter-close-prompt.png"

Write-Host "3) 收尾：停掉本次启动的进程"
foreach ($p in (Mine)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
Write-Host "  剩余进程：$((Mine | Measure-Object).Count)（截图在 $out_dir）"
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
