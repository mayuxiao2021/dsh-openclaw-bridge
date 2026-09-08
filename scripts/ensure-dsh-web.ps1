# ensure-dsh-web.ps1 — start the DeepSeek Harness web process if it is not already
# listening on its dashboard port. Registered as the "DSH-Harness" scheduled task at logon so
# the DSH OpenAI engine (and this repo's plugin) can come back automatically after a reboot/logon.
$ErrorActionPreference = 'SilentlyContinue'

$probe = $null
try { $probe = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/' -TimeoutSec 3 -UseBasicParsing } catch { $probe = $null }
if ($probe -and $probe.StatusCode -ge 200) { exit 0 }   # already running — never double-start

$node = 'C:\Program Files\nodejs\node.exe'
$entry = 'C:\Users\mayux\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path $entry)) { exit 2 }

$logDir = 'C:\Users\mayux\.dsh\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$out = Join-Path $logDir 'dsh-web-autostart.log'
$err = Join-Path $logDir 'dsh-web-autostart.err.log'

Start-Process -FilePath $node -ArgumentList $entry, 'web' -WorkingDirectory 'C:\Users\mayux' `
  -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err

# Wait for the dashboard, then log whether the OpenClaw engine route is served.
# The engine itself is a DSH dynamic plugin and cannot be loaded headlessly from this script;
# when unreachable after a DSH restart, reload it in a session (see docs/OPERATIONS.md).
for ($i = 0; $i -lt 30; $i++) {
  try { $p = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/' -TimeoutSec 2 -UseBasicParsing; break } catch { Start-Sleep -Seconds 1 }
}
$engineNote = 'engine /dsh-engine/v1 NOT served yet'
try {
  $e = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/dsh-engine/v1/models' -TimeoutSec 3 -UseBasicParsing -Headers @{ Authorization = 'Bearer dsh-oc-engine' }
  if ($e.StatusCode -ge 200) { $engineNote = 'engine /dsh-engine/v1 served' }
} catch { }
Add-Content -Path $out -Value ("[{0}] {1}" -f (Get-Date -Format s), $engineNote)
exit 0
