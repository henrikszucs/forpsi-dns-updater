@echo off
rem Headless DNS Updater CLI. Uses Node.js if installed, otherwise the bundled
rem Electron runtime in plain-Node mode (no window, no desktop needed).
setlocal
where node >nul 2>nul
if %errorlevel%==0 (
    node "%~dp0resources\app\src\cli.js" %*
) else (
    set ELECTRON_RUN_AS_NODE=1
    "%~dp0dns-updater.exe" "%~dp0resources\app\src\cli.js" %*
)
exit /b %errorlevel%
