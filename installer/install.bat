@echo off
chcp 65001 >nul 2>&1
title Forward Search Installer

set "PS1=%~dp0install.ps1"

if not exist "%PS1%" (
    echo.
    echo   [ERROR] install.ps1 not found next to this file.
    echo   Please extract the whole zip first, then run this again.
    echo.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"

if errorlevel 1 (
    echo.
    echo   Installer exited with an error.
    pause
)
