@echo off
setlocal
rem AntiPrint virtual printer - stop it (tray app + its watcher).
rem
rem PowerShell CIM is used because a windowed exe / pythonw.exe has no console window, so
rem taskkill by window title cannot work (same reason as stop-agent.bat). Only our own
rem processes are touched: AntiPrintVPrinter.exe, plus python processes whose command line
rem mentions virtual_printer. The print agent is left alone.

powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'AntiPrintVPrinter.exe' -or ($_.Name -like 'python*' -and $_.CommandLine -like '*virtual_printer*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
if errorlevel 1 (
  echo [ERROR] Failed to stop the virtual printer. Run stop-vprinter.bat as Administrator.
  exit /b 1
)

echo [INFO] Done. The tray icon is gone; spooled files stay in the inbox folder until the next start.
endlocal
