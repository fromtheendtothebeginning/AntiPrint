@echo off
REM AntiPrint one-click setup: venv + python deps + frontend deps + build
REM NOTE: keep this file pure ASCII + CRLF (cmd.exe mangles UTF-8 Chinese here).
setlocal
cd /d "%~dp0"

echo [1/4] Python venv
if not exist "backend\.venv\Scripts\python.exe" (
  python -m venv backend\.venv || goto :err
  echo   created backend\.venv
) else (
  echo   exists, skip
)

echo [2/4] Python dependencies (aliyun mirror: tsinghua returns empty for py3.14)
backend\.venv\Scripts\python.exe -m pip install --disable-pip-version-check -q -i https://mirrors.aliyun.com/pypi/simple/ -r backend\requirements.txt || goto :err
backend\.venv\Scripts\python.exe -m pip install --disable-pip-version-check -q -i https://mirrors.aliyun.com/pypi/simple/ -r agent\requirements.txt || goto :err

echo [3/4] Frontend dependencies
pushd frontend
call npm.cmd install --no-fund --no-audit || goto :errpop
popd

echo [4/4] Frontend build (dist is served by the backend on port 8301)
pushd frontend
call npm.cmd run build || goto :errpop
popd

echo.
echo Setup OK.
echo   1) edit  agent\config.json   (paste the agent token from the admin page)
echo   2) run   run.bat             (backend http://127.0.0.1:8301)
echo   3) dev   cd frontend ^&^& npm.cmd run dev   (http://localhost:3010)
echo.
pause
exit /b 0

:errpop
popd
:err
echo.
echo [FAILED] see messages above.
pause
exit /b 1
