# Operations — 24/7 hosting & recovery runbook (Windows)

Everything below was applied and verified on the authoring machine (Windows, admin shell,
`openclaw 2026.7.1-2`, DSH web on `127.0.0.1:3080`, OpenClaw gateway on `127.0.0.1:18789`).

## Goal

Keep OpenClaw working around the clock and immune to closing the laptop lid. Two layers are needed:

1. the OS must not sleep on idle/lid-close;
2. OpenClaw (gateway + WeChat channel) must start by itself at logon, and its model backend (DSH
   engine) must be running.

## Layer 1 — power

Run as Administrator (idempotent):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ensure-power.ps1
```

What it does: disables standby and hibernate (AC + DC) on every power scheme present, and attempts
lid-close = do-nothing. **Known platform quirk:** the verified machine's Windows build does not
enumerate a lid action at all (`LIDACTION` absent from every scheme), so disabling sleep/hibernate
is the effective guard there — closing the lid cannot enter S3 because no sleep state will trigger.
If your laptop still has OEM-controlled lid behavior, also check the vendor power app.

## Layer 2 — autostart

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-autostart.ps1
```

Registers two logon Scheduled Tasks:

| Task | Action | Purpose |
|---|---|---|
| `DSH-Harness` | `scripts/ensure-dsh-web.ps1` | start `dsh web` at logon only if port 3080 is not already serving; afterwards probes and logs engine route state |
| `OpenClaw Gateway` | `openclaw gateway install` + start | headless gateway with the persisted WeChat (`openclaw-weixin`) channel and `dsh/dsh-agent` model |

`openclaw gateway install` also generates and persists a gateway auth token. The gateway serves the
dashboard and the WeChat monitor independently of any terminal session.

## Runtime layout (verified state)

```
WeChat  ──►  OpenClaw Gateway (Scheduled Task, pid …, :18789)
                 │  model = dsh/dsh-agent
                 ▼
DSH web (:3080)  ──  /dsh-engine/v1/chat/completions
                 └  spawns a one-shot DSH child agent (model + tools) per request
```

OpenClaw config keys in `~/.openclaw/openclaw.json`:

- `models.providers.dsh.{api:"openai-completions", baseUrl:"http://127.0.0.1:3080/dsh-engine/v1", apiKey:"dsh-oc-engine", models:[{id:"dsh-agent",…}]}`
- `agents.defaults.model = dsh/dsh-agent`
- `plugins.entries.openclaw-weixin.enabled = true`, `plugins.allow = ["openclaw-weixin"]`

## Recovery — after a DSH restart (important)

The **engine is a DSH dynamic plugin**, and dynamic plugins are session-scoped: a DSH process
restart clears them (routes `/dsh-engine/*` disappear). The scheduled tasks above restart DSH and
OpenClaw, but they **cannot** reload the engine headlessly — DSH offers no supported host-level
mount point for a user-owned plugin that owns process-global web routes (they belong to the host
plane; agent presets are per-session and route registration would collide across sessions).

Recovery is therefore a two-minute manual step in any DSH session:

1. In the session, define & run the dynamic plugin whose host half serves `/dsh-engine/v1`
   (`src/dsh-openclaw-engine.js` is the full integrated single plugin; a compact engine-only host
   is documented in the repo history/PRs and the current session card `oceng-1`).
2. Verify: `curl -H "Authorization: Bearer dsh-oc-engine" http://127.0.0.1:3080/dsh-engine/v1/models`
3. Check the gateway still points at `/dsh-engine/v1`
   (`openclaw config get models.providers.dsh.baseUrl`), then send a WeChat message to confirm.

`scripts/ensure-dsh-web.ps1` already logs whether the engine route is served after each DSH start,
so a scheduled health check can alert you that step 1 is due.

## Notes / caveats

- Keep the machine on AC. Windows scheduled tasks default to not running on battery, and critical
  battery shutdown cannot be disabled.
- Windows updates and driver updates can reset power plans or the tasks; re-run
  `scripts/ensure-power.ps1` and `scripts/setup-autostart.ps1` after major updates.
- Gateway auth token + `apiKey` are stored plainly in `~/.openclaw/openclaw.json` — local-machine
  trust only. Never expose ports 3080/18789 beyond loopback (gateway binds loopback; keep DSH web
  loopback-bound too).
- Dynamic-plugin history in this repo (`docs/TROUBLESHOOTING.md`) documents why route prefixes were
  bumped (`/dsh-engine/v1` → `/v2` → back to `/v1` after restarts cleared zombie routes). Canonical
  prefix is `/dsh-engine/v1`.
