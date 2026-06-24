@echo off
REM ChoirFlow launcher (Windows, cmd.exe wrapper).
REM
REM This file is just a thin shim so users can double-click `start.bat` from
REM Explorer. All real logic lives in `start.ps1` next to it.
REM
REM We invoke PowerShell with:
REM   -NoProfile           : skip user profile (faster, predictable env).
REM   -ExecutionPolicy Bypass : avoid the "running scripts is disabled" error
REM                            without changing the machine policy.
REM   -File <path>         : run the script as a file (so $MyInvocation works).
REM
REM Any extra arguments passed to start.bat are forwarded to start.ps1 (e.g.
REM `start.bat -NoBrowser`).

setlocal
set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start.ps1" %*
set "EXITCODE=%ERRORLEVEL%"
endlocal & exit /b %EXITCODE%
