# 临时脚本（验收用）：看一眼 Windows 右下角通知区域里有没有我们的托盘图标，以及某个窗口在不在。
# 用法：
#   powershell -File tray_check.ps1                    列通知栏按钮
#   powershell -File tray_check.ps1 -Match AntiPrint    只列标题含 AntiPrint 的顶层窗口
# 输出里找 TRAY_BUTTONS= / HOST / WINDOW_TITLE= 这几行。
param([string]$Match = "")

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$UIA = [System.Windows.Automation.AutomationElement]
$root = $UIA::RootElement
$tray = $root.FindFirst(
    [System.Windows.Automation.TreeScope]::Children,
    (New-Object System.Windows.Automation.PropertyCondition($UIA::ClassNameProperty, 'Shell_TrayWnd')))

if ($tray) {
    $btnType = New-Object System.Windows.Automation.PropertyCondition(
        $UIA::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    $buttons = $tray.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnType)
    Write-Output ("TRAY_BUTTONS=" + $buttons.Count)
    foreach ($item in $buttons) {
        if ($Match -eq "" -or $item.Current.Name -like "*$Match*") {
            Write-Output (" - " + $item.Current.Name)
        }
    }
} else {
    Write-Output 'NO_TRAY_WINDOW'
}

# 顶层窗口标题（Win32 GetWindowTextW）：用来确认配置窗口真的起来了
$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class WinEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  public static List<string> Titles() {
    var list = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      var sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      string t = sb.ToString();
      if (t.Length > 0) { list.Add(t); }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@
Add-Type -TypeDefinition $sig
$titles = [WinEnum]::Titles()
Write-Output ("WINDOW_TITLES=" + $titles.Count)
foreach ($title in $titles) {
    if ($Match -eq "" -or $title -like "*$Match*") {
        Write-Output ("WINDOW_TITLE=" + $title)
    }
}
