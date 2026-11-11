# 合并转发搜索 - 卸载脚本
# 把 QQ 还原成装插件之前的样子，并清掉加载器和数据

param(
    # 提权重启时透传，保证还原的是“原用户”装的 QQ 入口
    [string]$InstallRoot = '',
    # 提权重启时带上，避免让用户确认两次
    [switch]$Yes,
    # 手动指定 QQ 安装目录（注册表找不到、或装在非标准位置时用）
    [string]$QqRoot = ''
)

$ErrorActionPreference = 'Continue'

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Ok($msg)   { Write-Host "  [OK] " -ForegroundColor Green -NoNewline; Write-Host $msg }
function Warn($msg) { Write-Host "  [!]  " -ForegroundColor Yellow -NoNewline; Write-Host $msg }
function Fail($msg) { Write-Host "  [X]  " -ForegroundColor Red -NoNewline; Write-Host $msg }
function Step($msg) { Write-Host ""; Write-Host "== $msg" -ForegroundColor Cyan }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($InstallRoot) {
    $installRoot = $InstallRoot
} else {
    $installRoot = Join-Path $env:LOCALAPPDATA 'LiteLoaderQQNT'
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Say ""
Say "  合并转发搜索 · 卸载" White
Say "  --------------------------------" DarkGray
Say "  会做："
Say "    1. 把 QQ 的启动入口还原"
Say "    2. 删掉插件加载器和所有插件"
Say "    3. 删掉搜索索引数据"
Say ""
Say "  ⚠ 索引数据删了就找不回来了（聊天记录本身还在 QQ 里，不受影响）" Yellow
Say ""

$ans = 'y'
if (-not $Yes) {
    $ans = Read-Host "  确定要卸载吗？(y/N)"
}
if ($ans -ne 'y' -and $ans -ne 'Y') { Say ""; Say "  已取消，什么都没动。" DarkGray; Read-Host "按回车关闭"; exit 0 }

# 关 QQ
$running = Get-Process -Name QQ -ErrorAction SilentlyContinue
if ($running) {
    Warn "QQ 正在运行，先关闭"
    Stop-Process -Name QQ -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

# ---------- 1. 还原 QQ 入口 ----------
Step "第 1 步：还原 QQ 入口"

$qqExe = $null
# 注意：PowerShell 变量名不区分大小写，$qqRoot 和参数 $QqRoot 是同一个变量。
# 这里千万不能写 $qqRoot = ''，那会把用户传进来的 -QqRoot 直接清空，
# 导致脚本转而按注册表去操作另一个 QQ 目录。
if (-not $QqRoot) { $qqRoot = '' }
$regPaths = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)

if ($QqRoot) {
    # 手动指定优先：装在非标准位置、或注册表里查不到时用
    if (Test-Path $QqRoot) {
        $qqRoot = $QqRoot
        Say "  使用指定的 QQ 目录：$qqRoot" DarkGray
    } else {
        Fail "指定的 QQ 目录不存在：$QqRoot"
    }
} else {
    foreach ($rp in $regPaths) {
        $items = Get-ItemProperty $rp -ErrorAction SilentlyContinue
        foreach ($it in $items) {
            if ($it.DisplayName -notlike '*QQ*') { continue }
            $icon = $it.DisplayIcon
            if (-not $icon) { continue }
            $cand = ($icon -split ',')[0].Trim('"', ' ')
            if ($cand -like '*QQ.exe' -and (Test-Path $cand)) { $qqExe = $cand; break }
        }
        if ($qqExe) { break }
    }
    if ($qqExe) { $qqRoot = Split-Path -Parent $qqExe }
}

if ($qqRoot) {
    $versionsDir = Join-Path $qqRoot 'versions'

    # QQ 升级后旧版本目录可能还留着，每个目录里都可能有一份我们写过的东西。
    # 所以这里不挑"最新那个"，而是把动过的全部还原干净。
    $appDirs = @()
    if (Test-Path $versionsDir) {
        Get-ChildItem $versionsDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $c = Join-Path $_.FullName 'resources\app'
            if (Test-Path (Join-Path $c 'package.json')) { $appDirs += $c }
        }
    } else {
        $c = Join-Path $qqRoot 'resources\app'
        if (Test-Path (Join-Path $c 'package.json')) { $appDirs += $c }
    }

    # 只处理被我们动过的目录，干净的版本一律不碰
    $touched = @()
    foreach ($d in $appDirs) {
        $b = Join-Path $d 'package.json.fs-backup'
        $j = Join-Path $d 'app_launcher\LiteLoader.js'
        if ((Test-Path $b) -or (Test-Path $j)) { $touched += $d }
    }

    if ($touched.Count -eq 0) {
        Warn "QQ 目录里没找到本插件留下的痕迹，跳过入口还原"
    }

    # 权限：只要有一个目录写不进去，就整体提权一次
    $needAdmin = $false
    foreach ($d in $touched) {
        try {
            $probe = Join-Path $d '.fs_unwrite_test'
            Set-Content -Path $probe -Value 'x' -ErrorAction Stop
            Remove-Item $probe -Force -ErrorAction SilentlyContinue
        } catch { $needAdmin = $true; break }
    }

    if ($needAdmin -and -not $isAdmin) {
        Warn "QQ 装在受保护目录，需要管理员权限才能还原。"
        Say "  正在请求管理员权限，请在弹窗里点「是」..." Yellow
        Say ""
        $selfPs1 = Join-Path $scriptDir 'uninstall.ps1'
        try {
            Start-Process powershell -Verb RunAs -Wait -ArgumentList @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$selfPs1`"",
                '-InstallRoot', "`"$installRoot`"",
                '-Yes'
            )
            exit 0
        } catch {
            Fail "提权失败：$($_.Exception.Message)"
            Say "  你可以手动右键 uninstall.bat → 以管理员身份运行" Yellow
            Say ""
        }
    }

    foreach ($appDir in $touched) {
        $verName = Split-Path (Split-Path $appDir -Parent) -Parent | Split-Path -Leaf
        Say ""
        Say "  版本目录：$verName" DarkGray

        $pkg = Join-Path $appDir 'package.json'
        $bak = Join-Path $appDir 'package.json.fs-backup'

        if (Test-Path $bak) {
            try {
                Copy-Item $bak $pkg -Force -ErrorAction Stop
                Remove-Item $bak -Force
                Ok "已还原 package.json"
            } catch {
                Fail "还原 package.json 失败：$($_.Exception.Message)"
            }
        } else {
            Warn "这个版本没有备份，只能手动把 main 改回去"
            Say "     原始值一般是：./application.asar/app_launcher/index.js" DarkGray
        }

        # 只删我们自己写进去的 LiteLoader.js，
        # 万一 QQ 以后自带 app_launcher 目录，也不会把原文件一起删掉
        $launcherDir = Join-Path $appDir 'app_launcher'
        $ourJs = Join-Path $launcherDir 'LiteLoader.js'
        if (Test-Path $ourJs) {
            Remove-Item $ourJs -Force -ErrorAction SilentlyContinue
            Ok "已删掉启动脚本 LiteLoader.js"
        }
        if (Test-Path $launcherDir) {
            $left = Get-ChildItem $launcherDir -Force -ErrorAction SilentlyContinue
            if (-not $left) {
                Remove-Item $launcherDir -Force -ErrorAction SilentlyContinue
                Ok "已删掉空的 app_launcher 目录"
            } else {
                Warn "app_launcher 里还有别的东西，保留不动："
                $left | ForEach-Object { Say "     $($_.Name)" DarkGray }
            }
        }

        # 还原之后自检：main 指向的文件如果不存在，QQ 会直接打不开。
        # 常见于"之前用别的方式装过加载器"——备份里存的就是那个已失效的入口，
        # 而我们刚把 LiteLoader.js 删了，还原回去就是个死链。
        try {
            $raw = [System.IO.File]::ReadAllText($pkg, [System.Text.Encoding]::UTF8)
            $mm = [regex]::Match($raw, '"main"\s*:\s*"([^"]*)"')
            if ($mm.Success) {
                $rel = $mm.Groups[1].Value
                # application.asar 里面的文件在磁盘上测不到，跳过
                if ($rel -notlike '*application.asar*') {
                    $probeRel = ($rel -replace '^\./', '') -replace '/', '\'
                    if (-not (Test-Path (Join-Path $appDir $probeRel))) {
                        Warn "入口指向 $rel，但那个文件已经不在了"
                        Say "     改回 QQ 默认入口，否则 QQ 会打不开。" Yellow
                        $fixed = [regex]::Replace($raw, '("main"\s*:\s*")[^"]*(")',
                                  '${1}./application.asar/app_launcher/index.js${2}', 1)
                        [System.IO.File]::WriteAllText($pkg, $fixed, (New-Object System.Text.UTF8Encoding($false)))
                        Ok "已修正为默认入口"
                    }
                }
            }
        } catch {
            Warn "入口自检没做完（不影响使用）：$($_.Exception.Message)"
        }
    }

    # 老版本教程里要在 QQ 根目录放 dbghelp.dll，
    # 新版 QQ（9.9.x）已经不需要了。这里只提示，绝不自动删：
    # 万一那是别的软件/QQ 自己带的，删了会出事。
    $dbg = Join-Path $qqRoot 'dbghelp.dll'
    if (Test-Path $dbg) {
        Warn "QQ 目录下有个 dbghelp.dll（不是我们放的）"
        Say "     我们的插件不需要它。要删的话请自己确认来源。" DarkGray
    }
} else {
    Warn "找不到 QQ，跳过入口还原"
}

# ---------- 2. 删加载器和数据 ----------
Step "第 2 步：清理加载器与索引数据"

if (Test-Path $installRoot) {
    $size = 0
    try {
        $size = [math]::Round(((Get-ChildItem $installRoot -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB), 1)
    } catch {}
    Say "  将删除：$installRoot ($size MB)" DarkGray
    try {
        Remove-Item $installRoot -Recurse -Force -ErrorAction Stop
        Ok "已删除"
    } catch {
        Fail "删除失败：$($_.Exception.Message)"
        Say "     可能还有程序占用，重启后再试，或手动删这个目录。" Yellow
    }
} else {
    Ok "没有找到加载器目录，跳过"
}

Say ""
Say "  ================================" Green
Say "   卸载完成" Green
Say "  ================================" Green
Say ""
Say "  重启 QQ 就回到原样了。" White
Say "  你的聊天记录不受任何影响（都在 QQ 自己那儿）。"
Say ""
Read-Host "按回车关闭"
