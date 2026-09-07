# Troubleshooting — issues hit while building this and their fixes

Every entry below was reproduced on Windows (openclaw 2026.7.1-2, DSH host runner) and fixed in the
current source. Keep this list next to the code.

## 1. Host shell is PowerShell — bash-style quoting breaks the command

Symptom: `openclaw` calls return a PowerShell parser error like
`Unexpected token ''--no-color'' in expression or statement.`

Cause: building `'openclaw' '--no-color' '--version'` (quoted command name + quoted args) is valid
bash but not PowerShell.

Fix: keep the command name bare and quote only the arguments:
`openclaw '--no-color' '--version'`. PowerShell single-quote literal: `'` doubled inside (`it''s`).

## 2. sandbox refuses `workspace-write` — no confined backend usable

Symptom: shell execution from the plugin fails with
`sandbox mode "workspace-write" is requested but no sandbox backend is usable ... windows-acl-run:
Windows ACL temp root must be outside the workspace`.

Cause: this deployment has no working confined backend and the tool runs under the deployment
default mode.

Fix: pass an explicit resolved policy:
`sandboxPolicy.resolve({ mode: 'danger-full-access' })` as `request.sandboxPolicy` for CLI calls
(and read it via the `sandboxPolicy` host service). This mirrors the session override the built-in
shell tool runs under. On hosts with a working confined backend, swap to `sandboxPolicy.resolve({})`
to stay sandboxed. All CLI calls are wrapped in try/catch returning `{ok:false, error}` instead of
throwing.

## 3. `AbortController` is missing inside the dynamic-host VM

Symptom: chat requests with a valid body answered with a bare `400 Bad Request` with no body and no
`Content-Type`.

Cause: the web server turns any route-handler exception into a bare 400; `new AbortController()`
threw (`AbortController` is not a declared sandbox builtin), and the throw sat outside the handler's
inner try/catch.

Fix (three layers):
- detect `AbortController` availability and fall back to a no-op `AbortSignal`-shaped object,
- drain the request body and wrap handler logic in an outer try/catch that always returns a
  structured JSON error,
- route errors are never returned as bare 400s.

## 4. web-server routes leaked across stop/update — duplicate route on reload

Symptom: updating the plugin failed with
`webserver: duplicate exact route "/..."`; stopping the old run did not clear it.

Cause: `webServer.register(route)` returns a disposer that the first draft ignored, so routes stayed
in the route table after the plugin stopped. They could only be removed by restarting the DSH
process (they are process-local).

Fix: capture every `webServer.register(...)` result into a `disposers` list and unwinding it in a
single `ctx.effect(() => () => {...})`, together with the tool registrations and imported skills.
Also: if you ever deploy a new version while a leaked old route exists, move the route prefix
(`/dsh-engine/v1`) — after the next DSH restart the zombie route is gone and the canonical prefix
can be reused.

## 5. Default skill-root paths pointed at the wrong directories

Symptom: diagnose/import scanned `~/.openclaw`, `~/.claude`, `AppData` (not `<home>/AppData/...`)
and reported junk counts.

Cause: the path helper joined only two segments (`joinPath(base, child)`) while call sites passed
three arguments; the third was silently dropped.

Fix: variadic `joinPath(base, ...parts)`; default roots are now the real
`~/.openclaw/skills`, `~/.claude/skills`, `<npm-global>/node_modules/openclaw/skills`.

## 6. `openclaw config set <object-path>` validation rejects partial providers

Symptom: setting `models.providers.dsh.api` alone fails with
`custom model providers must declare baseUrl/models ...`.

Cause: `openclaw config set` validates the whole document per write; a custom provider is only valid
once baseUrl+api+models exist together. (Also: `--strict-json` values lose their `"` double quotes
through the Windows CLI arg parsing.)

Fix: write the complete subtree in one atomic edit with a patch file:
`openclaw config patch --file examples/openclaw-provider.patch.json`
For single values use plain strings without `--strict-json`.

## 7. `openclaw agent` (Gateway mode) requires ws credentials

Symptom: `openclaw agent -m ...` fails with
`GatewayCredentialsRequiredError ... configure gateway.auth token/password, pair this device ...`

Cause: the agent control channel authenticates with a gateway auth token/device pairing, while other
CLI probes run with `auth none`.

Fix: use `openclaw agent --local --agent main -m ...` for a quick local turn, or persist a gateway
auth token (`gateway.auth.mode: token` + `gateway.auth.token`). Note the **inbound channel lane**
(WeChat → main agent) runs inside the Gateway process and does not need those ws credentials — that
path works with `auth none`, which is what the end-to-end WeChat test exercised.

## 8. WeChat login saved but the running gateway did not start the channel

Symptom: after QR login: `the running gateway did not restart it: gateway channels.start requires
credentials ...`.

Fix: restart the Gateway after login (`openclaw gateway restart` / stop+run). The weixin channel
monitor then starts from the saved account (`weixin monitor started ... account=...-im-bot`).

## 9. Config-file gateway boot guard

Symptom: `openclaw gateway run` exits with
`Gateway start blocked: existing config is missing gateway.mode`.

Fix: `openclaw config set gateway.mode local` (or re-run onboard/setup) before starting.

## 10. A failed apply can leave zombie routes that outlive stop

Symptom: updating an integrated plugin fails with
`webserver: duplicate exact route "..."` even after `cordis_stop`, and no version of the plugin can
register that path again.

Cause: `apply()` registers web routes **before** registering tools. If a later step throws (e.g. a
tool-name conflict with another plugin), the already-registered routes are not rolled back, so they
survive `cordis_stop` and only disappear at the next DSH process restart. Order-dependent partial
registration is the trap.

Fix:
- when swapping engine versions live, keep the route prefix unique per deployment step (e.g.
  `/dsh-engine/v1` then `/dsh-engine/v2`) and switch the OpenClaw provider `baseUrl` accordingly,
- after the next DSH restart the zombie path is gone and the canonical prefix can be reused,
- long-term, mount the plugin in a composition so apply-time conflicts surface at boot instead of
  mid-session.
