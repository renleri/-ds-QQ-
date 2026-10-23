@echo off
title QQ Console (whale)
cd /d "%~dp0"

rem If the console server is already listening, just open the browser.
netstat -ano | findstr /c:":3110 " >nul 2>&1
if %errorlevel%==0 (
  echo Console already running - opening browser...
  start "" "http://127.0.0.1:3110/"
  exit /b 0
)

echo Starting console server on http://127.0.0.1:3110/ ...
start "" "http://127.0.0.1:3110/"
"C:\Program Files\nodejs\node.exe" server.mjs

echo.
echo [console server exited] Press any key to close this window ...
pause >nul
