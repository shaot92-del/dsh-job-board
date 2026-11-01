@echo off
rem ============================================================================
rem  手动恢复：把本机的 DeepSeek Harness 重新拉起来。
rem  适用：机器被搞成离线（作业板 last_seen 不再刷新）、远程派工通道全断，
rem        只能到机器前双击这个文件。
rem  日志：%LOCALAPPDATA%\Temp\start-dsh-now.log（冷启动 4~6 分钟，耐心等）
rem ============================================================================
setlocal
set "LOG=%LOCALAPPDATA%\Temp\start-dsh-now.log"
set "EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"

echo [%date% %time%] begin>>"%LOG%"

rem 清掉可能残留的探针开关（NODE_OPTIONS 里的反斜杠会把路径吃掉，直接起不来）
set "NODE_OPTIONS="

if not exist "%EXE%" (
  echo [%date% %time%] MISSING "%EXE%">>"%LOG%"
  echo 找不到 DeepSeek Harness.exe，路径不对？
  pause
  exit /b 1
)

taskkill /IM "DeepSeek Harness.exe" /F >>"%LOG%" 2>&1
timeout /t 8 /nobreak >nul
start "" "%EXE%"
echo [%date% %time%] launched>>"%LOG%"

set /a n=0
:wait
timeout /t 10 /nobreak >nul
set /a n+=1
tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH 2>nul | find /I "DeepSeek Harness.exe" >nul
if not errorlevel 1 goto ok
if %n% lss 24 goto wait

echo [%date% %time%] first launch slow, relaunching>>"%LOG%"
start "" "%EXE%"
set /a n=0
:wait2
timeout /t 10 /nobreak >nul
set /a n+=1
tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH 2>nul | find /I "DeepSeek Harness.exe" >nul
if not errorlevel 1 goto ok
if %n% lss 18 goto wait2

echo [%date% %time%] still down, see log>>"%LOG%"
echo 还是没起来，看日志： %LOG%
pause
exit /b 1

:ok
echo [%date% %time%] ok, processes are up>>"%LOG%"
echo 已启动。等 4~6 分钟让作业板把这台机器认回来。
echo 日志： %LOG%
timeout /t 5 /nobreak >nul
exit /b 0
