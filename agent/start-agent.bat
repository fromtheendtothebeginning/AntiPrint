@echo off
setlocal
rem AntiPrint print agent - start it in the background via pythonw.exe (no console window).
rem Agent's own log: agent\log\agent.log ; redirected stdout/stderr: agent\log\agent.out.log

set "AGENT_DIR=%~dp0"
for %%I in ("%AGENT_DIR%.") do set "AGENT_DIR=%%~fI"
for %%I in ("%AGENT_DIR%\..") do set "PROJ_DIR=%%~fI"
set "VENV_PYW=%PROJ_DIR%\backend\.venv\Scripts\pythonw.exe"

if not exist "%AGENT_DIR%\log" mkdir "%AGENT_DIR%\log"

if not exist "%VENV_PYW%" (
  echo [ERROR] venv pythonw.exe not found: %VENV_PYW%
  echo         Run install-agent.bat first.
  exit /b 1
)

start "" "%VENV_PYW%" "%AGENT_DIR%\print_agent.py" >> "%AGENT_DIR%\log\agent.out.log" 2>&1
echo [INFO] Agent started in background. Log: %AGENT_DIR%\log\agent.log
endlocal
