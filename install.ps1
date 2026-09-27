<#
.SYNOPSIS
    一键安装 / 更新 dsh-imagegen（DSH 的 generate_image 插件）。

.DESCRIPTION
    把插件从 GitHub 装进某个 DSH profile，或把它更新到最新。
    幂等：重复执行 = 更新；已是最新则基本无操作。

    脚本会自己处理三件事，省得每台机器重踩：
      1) 找不到 DSH 目录时向上搜索，或用 -DshDir / 环境变量 DSH_DIR 指定；
      2) **代理**：本机若开了 Windows 系统代理（浏览器能上 GitHub 而 git 不能），
         自动读注册表拿到代理地址，只对本次命令生效，不改你的全局 git 配置；
      3) 装完**自检**：跑插件自带的离线 smoke（31 项）+ 确认 profile 组合树里还有 imagegen 层。

.PARAMETER Profile
    DSH profile 名，默认 web。

.PARAMETER Ref
    git 引用：分支 / tag / sha。默认 main（= 最新）。
    要可复现就传 sha，例如 -Ref b398714。

.PARAMETER Repo
    仓库，默认 wooyoojoo/dsh-image-gen。

.PARAMETER DshDir
    DSH 检出目录（`pnpm dsh` 要在这里跑）。默认向上搜索，或读环境变量 DSH_DIR。

.PARAMETER Proxy
    代理地址（如 http://127.0.0.1:20368）。默认自动探测 Windows 系统代理；传 none 强制不用。

.PARAMETER NoVerify
    跳过装完后的自检。

.EXAMPLE
    pwsh -File install.ps1
    装/更新到 web profile 的最新版，自动探测代理并自检。

.EXAMPLE
    pwsh -File install.ps1 -Profile img -Ref b398714
    装进 img profile，并固定到指定 sha。

.EXAMPLE
    pwsh -File install.ps1 -Proxy none -DshDir D:\Git\deepseek-harness
    不用代理（能直连 GitHub 的机器），并显式指定 DSH 目录。
#>
[CmdletBinding()]
param(
    [string]$Profile = 'web',
    [string]$Ref = 'main',
    [string]$Repo = 'wooyoojoo/dsh-image-gen',
    [string]$DshDir = '',
    [string]$Proxy = '',
    [switch]$NoVerify
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    !   $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "`n[失败] $msg" -ForegroundColor Red; exit 1 }

# ---------- 0. 环境 ----------
$onWindows = $true
if (Get-Variable -Name IsWindows -ErrorAction SilentlyContinue) { $onWindows = $IsWindows }
$pnpm = if ($onWindows) { (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source } else { $null }
if (-not $pnpm) { $pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue).Source }
if (-not $pnpm) { Fail "找不到 pnpm。先装 Node ≥18 与 pnpm（DSH 本身也需要）。" }
Write-Ok "pnpm = $pnpm"

# ---------- 1. 代理：只对本次命令生效 ----------
$proxyUrl = $null
if ($Proxy -eq 'none') {
    Write-Ok "代理：按参数要求不使用"
} elseif ($Proxy -ne '') {
    $proxyUrl = $Proxy
    Write-Ok "代理：使用参数指定值"
} elseif ($onWindows) {
    try {
        $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
        if ($ie.ProxyEnable -eq 1 -and $ie.ProxyServer) {
            $srv = "$($ie.ProxyServer)"
            if ($srv -notmatch '^https?://') { $srv = "http://$srv" }
            $proxyUrl = $srv
            Write-Ok "代理：探测到 Windows 系统代理（git 默认不读它，所以本脚本显式套用）"
        }
    } catch { }
    if (-not $proxyUrl) { Write-Warn2 "代理：未探测到系统代理（若 git 连不上 GitHub，用 -Proxy http://host:port 指定）" }
}

$oldHttp = $env:HTTP_PROXY; $oldHttps = $env:HTTPS_PROXY; $oldAll = $env:ALL_PROXY
if ($proxyUrl) {
    $env:HTTP_PROXY = $proxyUrl; $env:HTTPS_PROXY = $proxyUrl; $env:ALL_PROXY = $proxyUrl
}

