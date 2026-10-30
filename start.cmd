@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node 20.11 or newer: https://nodejs.org/
  exit /b 1
)

if not exist "node_modules\sherpa-onnx-node" (
  echo Local dependencies are missing. Run: npm ci
  exit /b 1
)

node server.mjs --open %*
