@echo off
rem ===========================================================================
rem  spinlens - one-click launcher
rem  Double-click this file: it opens a console window, starts the web service
rem  (plus the optional local model service, if Python + weights are present),
rem  then opens the browser.
rem  Close this console window (X or Ctrl+C) = both services stop, VRAM freed.
rem
rem  NOTE: this file must stay ASCII-only with CRLF line endings.
rem  A UTF-8 or LF-only .cmd makes cmd.exe mis-parse and the window flashes shut
rem  before the final pause. The Chinese window title is set by launch.cjs
rem  (process.title) instead, which is encoding-safe.
rem ===========================================================================
chcp 65001 >nul
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
