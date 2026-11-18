@echo off
title push dsh-peak-window to GitHub
pushd "%~dp0" || (echo [ERR] cannot cd & pause & exit /b 1)
echo If a browser window opens, log in as ltw2522 and allow Git Credential Manager.
echo.
git push -u origin main
echo.
echo ---- finished. press a key twice to close ----
pause
pause
