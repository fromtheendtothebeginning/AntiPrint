@echo off
REM Start AntiPrint backend (port 8301) + print agent, both without console windows.
REM NOTE: keep this file pure ASCII + CRLF.
REM "start" without /b detaches fully (own process tree) - proven recipe from D:\anticraft\index.
REM If a tool session kills its children, launch through a one-shot scheduled task:
REM   schtasks /Create /TN AntiPrintRun /TR "cmd /c <repo>\run.bat" /SC ONCE /ST 00:00 /F && schtasks /Run /TN AntiPrintRun
setlocal
cd /d "%~dp0"

if not exist "backend\log" mkdir "backend\log"
if not exist "agent\log" mkdir "agent\log"

REM Absolute paths are required: stop.bat finds our processes by matching "AntiPrint" in the command line.
start "" "%~dp0backend\.venv\Scripts\pythonw.exe" "%~dp0backend\main.py"
start "" "%~dp0backend\.venv\Scripts\pythonw.exe" "%~dp0agent\print_agent.py"

timeout /t 3 /nobreak >nul

echo AntiPrint started.
echo   Backend / web UI : http://127.0.0.1:8301
echo   Frontend dev     : pushd frontend ^&^& npm.cmd run dev   then http://localhost:3010
echo   Agent log        : agent\log\agent.log
echo   Server log       : backend\log\server.log
echo.
