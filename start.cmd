@echo off
rem Thin wrapper: make sure Node exists, then hand off to the cross-platform
rem launcher (start.mjs). macOS/Linux users run start.sh instead.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js not found. Install Node.js 22 or newer from https://nodejs.org/
    echo ^(or run: winget install OpenJS.NodeJS.LTS^), reopen this terminal,
    echo then run start.cmd again.
    exit /b 1
)

node start.mjs %*
exit /b %errorlevel%
