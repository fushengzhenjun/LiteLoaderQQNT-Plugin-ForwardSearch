# 合并转发搜索 - 一键安装脚本
# 做的事：装 LiteLoaderQQNT 加载器 + 装本插件 + 改 QQ 入口
# 所有改动都可以用 uninstall.ps1 还原

param(
    [switch]$DryRun,
    # 提权重启时用来把“原用户”的安装目录透传进来，
    # 避免 UAC 换成管理员账户后把插件装到别人的用户目录里
    [string]$InstallRoot = '',
    # 提权重启时带上：用户刚才已经选过"重装"了，别再问一遍
    [switch]$NoAsk
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------- 输出辅助 ----------
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

# ---------- 0. 前置检查 ----------
if ($DryRun) {
    Say ""
    Say "  [试运行模式] 只检查，不会修改任何文件" Magenta
}
Say ""
Say "  合并转发搜索 · 一键安装" White
Say "  --------------------------------" DarkGray
Say "  会做这几件事："
Say "    1. 把插件加载器装到你的用户目录（不碰系统）"
Say "    2. 把本插件放进加载器"
Say "    3. 修改 QQ 的启动入口，让它加载插件"
Say "  装完可以用 uninstall.ps1 完全还原。"
Say ""

# 管理员提示（不强制，但说明为什么可能要）
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# ---------- 0.5 已经装过？给个卸载出口 ----------
# 单文件版只有一个 bat，没有单独的卸载按钮，
# 所以重复双击时就地问一句，别让人装得上、卸不掉。
$hasLoader = Test-Path (Join-Path $installRoot 'src\main.js')
$hasPlugin = Test-Path (Join-Path $installRoot 'plugins\forward-search\manifest.json')
if ($hasLoader -and $hasPlugin -and -not $DryRun -and -not $NoAsk) {
    Say "  这台电脑已经装过本插件了。" Yellow
    Say ""
    Say "    [1] 重新安装 / 更新（保留已有的搜索索引）"
    Say "    [2] 卸载（还原 QQ，删掉插件和索引）"
    Say "    [Q] 什么都不做，退出"
    Say ""
    $choice = Read-Host "  选一个，直接回车 = 1"
    if ($choice -eq 'q' -or $choice -eq 'Q') {
        Say ""
        Say "  已退出，什么都没动。" DarkGray
        exit 0
    }
    if ($choice -eq '2') {
        $unPs1 = Join-Path $scriptDir 'uninstall.ps1'
        if (Test-Path $unPs1) {
            Say ""
            & powershell -NoProfile -ExecutionPolicy Bypass -File "$unPs1" -InstallRoot "$installRoot"
        } else {
            Say ""
            Fail "这个安装包里没有 uninstall.ps1，没法卸载。"
            Say "  请改用文件夹版里的 uninstall.bat。" Yellow
            Read-Host "按回车关闭"
        }
        exit 0
    }
    Say ""
    Say "  好的，继续覆盖安装。" DarkGray
    Say ""
}

# ---------- 1. 找 QQ ----------
Step "第 1 步：找 QQ 装在哪"

$qqExe = $null
$regPaths = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
foreach ($rp in $regPaths) {
    $items = Get-ItemProperty $rp -ErrorAction SilentlyContinue
    foreach ($it in $items) {
        if ($it.DisplayName -notlike '*QQ*') { continue }
        $icon = $it.DisplayIcon
        if (-not $icon) { continue }
        # DisplayIcon 形如 "H:\QQ\QQ.exe,0"
        $cand = ($icon -split ',')[0].Trim('"', ' ')
        if ($cand -like '*QQ.exe' -and (Test-Path $cand)) {
            $qqExe = $cand
            break
        }
    }
    if ($qqExe) { break }
}

if (-not $qqExe) {
    # 兜底：常见安装位置
    $guess = @(
        "$env:ProgramFiles\Tencent\QQNT\QQ.exe",
        "${env:ProgramFiles(x86)}\Tencent\QQNT\QQ.exe",
        "$env:LOCALAPPDATA\Tencent\QQ\QQ.exe",
        "C:\Program Files\Tencent\QQNT\QQ.exe",
        "D:\Program Files\Tencent\QQNT\QQ.exe"
    )
    foreach ($g in $guess) { if (Test-Path $g) { $qqExe = $g; break } }
}

if (-not $qqExe) {
    Fail "没找到 QQ。"
    Say ""
    Say "  这个插件是 QQ 的增强，必须先有 QQ 才能装。" Yellow
    Say ""
    Say "  如果是全新电脑、还没装 QQ："
    Say "    1. 浏览器打开  https://qq.qq.com"
    Say "    2. 下载并安装 QQ（要新版 NT 界面，不是老版 QQ）"
    Say "    3. 启动一次、登录，然后关掉 QQ"
    Say "    4. 再回来双击这个安装包"
    Say ""
    Say "  如果 QQ 已经装了，只是装在奇怪的位置："
    $manual = Read-Host "  粘贴 QQ.exe 的完整路径（直接回车退出）"
    if ($manual) { $manual = $manual.Trim('"', ' ') }
    if ($manual -and (Test-Path $manual)) { $qqExe = $manual }
    else { Say ""; Say "  已取消。" DarkGray; Read-Host "按回车关闭"; exit 1 }
}

$qqRoot = Split-Path -Parent $qqExe
Ok "QQ 位置：$qqRoot"

# 检查 QQ 是否在运行
$running = Get-Process -Name QQ -ErrorAction SilentlyContinue
if ($running) {
    Warn "QQ 正在运行，先关掉再装更稳妥。"
    if ($DryRun) { Ok "[试运行] 跳过关闭 QQ" }
    else {
    $ans = Read-Host "  现在自动关闭 QQ？(Y/n)"
    if ($ans -ne 'n' -and $ans -ne 'N') {
        Stop-Process -Name QQ -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Ok "已关闭 QQ"
    }
    }
}

# ---------- 2. 找 app 目录 ----------
Step "第 2 步：定位 QQ 的程序目录"

$versionsDir = Join-Path $qqRoot 'versions'
$appDir = $null

# 版本目录名形如 "9.9.31-49738"。
# 不能直接按字符串排：字符串降序会把 9.9.9 排在 9.9.31 前面，
# 于是把插件装进一个 QQ 根本不启动的旧目录，用户就会觉得"装了没反应"。
# 这里先把 "-49738" 后缀去掉做真正的版本号比较，同版本再按修改时间。
function Get-VerKey($dirName) {
    $head = ($dirName -split '-')[0]
    $v = $null
    if ([version]::TryParse($head, [ref]$v)) { return $v }
    return [version]'0.0.0'
}

if (Test-Path $versionsDir) {
    $verDirs = Get-ChildItem $versionsDir -Directory -ErrorAction SilentlyContinue |
               Sort-Object @{ Expression = { Get-VerKey $_.Name }; Descending = $true },
                           @{ Expression = { $_.LastWriteTime }; Descending = $true }
    foreach ($vd in $verDirs) {
        $cand = Join-Path $vd.FullName 'resources\app'
        if (Test-Path (Join-Path $cand 'package.json')) { $appDir = $cand; break }
    }
    if ($appDir) {
        Ok "结构：带 versions（新版 QQ 常见）"
        Ok "选中的版本：$((Split-Path (Split-Path $appDir -Parent) -Parent | Split-Path -Leaf))"
    }
} else {
    $cand = Join-Path $qqRoot 'resources\app'
    if (Test-Path (Join-Path $cand 'package.json')) { $appDir = $cand; Ok "结构：不带 versions" }
}

if (-not $appDir) {
    Fail "没找到 QQ 的 app 目录（里面应该有 package.json）。"
    Say "  这不是新版 QQ？或者 QQ 装坏了？" DarkGray
    Read-Host "按回车关闭"; exit 1
}
Ok "程序目录：$appDir"

$pkgPath = Join-Path $appDir 'package.json'
$pkgBackup = Join-Path $appDir 'package.json.fs-backup'

# ---------- 3. 检查写权限 ----------
Step "第 3 步：检查权限"

$canWrite = $false
try {
    $probe = Join-Path $appDir '.fs_write_test'
    Set-Content -Path $probe -Value 'x' -ErrorAction Stop
    Remove-Item $probe -Force
    $canWrite = $true
} catch { $canWrite = $false }

if (-not $canWrite) {
    Warn "QQ 装在受保护的位置（比如 C:\Program Files），需要管理员权限。"
    Say ""

    if (-not $DryRun -and -not $isAdmin) {
        # 自动提权：弹一次 UAC，点“是”就继续，不用用户去找“以管理员身份运行”
        Say "  正在请求管理员权限，请在弹窗里点「是」..." Yellow
        Say "  （如果没弹窗，就在任务栏找一下闪烁的盾牌图标）" DarkGray
        Say ""
        $selfPs1 = Join-Path $scriptDir 'install.ps1'
        $argList = @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$selfPs1`"",
            '-InstallRoot', "`"$installRoot`"",
            '-NoAsk'
        )
        try {
            Start-Process powershell -Verb RunAs -Wait -ArgumentList $argList
            exit 0
        } catch {
            Fail "提权失败：$($_.Exception.Message)"
            Say "  你可以手动右键 install.bat → 以管理员身份运行" Yellow
            Say ""
        }
    }

    Fail "没有权限修改 QQ 的目录。"
    Say ""
    Say "  解决办法：右键这个安装包 → 以管理员身份运行" Yellow
    Say "  或者把 QQ 装到 D 盘之类的非系统目录再试。"
    Say ""
    Read-Host "按回车关闭"; exit 1
}
Ok "有写入权限"

