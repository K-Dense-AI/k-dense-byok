@echo off
rem Memorable launcher alias. start.cmd remains supported for compatibility.
setlocal
cd /d "%~dp0"
call start.cmd %*
exit /b %errorlevel%
