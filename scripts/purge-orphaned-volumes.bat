@echo off
REM 双击执行：记忆卷校验扫除（projectneed 15-10-4）。
REM 先在文件管理器删掉要清的卷的锚文件 library\.memory\<身份>\<工作区>\<会话>.jsonl，再双击本文件。
setlocal
cd /d "%~dp0.."
set ELECTRON_RUN_AS_NODE=1
call ".\node_modules\.bin\electron.cmd" "scripts\purge-orphaned-volumes.mjs"
echo.
echo 按任意键关闭此窗口。
pause >nul
