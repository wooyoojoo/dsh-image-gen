@echo off
rem One-click install/update for dsh-imagegen.
rem
rem Why a .cmd wrapper instead of shipping only a .ps1:
rem   1. A bare .ps1 is refused when the PowerShell execution policy is Restricted
rem      ("running scripts is disabled on this system"), the default on many boxes.
rem      The bypass here keeps the entry point one double-clickable file.
rem   2. Windows PowerShell 5.1 reads a .ps1 as ANSI unless it carries a UTF-8 BOM,
rem      and an ANSI read mangles the Chinese strings badly enough to break parsing.
rem      A BOM-less install.ps1 therefore fails with a confusing syntax error, so the
rem      guard below restores the BOM before PowerShell ever loads the script.
setlocal
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"

"%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = '%~dp0install.ps1'; $b = [IO.File]::ReadAllBytes($p); if (-not ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)) { [IO.File]::WriteAllText($p, [Text.Encoding]::UTF8.GetString($b), (New-Object Text.UTF8Encoding($true))); Write-Host 'install.cmd: restored the missing UTF-8 BOM on install.ps1' -ForegroundColor Yellow }"
if errorlevel 1 exit /b 1

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %ERRORLEVEL%
