# ensure-power.ps1 — make the machine stay awake for 24/7 OpenClaw hosting.
# Run as Administrator (idempotent; safe to re-run).
#  - disables sleep (standby) and hibernate on every power scheme, AC and DC
#  - tries to set lid-close to "do nothing" (skipped silently where the OS does not enumerate a lid)
#  - keeps the active scheme unchanged

$ErrorActionPreference = 'Continue'

$schemes = @(
  '27fa6203-3987-4dcc-918d-748559d549ec', # Performance
  '381b4222-f694-41f0-9685-ff5bb260df2e', # 平衡 (Balanced)
  '64a64f24-65b9-4b56-befd-5ec1eaced9b3', # Slient (active on this machine)
  '6fecc5ae-f350-48a5-b669-b472cb895ccf'  # Turbo
)
$lidSubgroup = '4f971e89-eebd-4455-a8de-9e59040e7347'   # SUB_BUTTONS
$lidSetting   = '5ca83367-6e45-459f-a27b-476b1d01c936'   # LIDACTION (may be absent)
$activeMatch = (powercfg /getactivescheme) -join "`n" | Select-String -Pattern '([0-9a-f]{8}-[0-9a-f-]{27})'
$activeBefore = $null
if ($activeMatch) { $activeBefore = $activeMatch.Matches[0].Groups[1].Value }

foreach ($s in $schemes) {
  powercfg /setacvalueindex $s SUB_SLEEP STANDBYIDLE 0 | Out-Null
  powercfg /setdcvalueindex $s SUB_SLEEP STANDBYIDLE 0 | Out-Null
  powercfg /setacvalueindex $s SUB_SLEEP HIBERNATEIDLE 0 | Out-Null
  powercfg /setdcvalueindex $s SUB_SLEEP HIBERNATEIDLE 0 | Out-Null
  # lid-close -> do nothing; ignore failures where the OS exposes no lid setting
  powercfg /setacvalueindex $s $lidSubgroup $lidSetting 0 2>$null | Out-Null
  powercfg /setdcvalueindex $s $lidSubgroup $lidSetting 0 2>$null | Out-Null
  Write-Host "  hardened scheme $s (sleep=never, hibernate=never)"
}
if ($activeBefore) { powercfg /setactive $activeBefore | Out-Null }

Write-Host ''
Write-Host 'Current active scheme:'
powercfg /getactivescheme
Write-Host ''
Write-Host 'Active scheme STANDBYIDLE (AC/DC) and HIBERNATEIDLE (AC/DC):'
powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE  | Select-String -Pattern 'current AC|current DC|当前交流|当前直流' | ForEach-Object { $_.Line.Trim() }
powercfg /q SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE | Select-String -Pattern 'current AC|current DC|当前交流|当前直流' | ForEach-Object { $_.Line.Trim() }
Write-Host ''
Write-Host 'Note: if this OS does not enumerate a lid action (LIDACTION absent), disabling'
Write-Host 'sleep/hibernate is what prevents lid-close suspension on this machine.'
