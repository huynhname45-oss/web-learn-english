@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0..\..\scripts\release-local.mjs" (
 call "%~dp0..\..\Cap-nhat-GitHub.cmd"
 exit /b
)
echo Hay phat hanh tu Cap-nhat-GitHub.cmd trong thu muc code D:\web-hoc-av.
pause