# ---------- 4. 装 LiteLoader ----------
Step "第 4 步：安装插件加载器"

$srcLL = Join-Path $scriptDir 'LiteLoader'
if (-not (Test-Path (Join-Path $srcLL 'src\main.js'))) {
    Fail "安装包不完整：找不到 LiteLoader 文件。"
    Read-Host "按回车关闭"; exit 1
}

# 如果目标已存在且是我们的，直接覆盖更新
if (Test-Path $installRoot) {
    Warn "检测到已安装过：$installRoot"
    Say "     会更新为安装包里的版本。"
} 

if ($DryRun) {
    Ok "[试运行] 将安装到：$installRoot"
} else {
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
    Copy-Item -Path (Join-Path $srcLL '*') -Destination $installRoot -Recurse -Force
    Ok "加载器已装到：$installRoot"
}

# ---------- 5. 装插件 ----------
Step "第 5 步：安装本插件"

$pluginSrc = Join-Path $scriptDir 'forward-search'
$pluginDst = Join-Path $installRoot 'plugins\forward-search'

if (-not (Test-Path (Join-Path $pluginSrc 'manifest.json'))) {
    Fail "安装包不完整：找不到插件文件。"
    Read-Host "按回车关闭"; exit 1
}

if ($DryRun) {
    Ok "[试运行] 将装到：$pluginDst"
} else {
    New-Item -ItemType Directory -Path (Split-Path -Parent $pluginDst) -Force | Out-Null
    if (Test-Path $pluginDst) { Remove-Item $pluginDst -Recurse -Force }
    Copy-Item -Path $pluginSrc -Destination $pluginDst -Recurse -Force
    Ok "插件已装好"
}

