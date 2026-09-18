@echo off
chcp 65001 >nul
cd /d "%~dp0"
if "%~1"=="" (
 echo Keo thu muc sao luu vao file nay.
 pause
 exit /b 1
)
"runtime\node.exe" scripts\client-control.mjs restore "%~1"
pause
