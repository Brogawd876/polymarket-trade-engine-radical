@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 setup_env.py
  goto done
)

where python >nul 2>nul
if %errorlevel%==0 (
  python setup_env.py
  goto done
)

echo Python was not found. Install Python 3, then run this file again.
pause

:done
endlocal
