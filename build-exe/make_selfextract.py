# 生成自解压单文件安装器（.bat）
# 思路：把 zip 以 base64 形式附在 bat 末尾，运行时用 PowerShell 解码并解压

import base64
import os

PAYLOAD = 'payload.zip'
OUTPUT = 'ForwardSearch-Setup.bat'

with open(PAYLOAD, 'rb') as f:
    raw = f.read()

b64 = base64.b64encode(raw).decode('ascii')

# 按 76 字符换行，符合标准 base64 排版
lines = [b64[i:i + 76] for i in range(0, len(b64), 76)]

HEADER = r'''@echo off
chcp 936 >nul 2>&1
title 合并转发搜索 - 安装
setlocal

set "FS_SELF=%~f0"
set "FS_TMP=%TEMP%\fs_setup_%RANDOM%%RANDOM%"

echo.
echo   ============================================
echo     合并转发搜索  /  Forward Search
echo   ============================================
echo.
echo   装之前只要确认一件事：电脑上已经装了新版 QQ。
echo   （还没有的话，先去 https://qq.qq.com 装一个，
echo     登录一次、然后关掉，再回来双击这个文件）
echo.
echo   这个安装包会做三件事：
echo     1. 把插件加载器 LiteLoaderQQNT 装到你的用户目录
echo     2. 把 forward-search 插件装进去
echo     3. 给 QQ 加一个启动入口，让它加载插件
echo.
echo   不碰系统文件，随时可以完全还原。
echo   安装位置：%LOCALAPPDATA%\LiteLoaderQQNT
echo.
echo   已经装过的电脑，运行后会问你要「重装」还是「卸载」。
echo.
echo   10 秒后自动开始，按任意键立即开始（Ctrl+C 取消）。
timeout /t 10 >nul 2>&1
if errorlevel 1 goto :go
:go

mkdir "%FS_TMP%" 2>nul
if not exist "%FS_TMP%" (
    echo   [X] 建不了临时目录，请检查磁盘空间或杀毒软件拦截。
    pause
    exit /b 1
)

echo.
echo   正在解包，请稍等几秒...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $l=[IO.File]::ReadAllLines($env:FS_SELF); $i=-1; for($j=0;$j -lt $l.Length;$j++){ if($l[$j].Trim() -eq '::PAYLOAD::'){ $i=$j+1; break } }; if($i -lt 0){ exit 2 }; $b=($l[$i..($l.Length-1)] -join '').Trim(); [IO.File]::WriteAllBytes(($env:FS_TMP+'\p.zip'), [Convert]::FromBase64String($b))"

if errorlevel 1 goto :fail

powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path ($env:FS_TMP+'\p.zip') -DestinationPath ($env:FS_TMP+'\f') -Force"

if errorlevel 1 goto :fail

call "%FS_TMP%\f\install.bat"

rem ---- 清理临时文件 ----
rmdir /s /q "%FS_TMP%" 2>nul
exit /b 0

:fail
echo.
echo   [X] 解包失败，没有做任何修改。
echo.
echo       可能是杀毒软件拦住了，或者下载的时候文件不完整。
echo       可以重新下载一次，或者改用压缩包版本手动安装。
echo.
pause
rmdir /s /q "%FS_TMP%" 2>nul
exit /b 1

::PAYLOAD::
'''

# 头部用 GBK 写（中文），payload 是 ASCII
# 注意：换行必须统一为 CRLF。cmd 对 LF 换行的 bat 解析会错乱，
# 表现为满屏"不是内部或外部命令"。
with open(OUTPUT, 'wb') as f:
    head = HEADER.replace('\r\n', '\n').replace('\n', '\r\n')
    f.write(head.encode('gbk', errors='replace'))
    f.write(('\r\n'.join(lines) + '\r\n').encode('ascii'))

size = os.path.getsize(OUTPUT)
print('生成: %s' % OUTPUT)
print('大小: %d KB' % round(size / 1024))
print('payload 行数: %d' % len(lines))
