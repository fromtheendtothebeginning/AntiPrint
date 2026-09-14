@echo off
setlocal
rem AntiPrint print agent - one-time setup:
rem   1) create agent\config.json from config.example.json
rem   2) install python deps into ..\backend\.venv
rem   3) register a logon autostart task named AntiPrintAgent

set "AGENT_DIR=%~dp0"
for %%I in ("%AGENT_DIR%.") do set "AGENT_DIR=%%~fI"
for %%I in ("%AGENT_DIR%\..") do set "PROJ_DIR=%%~fI"
set "VENV_PY=%PROJ_DIR%\backend\.venv\Scripts\python.exe"
set "VENV_PYW=%PROJ_DIR%\backend\.venv\Scripts\pythonw.exe"

if not exist "%AGENT_DIR%\config.json" (
  copy /y "%AGENT_DIR%\config.example.json" "%AGENT_DIR%\config.json" >nul
  echo [INFO] Created agent\config.json - open it and paste the agent token first.
  echo        The token is shown on the server admin settings page.
  pause
)

if not exist "%VENV_PY%" (
  echo [ERROR] venv not found: %VENV_PY%
  echo         Please create it manually first, for example:
  echo             python -m venv "%PROJ_DIR%\backend\.venv"
  echo         Or run the project setup.bat that builds the backend venv.
  exit /b 1
)

echo [INFO] Installing python deps into backend venv ...
"%VENV_PY%" -m pip install -r "%AGENT_DIR%\requirements.txt"
if errorlevel 1 (
  echo [ERROR] pip install failed. Check the network or install requests manually.
  exit /b 1
)

echo [INFO] Registering logon autostart task AntiPrintAgent ...
schtasks /Create /TN AntiPrintAgent /TR "\"%VENV_PYW%\" \"%AGENT_DIR%\print_agent.py\"" /SC ONLOGON /RL HIGHEST /F
if errorlevel 1 (
  rem /RL HIGHEST needs Administrator; printing itself does not, so retry without it
  echo [WARN] /RL HIGHEST failed - retrying without elevation ...
  schtasks /Create /TN AntiPrintAgent /TR "\"%VENV_PYW%\" \"%AGENT_DIR%\print_agent.py\"" /SC ONLOGON /F
)
if errorlevel 1 (
  echo [ERROR] schtasks failed - run install-agent.bat as Administrator.
  exit /b 1
)

echo [INFO] Install finished. Start the agent now with start-agent.bat
endlocal
