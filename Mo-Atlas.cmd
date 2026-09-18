@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "ATLAS_SEED_REPOSITORY=%~dp0"
start "" "%~dp0AtlasEnglish.exe"
