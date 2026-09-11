@echo off
REM Scheduled-task wrapper for build-coffee.py (no PowerShell, no policy changes).
REM Rebuilds public/coffee.json from the two Coffee Brand Coffee scanners and
REM commits+pushes it (data -> main). Runs after both scans: the Amazon sweep
REM starts 09:30 and can take ~3h; the Shopify scan runs at 12:00.
REM Logs to %LOCALAPPDATA%\jerminaldecline\build-coffee.log.
setlocal
set "PY=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
set "LOGDIR=%LOCALAPPDATA%\jerminaldecline"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
>> "%LOGDIR%\build-coffee.log" echo.
>> "%LOGDIR%\build-coffee.log" echo ===== run %DATE% %TIME% =====
"%PY%" "%~dp0build-coffee.py" --commit >> "%LOGDIR%\build-coffee.log" 2>&1
set "RC=%ERRORLEVEL%"
>> "%LOGDIR%\build-coffee.log" echo exit code: %RC%
REM Propagate the real result to Task Scheduler (LastTaskResult).
endlocal & exit /b %RC%
