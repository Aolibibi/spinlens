@echo off
chcp 65001 >nul
cd /d "%~dp0"
title spinlens · 话术照妖镜

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有找到 Node.js。
  echo   请先到 https://nodejs.org 下载 LTS 版安装（一路下一步即可），再双击本文件。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动「话术照妖镜」网页版，浏览器会自动打开...
echo   关闭本窗口即停止服务。
echo.
node server.js --open
pause
