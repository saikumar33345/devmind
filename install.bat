@echo off
setlocal
pushd "%~dp0"

call npm.cmd --prefix server ci
if errorlevel 1 goto failed

call npm.cmd --prefix client ci
if errorlevel 1 goto failed

echo Dependencies installed.
echo Copy the .env.example files to .env and configure the backend services.
echo Run run.bat to start the app with Qdrant Cloud.
popd
exit /b 0

:failed
echo Dependency installation failed.
popd
exit /b 1
