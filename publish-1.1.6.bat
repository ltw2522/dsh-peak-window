@echo off
title publish dsh-peak-window 1.1.6
pushd "%~dp0" || (echo [ERR] cannot cd & pause & exit /b 1)
echo ===== [1/3] git push to GitHub ===== 
set /a tries=0
:push
set /a tries+=1
git push -u origin main
if not errorlevel 1 goto pushok
if %tries% GEQ 3 goto pushfail
echo [!] push failed, retry %tries%/3 ...
timeout /t 3 >nul
goto push
:pushfail
echo [!] git push failed 3 times - will retry later from DSH side
:pushok
echo.
echo ===== [2/3] npm publish 1.1.6 =====
echo.
echo  * npm will print a line: Authenticate your account at: https://www.npmjs.com/auth/cli/...
echo  * press ENTER to open the browser, click Authorize, confirm with Windows Hello
echo  * if a line 'Staged package 1a2b3c4d-...' shows up, PLEASE copy it back to DSH
echo.
npm publish
echo.
echo ===== [3/3] done =====
echo  If you saw 'Staged package <uuid>', copy that uuid to the DSH chat.
echo  The window will NOT close by itself now; press a key twice to exit.
pause
pause
