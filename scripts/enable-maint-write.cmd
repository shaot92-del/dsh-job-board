@echo off
chcp 65001 >nul
setlocal
set "PS1=%~dp0enable-maint-write.ps1"
if not exist "%PS1%" (
  echo [x] missing %PS1%
  pause
  exit /b 2
)
where pwsh >nul 2>nul
if errorlevel 1 (
  echo [x] pwsh 7 not found in PATH
  pause
  exit /b 2
)
echo script = %PS1%
pwsh -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
echo exit = %ERRORLEVEL%
echo.
pause
endlocal