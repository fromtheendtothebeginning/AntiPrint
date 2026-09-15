@echo off
setlocal
rem AntiPrint print agent - start it in the background via pythonw.exe (no console window).
rem Python resolution: bundled runtime\pythonw.exe -> ..\backend\.venv -> PATH.
rem Agent's own log: log\agent.log (pythonw has no stdout/stderr, so nothing is redirected --
rem redirecting to a fixed file would break this script while another agent holds it open).

set "AGENT_DIR=%~dp0"
for %%I in ("%AGENT_DIR%.") do set "AGENT_DIR=%%~fI"

set "PYW=%AGENT_DIR%\runtime\pythonw.exe"
if not exist "%PYW%" set "PYW=%AGENT_DIR%\..\backend\.venv\Scripts\pythonw.exe"
if not exist "%PYW%" for %%I in (pythonw.exe) do set "PYW=%%~$PATH:I"
if not exist "%PYW%" (
  echo [ERROR] pythonw.exe not found - run install-agent.bat first.
  pause
  exit /b 1
)

if not exist "%AGENT_DIR%\log" mkdir "%AGENT_DIR%\log"

start "" "%PYW%" "%AGENT_DIR%\print_agent.py"
echo [INFO] Agent started in the background.
echo [INFO] Log: %AGENT_DIR%\log\agent.log  ^(already running? the log says so - one agent per PC^)
endlocal
