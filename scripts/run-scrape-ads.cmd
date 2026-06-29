@echo off
REM Scheduled-task wrapper for scrape-ads.py (no PowerShell, no policy changes).
REM Reconciles ad-videos.json vs the Transparency Center, applies new ads, and
REM commits+pushes (ad data -> main). Logs to %LOCALAPPDATA%\jerminaldecline.
setlocal
set "PY=C:\Users\bradw\AppData\Local\Programs\Python\Python311\python.exe"
set "LOGDIR=%LOCALAPPDATA%\jerminaldecline"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
>> "%LOGDIR%\scrape-ads.log" echo.
>> "%LOGDIR%\scrape-ads.log" echo ===== run %DATE% %TIME% =====
"%PY%" "%~dp0scrape-ads.py" --apply --commit >> "%LOGDIR%\scrape-ads.log" 2>&1
>> "%LOGDIR%\scrape-ads.log" echo exit code: %ERRORLEVEL%
endlocal
