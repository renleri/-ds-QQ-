@echo off
REM ================================================================
REM  Pure-ASCII wrapper for the qq-bridge one-click launcher.
REM
REM  All real logic lives in scripts\start-all.ps1.
REM  Reason: cmd.exe mangles this file when it contains UTF-8 Chinese,
REM  emoji or box-drawing characters (observed: the script started the
REM  bridge but produced no console output at all and behaved oddly at
REM  the tail). PowerShell handles UTF-8 reliably, so it does the work.
REM
REM  Usage:
REM    double-click this file, or the desktop shortcut
REM    powershell -File scripts\start-all.ps1 -DryRun     (health check only)
REM ================================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-all.ps1" %*
if errorlevel 1 pause
