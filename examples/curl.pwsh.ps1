# Smoke tests for the DSH OpenAI-compatible engine.
# Run from a PowerShell prompt. Adjust BASE/TOKEN if you changed DEFAULT_OPTIONS.
$ErrorActionPreference = 'Stop'
$BASE  = 'http://127.0.0.1:3080/dsh-engine/v1'
$TOKEN = 'dsh-oc-engine'

Write-Host '== 1) list models (probe route, also used by OpenClaw local-model preflight) =='
curl.exe -s -i -H "Authorization: Bearer $TOKEN" "$BASE/models"

Write-Host ''
Write-Host '== 2) chat completion, non-streaming (expect 401 without token) =='
curl.exe -s -o NUL -w 'no-auth HTTP %{http_code}`n' -X POST "$BASE/chat/completions" `
  -H 'Content-Type: application/json' -d '{"model":"dsh-agent","messages":[{"role":"user","content":"hi"}]}'

Write-Host ''
Write-Host '== 3) chat completion, streaming (engine runs a full DSH child agent with tools) =='
$body = '{"model":"dsh-agent","messages":[{"role":"user","content":"Reply with exactly: ok"}],"stream":true}'
curl.exe -s -N -m 180 -X POST "$BASE/chat/completions" `
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d $body
