@echo off
echo.
echo ════════════════════════════════════════════════════════
echo  NSE F^&O Signal Engine - Starting...
echo ════════════════════════════════════════════════════════
echo.

REM Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ ERROR: Node.js not found!
    echo.
    echo Please install Node.js from https://nodejs.org
    echo Download the LTS version and install it.
    echo.
    pause
    exit /b 1
)

REM Show Node version
echo ✅ Node.js found:
node --version
echo.

REM Install deps if needed
if not exist node_modules (
    echo Installing dependencies (first time only)...
    call npm install
    echo.
)

REM Start server
echo Starting proxy server on http://localhost:3001
echo Opening dashboard...
echo.
timeout /t 2 /nobreak
start "" "http://localhost:3001/index.html"

echo.
echo ════════════════════════════════════════════════════════
echo  ✅ SERVER RUNNING - Keep this window open
echo  Press Ctrl+C to stop
echo ════════════════════════════════════════════════════════
echo.

node server.js
pause
