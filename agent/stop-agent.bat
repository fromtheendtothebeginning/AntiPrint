@echo off
setlocal
rem AntiPrint print agent - stop all running agent processes.
rem Why PowerShell CIM instead of the alternatives:
rem   - taskkill /FI "WINDOWTITLE eq *print_agent*" is unreliable: pythonw.exe has no
rem     console window, so there is no window title to match.
rem   - wmic is deprecated and already removed from recent Windows builds.
rem Only pythonw.exe processes whose command line contains print_agent are killed.

powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe'\" | Where-Object { $_.CommandLine -like '*print_agent*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
if errorlevel 1 (
  echo [ERROR] Failed to stop the agent. Run stop-agent.bat as Administrator.
  exit /b 1
)

echo [INFO] Done. All print_agent pythonw.exe processes were terminated.
endlocal
