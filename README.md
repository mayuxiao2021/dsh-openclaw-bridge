# dsh-openclaw-bridge

Bridge DeepSeek Harness (DSH) and OpenClaw in both directions:

1. **DSH → OpenClaw**: model tools (`openclaw_run`, `openclaw_delegate`, `openclaw_send_message`,
   `openclaw_memory_search`, `openclaw_config_get`, `openclaw_diagnose`) plus OpenClaw `SKILL.md`
   import as `oc-*` runtime skills.
2. **OpenClaw → DSH (this repo's headline)**: a local OpenAI-compatible endpoint
   (`/dsh-engine/v1/chat/completions` + `/dsh-engine/v1/models`) on the DSH web server. Every chat
   request runs a **one-shot DSH child agent with the full DSH toolset** and streams the final text
   back. Point OpenClaw's `models.providers` at it and OpenClaw uses DSH as its model **and** tools —
   no OpenAI key required.
3. **Workspace & session management (integrated in the same single plugin)**: model tools
   `dsh_workspace_list/create/rename/delete/current` and
   `dsh_session_list/rename/archive` so the agent and the OpenClaw engine can administer this
   harness's workspaces and sessions.

Everything is **one plugin** (`src/dsh-openclaw-engine.js`): load it once and you get the bridge
tools, the OpenAI-compatible engine, the skill importer, and workspace/session management together.

Verified end-to-end on Windows with `openclaw 2026.7.1-2` + `@tencent-weixin/openclaw-weixin 2.4.8`:
WeChat inbound → OpenClaw main agent (`dsh/dsh-agent`) → `POST http://127.0.0.1:3080/dsh-engine/v1/chat/completions`
→ DSH child agent (model + tools) → streamed reply → WeChat outbound `text sent OK`.

## Repository layout

```
src/dsh-openclaw-engine.js      the plugin (host half) as a factory: createOpenClawEnginePlugin(opts)
examples/openclaw-provider.patch.json   openclaw.json patch that registers the dsh provider
examples/curl.pwsh.ps1                 smoke-test requests for /models and /chat/completions
docs/ARCHITECTURE.md                   data flow, route contract, config reference
docs/LOADING.md                        how to run it inside DSH today (dynamic plugin) and notes for mounting in a preset
docs/TROUBLESHOOTING.md                every integration bug this repo hit and its fix
LICENSE  MIT
```

## Quick start (current DSH dynamic-plugin path)

The plugin is a **Host Cordis plugin**. The simplest supported way today is to load it as a dynamic
plugin with the `cordis_define` / `cordis_run` tools of a DSH session (paste the `apply` body from
`src/dsh-openclaw-engine.js`), then, in OpenClaw:

```bash
openclaw config patch --file examples/openclaw-provider.patch.json   # registers provider "dsh"
openclaw config set agents.defaults.model dsh/dsh-agent
openclaw gateway restart                                             # or run the gateway
```

Engine endpoint (defaults, all overridable in `DEFAULT_OPTIONS`):

| Item  | Value |
|-------|-------|
| models | `GET /dsh-engine/v1/models` |
| chat   | `POST /dsh-engine/v1/chat/completions` (stream + non-stream, OpenAI shape) |
| auth   | `Authorization: Bearer dsh-oc-engine` (chat only; models is open for probes) |
| model id | `dsh-agent` |

Each chat call spawns one one-shot DSH child agent (provider `spawn`/`fork`, parent = a live session
agent) whose reply text is returned. Requests are serialized through a single-flight queue and are
cancellable on client disconnect when `AbortController` is available.

## Security notes

- Bind is loopback-only (the DSH web server). The bearer token gates tool-driving chat calls; anyone
  on the host with the token can make DSH execute its tools (files, commands). Keep the token secret
  and do not expose port 3080 publicly.
- Web-server routes registered by this plugin are **effect-owned**: they are removed when the plugin
  stops/updates. (An earlier draft leaked routes on stop; see TROUBLESHOOTING.)

## Reproducing the verified fix history

All non-obvious fixes discovered while building this (PowerShell host-shell quoting, missing
`AbortController` in the sandbox VM, effect-owned route disposal, `joinPath` arity, custom-provider
config schema, JSON quoting through `openclaw config set`) are documented in `docs/TROUBLESHOOTING.md`.

## License

MIT