# ---------- 6. 改 QQ 入口 ----------
Step "第 6 步：让 QQ 启动时加载插件"

# 6.1 备份 package.json（只备份一次，保留最初的原版）
if ($DryRun) {
    Ok "[试运行] 将备份 package.json"
} elseif (-not (Test-Path $pkgBackup)) {
    Copy-Item $pkgPath $pkgBackup -Force
    Ok "已备份原始配置：package.json.fs-backup"
} else {
    Ok "原始配置备份已存在，保留不动"
}

# 6.2 写启动脚本
$launcherDir = Join-Path $appDir 'app_launcher'
$launcherJs = Join-Path $launcherDir 'LiteLoader.js'
$jsContent = 'require(String.raw`' + $installRoot + '`);'
if ($DryRun) {
    Ok "[试运行] 将写入：$launcherJs"
} else {
    New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null
    # 必须无 BOM：带 BOM 的 js 某些情况下会让加载器解析异常
    [System.IO.File]::WriteAllText($launcherJs, $jsContent, (New-Object System.Text.UTF8Encoding($false)))
    Ok "启动脚本已写入"
}

# 6.3 改 package.json 的 main
if ($DryRun) {
    Ok "[试运行] 将修改 $pkgPath 的 main 字段"
} else {
try {
    # 只替换 main 的值，不动其他内容和格式；且必须写无 BOM 的 UTF-8，
    # 否则 JSON.parse 会因 BOM 报错，导致 QQ 直接起不来。
    $raw = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8)
    if ($raw -notmatch '"main"\s*:') { throw 'package.json 里找不到 main 字段' }
    $new = [regex]::Replace($raw, '("main"\s*:\s*)"[^"]*"', '$1"./app_launcher/LiteLoader.js"', 1)
    if ($new -eq $raw) { throw 'main 字段替换没有生效' }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($pkgPath, $new, $utf8NoBom)
    Ok '已把 QQ 入口指向 LiteLoader'
} catch {
    Fail "改 package.json 失败：$($_.Exception.Message)"
    Say "  已自动还原备份..." Yellow
    Copy-Item $pkgBackup $pkgPath -Force
    Read-Host "按回车关闭"; exit 1
}
}

