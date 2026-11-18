@echo off
cd /d D:\dsh_workspace\dsh-peak-window
echo ==================================================
echo  Publish dsh-peak-window 1.2.3 to npm
echo  1) Press ENTER to open the authorization page
echo  2) Click Authorize, confirm with Windows Hello
echo ==================================================
call npm publish
echo.
echo [done] If npm says "staged", run: npm stage approve ^<id^>
echo.
pause
pause
