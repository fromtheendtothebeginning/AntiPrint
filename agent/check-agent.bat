@echo off
setlocal
rem AntiPrint print agent - diagnostics: list the local printer queues, then run the built-in
rem self test (config -> printers -> server heartbeat -> SumatraPDF).
rem If something looks wrong, send the output of this window to whoever runs the server.

set "AGENT_DIR=%~dp0"
for %%I in ("%AGENT_DIR%.") do set "AGENT_DIR=%%~fI"

set "PY=%AGENT_DIR%\runtime\python.exe"
if not exist "%PY%" set "PY=%AGENT_DIR%\..\backend\.venv\Scripts\python.exe"
if not exist "%PY%" for %%I in (python.exe) do set "PY=%%~$PATH:I"
if not exist "%PY%" (
  echo [ERROR] python.exe not found - run install-agent.bat first.
  pause
  exit /b 1
)

echo === local printer queues ===
"%PY%" "%AGENT_DIR%\print_agent.py" --printers
echo.
echo === self test ===
"%PY%" "%AGENT_DIR%\print_agent.py" --selftest
echo.
pause
endlocal