# ---------- 2. 找 DSH 检出目录 ----------
if (-not $DshDir) { $DshDir = $env:DSH_DIR }
if (-not $DshDir) {
    Write-Step "自动查找 DSH 检出目录…"
    $probe = (Get-Location).Path
    while ($probe) {
        $pkg = Join-Path $probe 'package.json'
        if (Test-Path $pkg) {
            $txt = Get-Content $pkg -Raw
            if ($txt -match '"dsh"\s*:' -and (Test-Path (Join-Path $probe 'pnpm-workspace.yaml'))) { $DshDir = $probe; break }
        }
        $parent = Split-Path $probe -Parent
        if ($parent -eq $probe) { break }
        $probe = $parent
    }
}
if (-not $DshDir -or -not (Test-Path $DshDir)) {
    Fail "找不到 DSH 检出目录。用 -DshDir <路径> 指定（就是能跑 pnpm dsh 的那个目录）。"
}
Write-Ok "DSH 目录 = $DshDir"

# ---------- 3. 安装 / 更新 ----------
$spec = "github:$Repo#$Ref"
Write-Step "安装：pnpm dsh plugin --profile $Profile add $spec"
Push-Location $DshDir
try {
    # ⚠️ 原生命令（pnpm / node / git）把进度写到 stderr，而 PowerShell 5.1 在
    # $ErrorActionPreference='Stop' 下会把那当成致命错误直接终止 —— 本脚本踩过这个坑。
    # 所以调原生命令期间临时降级为 Continue，只认退出码。
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $pnpm dsh plugin --profile $Profile add $spec
        $installCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
    }
    if ($installCode -ne 0) { Fail "pnpm 返回 $installCode（网络/凭据问题？试试 -Proxy <地址>，或核对仓库名与 -Ref）" }
} finally {
    Pop-Location
}
Write-Ok "已写入 profile `"$Profile`" 的依赖"

# ---------- 4. 自检 ----------
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$pkgDir = Join-Path $dshHome "profiles/$Profile/node_modules/dsh-imagegen"

if (Test-Path $pkgDir) {
    $ver = (Get-Content (Join-Path $pkgDir 'package.json') -Raw | ConvertFrom-Json).version
    Write-Ok "已安装副本：$pkgDir（version $ver）"
} else {
    Write-Warn2 "没在 $pkgDir 找到已安装副本 —— 到 DSH 里确认一下 profile 名是否正确"
}

if (-not $NoVerify) {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if ($node -and (Test-Path (Join-Path $pkgDir 'smoke.mjs'))) {
        Write-Step "离线自检（不联网、不花额度）"
        $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try {
            & $node (Join-Path $pkgDir 'smoke.mjs') 2>&1 | Select-Object -Last 2
            $smokeCode = $LASTEXITCODE
        } finally { $ErrorActionPreference = $prevEap }
        if ($smokeCode -ne 0) { Write-Warn2 "smoke 没全绿，上面的 FAIL 行说明了是哪里" } else { Write-Ok "smoke 全绿" }
    } else {
        Write-Warn2 "跳过 smoke（缺 node 或缺 smoke.mjs）"
    }
    Write-Step "组合树自检"
    Push-Location $DshDir
    try {
        $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try {
            $dump = & $pnpm dsh --profile $Profile --dump-config 2>&1 | Out-String
        } finally { $ErrorActionPreference = $prevEap }
        if ($dump -match 'imagegen') { Write-Ok "profile 组合树里 imagegen 层在位" }
        else { Write-Warn2 "dump-config 里没看到 imagegen —— 到 DSH 里确认 profile 的 bundles 列表" }
    } finally { Pop-Location }
}

# ---------- 5. 还原环境变量 ----------
if ($proxyUrl) {
    $env:HTTP_PROXY = $oldHttp; $env:HTTPS_PROXY = $oldHttps; $env:ALL_PROXY = $oldAll
}

Write-Host ""
Write-Host "完成。下一步：**重启 DSH**（改 index.js 必须重启才生效；cordis-plugin-hmr 是 disabled 的）。" -ForegroundColor Cyan
Write-Host "重启后在**新会话**里，generate_image 就有 14 个参数（含 image/mask/background/output_format/seed/input_fidelity/extra/outputDir）。" -ForegroundColor Cyan
if ($Ref -eq 'main') { Write-Host "提示：想要可复现，用 -Ref <sha> 固定版本（sha 见仓库提交历史）。" -ForegroundColor DarkGray }