# ---------- 7. 完成 ----------
Say ""
Say "  ================================" Green
Say "   安装完成" Green
Say "  ================================" Green
Say ""
Say "  现在启动 QQ，然后按 Alt + S 试试。" White
Say ""
Say "  第一次搜不出东西是正常的 —— 索引还是空的。" Yellow
Say "  打开一个有合并转发卡片的群，点弹窗右下角「扫描历史」，"
Say "  让它先把卡片收进来，之后就能搜了。"
Say ""
Say "  第一次点扫描，它会问要不要打开「内容补全模式」，"
Say "  点确定就行 —— 那是允许插件读历史消息的开关，不碰 QQ 设置。"
Say ""
Say "  扫一次会把你所有有本地缓存的会话都过一遍，不用一个个群去点。"
Say ""
Say "  --------------------------------" DarkGray
Say "  全新电脑上刚登录的 QQ 特别注意：" Yellow
Say "  QQ 是登录后才慢慢把聊天记录拉到本地的，" DarkGray
Say "  刚登上去时那个群可能还没有本地记录，扫描会扫到 0 条。" DarkGray
Say "  先去那个群往上翻几屏聊天记录（让它加载出来），" DarkGray
Say "  再点「扫描历史」，就能扫到卡片了。" DarkGray
Say ""
Say "  数据目录（想清理/备份就去这）："
Say "    $installRoot\data\forward-search" DarkGray
Say ""

if ($DryRun) {
    Say ""
    Say "  [试运行结束] 没有修改任何文件。" Magenta
    Say "  去掉 -DryRun 参数再运行，才会真正安装。"
} else {
$open = Read-Host "  现在打开 QQ？(Y/n)"
if ($open -ne 'n' -and $open -ne 'N') {
    Start-Process $qqExe
    Say ""
    Ok "QQ 已启动，等它加载完再按 Alt + S"
}
}

Say ""
Read-Host "按回车关闭"
