@echo off
REM ================================================================
REM  qq-bridge restart - pure-ASCII wrapper.
REM
REM  This used to be a UTF-8 batch file full of Chinese text and heavy
REM  PowerShell one-liners. cmd.exe handles that unreliably, and the old
REM  version additionally killed processes by matching command-line TEXT
REM  with an absolute path - which matched nothing for a process started
REM  as `node src\bridge.js` (relative), so it never stopped the old
REM  instance. It also risked killing unrelated processes, because the
REM  DSH sandbox runner embeds the whole script body in its command line.
REM
REM  scripts\start-all.ps1 already does the safe takeover (state\bridge.lock
REM  PID + node.exe name check) AND makes sure SnowLuma is running, so
REM  restart is just "run the launcher".
REM
REM  Usage: double-click, or  restart.bat
REM         powershell -File scripts\start-all.ps1 -DryRun   (health check)
REM ================================================================
echo Restarting qq-bridge (stopping the old instance, then starting a new one)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-all.ps1" %*
if errorlevel 1 pause
