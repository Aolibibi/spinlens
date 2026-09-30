@echo off
rem ===========================================================================
rem  spinlens - one-click launcher
rem  Double-click this file: it opens a console window, starts the web service
rem  (plus the optional local model service, if Python + weights are present),
rem  then opens the browser.
rem  Close this console window (X or Ctrl+C) = both services stop, VRAM freed.
rem  This file is intentionally ASCII-only, except the window title below: all other
rem  Chinese output is printed by launch.cjs (with chcp 65001), so no codepage mojibake.
rem  The title line must stay AFTER chcp 65001, otherwise cmd would garble it.
rem ===========================================================================
chcp 65001 >nul
title spinlens · 话术照妖镜
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found in PATH. Install Node.js 18+ first.
  echo         Download: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node "%~dp0launch.cjs"

echo.
echo [launcher exited] press any key to close this window.
pause >nul
