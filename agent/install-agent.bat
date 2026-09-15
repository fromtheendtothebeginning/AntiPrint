@echo off
setlocal
rem AntiPrint print agent - one-time setup on the PC that has the printer:
rem   1) create config.json (asks for the server address / token / printer queue)
rem   2) make sure the python interpreter and deps are available
rem   3) register a logon autostart task named AntiPrintAgent
rem Works both from a distributed package (bundled runtime\) and from the repo (..\backend\.venv).

set "AGENT_DIR=%~dp0"
for %%I in ("%AGENT_DIR%.") do set "AGENT_DIR=%%~fI"

rem ---- python: bundled runtime > project venv > PATH ----
set "PY=%AGENT_DIR%\runtime\python.exe"
set "PYW=%AGENT_DIR%\runtime\pythonw.exe"
set "BUNDLED_RUNTIME=1"
if not exist "%PY%" (
  set "BUNDLED_RUNTIME="
  set "PY=%AGENT_DIR%\..\backend\.venv\Scripts\python.exe"
  set "PYW=%AGENT_DIR%\..\backend\.venv\Scripts\pythonw.exe"
)
if not exist "%PY%" (
  for %%I in (python.exe) do set "PY=%%~$PATH:I"
  for %%I in (pythonw.exe) do set "PYW=%%~$PATH:I"
)
if not exist "%PY%" (
  echo [ERROR] No python.exe found. Expected the bundled runtime in "%AGENT_DIR%\runtime",
  echo         or the project venv in "..\backend\.venv", or python.exe in PATH.
  echo         Install Python 3.9+ and re-run this script.
  pause
  exit /b 1
)

if defined BUNDLED_RUNTIME (
  echo [INFO] Using the bundled runtime ^(no pip install needed^).
) else (
  echo [INFO] Installing python deps ^(requests^) into: %PY%
  "%PY%" -m pip install -r "%AGENT_DIR%\requirements.txt"
  if errorlevel 1 (
    echo [ERROR] pip install failed - check the network, then re-run this script.
    pause
    exit /b 1
  )
)

if not exist "%AGENT_DIR%\config.json" (
  copy /y "%AGENT_DIR%\config.example.json" "%AGENT_DIR%\config.json" >nul
  echo [INFO] Created config.json from config.example.json.
)

echo.
echo Fill in the settings below ^(press Enter to keep the current value^).
echo   server      : the AntiPrint server address, e.g. http://47.100.125.150
echo   agent token : copy it from the server page "admin settings - agent token"
echo   printer     : the queue name as shown in Windows "Printers and scanners"
echo                 Enter = keep current value, "default" = system default printer
echo.
set "CFG_SERVER="
set "CFG_TOKEN="
set "CFG_PRINTER="
set /p "CFG_SERVER= server      : "
set /p "CFG_TOKEN= agent token : "
set /p "CFG_PRINTER= printer     : "
powershell -NoProfile -ExecutionPolicy Bypass -File "%AGENT_DIR%\apply-config.ps1" -ConfigPath "%AGENT_DIR%\config.json"
if errorlevel 1 (
  echo [ERROR] Could not update config.json. Fix it with a text editor and re-run this script.
  pause
  exit /b 1
)

echo [INFO] Registering the logon autostart task AntiPrintAgent ...
schtasks /Create /TN AntiPrintAgent /TR "\"%PYW%\" \"%AGENT_DIR%\print_agent.py\"" /SC ONLOGON /RL HIGHEST /F
if errorlevel 1 (
  rem /RL HIGHEST needs Administrator; printing itself does not, so retry without it
  echo [WARN] /RL HIGHEST failed - retrying without elevation ...
  schtasks /Create /TN AntiPrintAgent /TR "\"%PYW%\" \"%AGENT_DIR%\print_agent.py\"" /SC ONLOGON /F
)
if errorlevel 1 (
  echo [ERROR] schtasks failed - re-run install-agent.bat as Administrator, or put a shortcut
  echo         to the line below into the Startup folder ^(shell:startup^):
  echo         "%PYW%" "%AGENT_DIR%\print_agent.py"
  pause
  exit /b 1
)

echo.
echo [INFO] Done. Next steps:
echo        1^) check-agent.bat  - self test: local printers + server heartbeat + SumatraPDF
echo        2^) start-agent.bat  - start the agent in the background
pause
endlocal
