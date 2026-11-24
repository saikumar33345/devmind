@echo off
setlocal

if not exist "%~dp0server\.env" (
  echo Create server\.env from server\.env.example before starting the app.
  exit /b 1
)

start "DevMind API" /D "%~dp0server" cmd /k "npm.cmd run dev"
start "DevMind Web" /D "%~dp0client" cmd /k "npm.cmd run dev"

echo Frontend: http://localhost:5173
echo Local Chroma users must start Chroma separately as described in README.md.
