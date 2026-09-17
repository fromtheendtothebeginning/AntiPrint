# 临时脚本（验收用）：把 exe 里嵌的图标资源导出成 PNG，用来核对「exe 图标 == 网站 logo」。
param([string]$Exe = "", [string]$Out = "exe-icon.png")
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Exe)
$bitmap = $icon.ToBitmap()
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("EXE_ICON=" + $bitmap.Width + "x" + $bitmap.Height + " -> " + $Out)
$bitmap.Dispose(); $icon.Dispose()
