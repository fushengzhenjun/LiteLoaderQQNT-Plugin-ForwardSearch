@echo off
chcp 65001 >nul 2>&1
title Forward Search Uninstaller

set "PS1=%~dp0uninstall.ps1"

if not exist "%PS1%" (
    echo.
    echo   [ERROR] uninstall.ps1 not found next to this file.
    echo.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"

if errorlevel 1 (
    echo.
    echo   Uninstaller exited with an error.
    pause
)
