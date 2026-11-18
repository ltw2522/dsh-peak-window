@echo off
cd /d D:\dsh_workspace\dsh-peak-window
echo ==================================================
echo  dsh-peak-window 1.2.5 - login then publish
echo.
echo  Step 1: npm login (browser authorization + 2FA)
echo  Step 2: npm publish
echo.
echo  The 404 from the last run was a login failure:
echo  the saved token in ~/.npmrc is no longer valid.
echo ==================================================
echo.
call npm login
if errorlevel 1 goto failed
echo.
echo [login ok] publishing...
call npm publish
if errorlevel 1 goto failed
echo.
echo [ok] dsh-peak-window 1.2.5 published.
goto end
:failed
echo.
echo [failed] Read the messages above.
echo If it says "staged", run: npm stage approve ^<id^>
:end
echo.
echo Press any key to close...
pause >nul
