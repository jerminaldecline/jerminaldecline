@echo off
REM Scheduled-task wrapper for scrape-ads.py (no PowerShell, no policy changes).
REM Reconciles ad-videos.json vs the Transparency Center, applies new ads, and
REM commits+pushes (ad data -> main). Logs to %LOCALAPPDATA%\jerminaldecline.
setlocal
set "PY=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
set "LOGDIR=%LOCALAPPDATA%\jerminaldecline"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
>> "%LOGDIR%\scrape-ads.log" echo.
>> "%LOGDIR%\scrape-ads.log" echo ===== run %DATE% %TIME% =====
"%PY%" "%~dp0scrape-ads.py" --apply --commit >> "%LOGDIR%\scrape-ads.log" 2>&1
set "RC=%ERRORLEVEL%"
>> "%LOGDIR%\scrape-ads.log" echo exit code: %RC%
REM Propagate the real result to Task Scheduler (LastTaskResult) — previously the
REM trailing echo reset it to 0, hiding aborts (bot-block floor, push failure).
endlocal & exit /b %RC%
