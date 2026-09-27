@echo off
rem ===========================================================================
rem  dsh-imagegen one-click install / update.
rem
rem  Single file: a cmd launcher plus an embedded PowerShell program. Why it is
rem  built this way:
rem
rem   1) The Windows execution policy is often Restricted, so running a .ps1
rem      directly is refused ("running scripts is disabled on this system").
rem      A .cmd is not covered by that policy, so the entry point can be a single
rem      double-clickable file.
rem   2) Windows PowerShell 5.1 decodes a BOM-less .ps1 as ANSI, which mangles
rem      non-ASCII strings badly enough to break parsing (seen in practice: a
rem      bogus "missing closing brace" error). Here the script is read with .NET
rem      [IO.File]::ReadAllText, which defaults to UTF-8, so no BOM is needed.
rem   3) Arguments are forwarded as usual:
rem        install.cmd -Profile img -Ref <sha> -DshDir <path> -Proxy <url>
rem      For usage text:  install.cmd -Help
rem
rem  The split marker below is located with LastIndexOf on purpose: this header
rem  may mention it, and only the real marker line must win.
rem
rem  KEEP THIS FILE CRLF. A batch file with LF-only endings is parsed wrong by
rem  cmd.exe (its block reads assume CRLF, so it seeks mid-line and reports
rem  garbage such as: +$m.Length)))" -Help was unexpected at this time). That is
rem  also why .gitattributes pins "*.cmd text eol=crlf", and why this installer is
rem  deliberately NOT shipped inside the npm package: pnpm materialises a git
rem  dependency with LF endings, which would ship a broken copy of this file.
rem  Run it from a repo checkout (git clone), where CRLF is guaranteed.
rem ===========================================================================
setlocal
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command "$raw=[IO.File]::ReadAllText('%~f0'); $m='#:PS-BEGIN:#'; & ([ScriptBlock]::Create($raw.Substring($raw.LastIndexOf($m)+$m.Length)))" %*
exit /b %ERRORLEVEL%
#:PS-BEGIN:#
<#
    dsh-imagegen 一键安装 / 更新（内嵌在 install.cmd 里的 PowerShell 部分）

    做五件事：
      ① 找 DSH 检出目录：-DshDir → 环境变量 DSH_DIR → 上次记住的 → 从当前目录向上搜；
         找到后记在 $DSH_HOME/imagegen-install.json，所以**第一次给过 -DshDir 之后就能零参数跑**。
      ② 代理：本机若开了 Windows 系统代理（浏览器能上 GitHub、git 却连不上，因为 git 不读系统代理设置），
         自动读注册表拿地址，**只对本次命令设 HTTP(S)_PROXY，不改你的全局 git 配置**。
      ③ 安装/更新插件（从 GitHub 装进指定 profile）。
      ④ 离线自检：跑插件自带的 smoke（68 项，不联网、不花额度）。
      ⑤ 组合树自检：pnpm dsh --profile <p> --dump-config 里应能看到 imagegen 层。最后提示重启 DSH。

    参数：
      -Profile <名>   默认 web
      -Ref <引用>     默认 main（分支/tag/sha）；要可复现就传 sha
      -Repo <owner/repo>  默认 wooyoojoo/dsh-image-gen
      -DshDir <路径>  能跑 pnpm dsh 的那个目录
      -Proxy <地址>   如 http://127.0.0.1:20368；传 none 强制不用
      -NoVerify       跳过 ④⑤ 自检
      -NoPause        跑完不暂停（默认暂停，因为**双击**运行时窗口跑完就关，看不到结果）
      -Help           只看用法

    实测：PowerShell 5.1 下用 cmd 双击等效与 PowerShell 调用两种方式都通过（含参数透传与中文显示）；
    在无关目录零参数运行也能靠"记住的 DSH 目录"跑通（退出码 0）。
#>
[CmdletBinding()]
param(
    [string]$Profile = 'web',
    [string]$Ref = 'main',
    [string]$Repo = 'wooyoojoo/dsh-image-gen',
    [string]$DshDir = '',
    [string]$Proxy = '',
    [switch]$NoVerify,
    [switch]$NoPause,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    !   $msg" -ForegroundColor Yellow }
# 双击运行 .cmd 时，窗口跑完就关 —— 默认暂停一下让人看到结果；自动化调用传 -NoPause。
function Pause-IfNeeded { if (-not $NoPause) { Write-Host ""; Write-Host "按回车关闭…" -ForegroundColor DarkGray; $null = Read-Host } }
function Fail($msg) { Write-Host "`n[失败] $msg" -ForegroundColor Red; Pause-IfNeeded; exit 1 }

if ($Help) {
    Write-Host @"
dsh-imagegen 一键安装 / 更新

  install.cmd                        装/更新到最新（幂等）
  install.cmd -Profile img           装到别的 profile
  install.cmd -Ref <sha>             固定到某个 sha（可复现）
  install.cmd -DshDir <DSH 目录>     显式指定 DSH 检出目录（第一次给过就记住了）
  install.cmd -Proxy <地址>          手动指定代理（none = 不用）
  install.cmd -NoVerify              跳过装后自检
  install.cmd -Help                  本用法

  状态文件（记住的 DSH 目录）：%DSH_HOME%\.dsh\imagegen-install.json（默认 ~/.dsh/）
  完成后需**重启 DSH**：改 index.js 必须重启才生效（cordis-plugin-hmr 是 disabled 的）。
"@
    exit 0
}

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
# 解析顺序：-DshDir → $env:DSH_DIR → **上次记住的**（状态文件）→ 从当前目录向上搜。
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$stateFile = Join-Path $dshHome 'imagegen-install.json'
$remembered = $null
if (Test-Path $stateFile) {
    try { $remembered = (Get-Content $stateFile -Raw | ConvertFrom-Json).dshDir } catch { }
}

if (-not $DshDir) { $DshDir = $env:DSH_DIR }
if (-not $DshDir -and $remembered -and (Test-Path $remembered)) {
    $DshDir = $remembered
    Write-Ok "DSH 目录：用上次记住的 $DshDir（想换用 -DshDir）"
}
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

try {
    if (-not (Test-Path $dshHome)) { New-Item -ItemType Directory -Force -Path $dshHome | Out-Null }
    @{ dshDir = "$DshDir"; profile = "$Profile"; lastRef = "$Ref"; updatedAt = (Get-Date).ToString('s') } |
        ConvertTo-Json | Set-Content -Path $stateFile -Encoding UTF8
} catch { Write-Warn2 "没能记住 DSH 目录（$stateFile）：$($_.Exception.Message)" }

# ---------- 3. 安装 / 更新 ----------
$spec = "github:$Repo#$Ref"
Write-Step "安装：pnpm dsh plugin --profile $Profile add $spec"
Push-Location $DshDir
try {
    # ⚠️ 原生命令（pnpm / node / git）把进度写到 stderr，而 PowerShell 5.1 在
    # $ErrorActionPreference='Stop' 下会把那当成致命错误直接终止 —— 实测踩过。
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
Pause-IfNeeded
exit 0
