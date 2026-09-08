# setup-autostart.ps1 — register the two autostart Scheduled Tasks that keep the
# DSH <-> OpenClaw pair running across reboots/logons.
# Run as Administrator. Idempotent (uses /f to overwrite).
#
#  1. "DSH-Harness"      -> runs scripts/ensure-dsh-web.ps1 at logon: starts `dsh web`
#                          only when the dashboard port 3080 is not already serving.
#  2. "OpenClaw Gateway" -> `openclaw gateway install` registers a logon task that runs
#                          `openclaw gateway --port 18789` with the persisted weixin channel.
$ErrorActionPreference = 'Stop'

$guard = Join-Path $PSScriptRoot 'ensure-dsh-web.ps1'
if (-not (Test-Path $guard)) { throw "guard not found: $guard" }

Write-Host '== 1) DSH-Harness (logon autostart for DeepSeek Harness web / engine host) =='
schtasks /create /tn 'DSH-Harness' /tr "powershell -NoProfile -ExecutionPolicy Bypass -File $guard" /sc onlogon /rl LIMITED /f
schtasks /run  /tn 'DSH-Harness' | Out-Null

Write-Host '== 2) OpenClaw Gateway service task =='
& openclaw gateway install
Write-Host '   starting gateway task...'
schtasks /run /tn 'OpenClaw Gateway' | Out-Null

Start-Sleep -Seconds 8
Write-Host ''
Write-Host '== verify =='
schtasks /query /fo LIST | Select-String -Pattern 'DSH-Harness|OpenClaw Gateway' | ForEach-Object { $_.Line.Trim() }
& openclaw gateway status | Select-String -Pattern 'Service:|Runtime:|Gateway process' | ForEach-Object { $_.Line.Trim() }
