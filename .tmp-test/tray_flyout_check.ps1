# 临时脚本：点开「显示隐藏的图标」浮出层，看 AntiPrint 的托盘图标是不是真的在里面。
# （Windows 11 默认把新图标收进溢出区，所以要打开这一层才看得到。）
#
# 打开方式按顺序试：UIA 的 Invoke → LegacyIAccessible 默认动作 → Toggle → 直接用鼠标点。
# 2026-09-16 实测：Win11 的溢出按钮在有些状态下不再支持 Invoke（报 "Unsupported Pattern"），
# 所以不能只靠 Invoke（不然用例会误报成「找不到图标」）。
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$UIA = [System.Windows.Automation.AutomationElement]
$root = $UIA::RootElement
$btnType = New-Object System.Windows.Automation.PropertyCondition(
    $UIA::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)

$tray = $root.FindFirst(
    [System.Windows.Automation.TreeScope]::Children,
    (New-Object System.Windows.Automation.PropertyCondition($UIA::ClassNameProperty, 'Shell_TrayWnd')))
if (-not $tray) { Write-Output 'NO_TRAY_WINDOW'; exit 1 }

$chevron = $tray.FindFirst(
    [System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition($UIA::NameProperty, '显示隐藏的图标')))
if (-not $chevron) { Write-Output 'NO_CHEVRON'; exit 1 }

function Open-Flyout($element) {
    try {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pattern.Invoke()
        return $true
    } catch { }
    try {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
        $pattern.DoDefaultAction()
        return $true
    } catch { }
    try {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        $pattern.Toggle()
        return $true
    } catch { }
    try {
        $point = $element.GetClickablePoint()
        [System.Windows.Forms.Cursor]::Position = (New-Object System.Drawing.Point([int]$point.X, [int]$point.Y))
        Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int e);' -Name Mouse -Namespace AntiPrint -PassThru | Out-Null
        [AntiPrint.Mouse]::mouse_event(0x0002, 0, 0, 0, 0)
        [AntiPrint.Mouse]::mouse_event(0x0004, 0, 0, 0, 0)
        return $true
    } catch {
        Write-Output ('OPEN_FAILED ' + $_.Exception.Message)
        return $false
    }
}

if (-not (Open-Flyout $chevron)) { Write-Output 'CANNOT_OPEN'; exit 1 }
Start-Sleep -Milliseconds 1500

$found = @()
foreach ($window in $root.FindAll(
        [System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    $cls = $window.Current.ClassName
    if ($cls -notlike '*Overflow*' -and $cls -notlike '*Notify*') { continue }
    Write-Output ('FLYOUT class=' + $cls)
    foreach ($item in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnType)) {
        Write-Output ('  icon: ' + $item.Current.Name)
        if ($item.Current.Name -like '*AntiPrint*') { $found += $item.Current.Name }
    }
}

Open-Flyout $chevron | Out-Null      # 再点一次收起
Start-Sleep -Milliseconds 400
if ($found.Count -gt 0) {
    Write-Output ('FOUND=' + ($found -join ' | '))
} else {
    Write-Output 'NOT_FOUND'
}
