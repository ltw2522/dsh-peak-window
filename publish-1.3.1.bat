@echo off
rem 发布 @ltw2522/dsh-peak-window 1.3.1（exports 与模块 id 双修复）
rem 账号开了 2FA：沙箱里 npm publish 只会得到 202 + 暂存（staged）版本，必须由本机终端完成一次性密码。
rem 逻辑：先看有没有 1.3.1 的暂存版本 -> 有就 approve（会提示输入 2FA 验证码）；
rem       没有就重新 publish；最后核对 dist-tags.latest。
cd /d "%~dp0"
set CACHE=D:/dsh_workspace/.npm-cache-tmp

echo === npm whoami ===
call npm whoami
if errorlevel 1 goto login
goto staged

:login
echo === 未登录，先 npm login（浏览器授权 + 2FA）===
call npm login
if errorlevel 1 goto fail

:staged
echo.
echo === 当前暂存状态 ===
call npm stage list
echo.
echo 若上面列出 @ltw2522/dsh-peak-window 1.3.1，按任意键执行 approve（会要求输入 6 位验证码）
echo 若没有列出，按任意键执行 publish
pause >nul
call npm stage approve @ltw2522/dsh-peak-window@1.3.1 --cache %CACHE%
if not errorlevel 1 goto verify

echo === approve 未成功，改为直接 publish ===
call npm publish --access public --cache %CACHE%
if errorlevel 1 goto fail

:verify
echo.
echo === 核对远端版本（应出现 1.3.1）===
call npm view @ltw2522/dsh-peak-window dist-tags version --json
call npm view @ltw2522/dsh-peak-window dist.tarball --json
goto end

:fail
echo === 失败：把上面最后 10 行发我 ===

:end
pause
