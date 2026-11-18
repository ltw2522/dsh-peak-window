@echo off
chcp 65001 >nul
cd /d D:\dsh_workspace\dsh-peak-window
echo ================================================
echo  发布 dsh-peak-window 1.2.0 到 npm
echo  1) 回车后会用浏览器打开授权页
echo  2) 选 Authorize，用 Windows Hello 确认
echo ================================================
call npm publish
echo.
echo ---- 如果上面提示 staged，请再跑一次：npm stage approve ^<编号^> ----
echo.
pause
pause
