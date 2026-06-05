@echo off
set "ROOT=%~dp0"
cd /d "%ROOT%"

if not exist "%ROOT%node_modules\" (
    echo [1/3] Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo Failed to install dependencies.
        pause
        exit /b 1
    )
)

echo [2/3] Building frontend...
call npm run build
if errorlevel 1 (
    echo Build failed.
    pause
    exit /b 1
)

echo [3/3] Launching...
call npm run app
pause
