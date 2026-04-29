#!/bin/bash
echo ""
echo "════════════════════════════════════════════════════════"
echo " NSE F&O Signal Engine - Starting..."
echo "════════════════════════════════════════════════════════"
echo ""

if ! command -v node &> /dev/null; then
    echo "❌ ERROR: Node.js not found!"
    echo ""
    echo "Install Node.js from https://nodejs.org (LTS version)"
    echo ""
    exit 1
fi

echo "✅ Node.js found:"
node --version
echo ""

if [ ! -d "node_modules" ]; then
    echo "Installing dependencies (first time only)..."
    npm install
    echo ""
fi

echo "Starting proxy server on http://localhost:3001"
echo "Opening dashboard..."
echo ""
sleep 2

if [[ "$OSTYPE" == "darwin"* ]]; then
    open "http://localhost:3001/index.html" 2>/dev/null &
else
    xdg-open "http://localhost:3001/index.html" 2>/dev/null &
fi

echo "════════════════════════════════════════════════════════"
echo " ✅ SERVER RUNNING - Keep this terminal open"
echo " Press Ctrl+C to stop"
echo "════════════════════════════════════════════════════════"
echo ""

node server.js
