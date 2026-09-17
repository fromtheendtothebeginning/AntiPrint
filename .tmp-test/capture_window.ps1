# 临时脚本（验收用）：截取标题包含某个关键词的窗口，存成 PNG。
# 用法：powershell -File capture_window.ps1 -Match AntiPrint -Out D:\tmp\win.png
param([string]$Match = "AntiPrint", [string]$Out = "window.png")

Add-Type -AssemblyName System.Drawing
$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinCap {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr Find(string needle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) { return true; }
      var sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      if (sb.ToString().Contains(needle)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
Add-Type -TypeDefinition $sig

$hwnd = [WinCap]::Find($Match)
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "WINDOW_NOT_FOUND"; exit 1 }

# 先把这个窗口拉到最前，免得被别的窗口挡住（截出来一半是别的东西）
[void][WinCap]::ShowWindow($hwnd, 9)
[void][WinCap]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 700

$rect = New-Object WinCap+RECT
[void][WinCap]::GetWindowRect($hwnd, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
Write-Output ("WINDOW_RECT=" + $rect.Left + "," + $rect.Top + "," + $width + "x" + $height)

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
# PrintWindow 能抓到「被别的窗口挡住」的窗口内容（CopyFromScreen 只能抓屏幕可见部分）
$hdc = $graphics.GetHdc()
$ok = [WinCap]::PrintWindow($hwnd, $hdc, 2)   # 2 = PW_RENDERFULLCONTENT
$graphics.ReleaseHdc($hdc)
if (-not $ok) { $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size) }
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output ("SAVED=" + $Out)
