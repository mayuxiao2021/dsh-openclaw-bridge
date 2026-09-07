# Loading the plugin in DSH

## Option A — dynamic plugin in a running session (used and verified)

In any DSH session that exposes the Cordis tools (`cordis_define`, `cordis_run`):

1. Open `src/dsh-openclaw-engine.js`, copy the body of the function returned by
   `createOpenClawEnginePlugin(...)` — i.e. the `{ apply(ctx) { ... } }` object — and paste it as
   the **host half** of `cordis_define`:

   ```jsonc
   {
     "plugin": { "kind": "new", "idPrefix": "oclaw" },
     "name": "OpenClaw Bridge & DSH Engine",
     "purpose": "Bridge + OpenAI-compatible engine so OpenClaw can call DSH as model & tools.",
     "code": { "host": "return { apply(ctx) { /* ...past here... */ } }" }
   }
   ```

2. `cordis_run` with mode `run`; the plugin registers 8 model tools and the two engine routes.
3. Point OpenClaw at it (see README): `openclaw config patch --file examples/openclaw-provider.patch.json`
   then `openclaw config set agents.defaults.model dsh/dsh-agent`, restart/run the Gateway.

The dynamic plugin is process-local: it and its routes disappear when the DSH process restarts.

## Option B — mount in an agent preset (deployment-level, so it survives restarts)

The publishable long-term form is a DSH agent preset (`~/.dsh/.agent-presets/<id>/`) whose Cordis
composition mounts this plugin row so every session under the preset gets the tools + engine
automatically. Mounting rules differ from dynamic plugins (plugin row in `cordis.yml`, scope/layer
placement, service availability for `webServer`/`subagents` must be confirmed in the host
composition).

> Status: this path is **documented but not yet validated** in this repo — mounting a plugin that
> registers web-server routes and spawns subagents needs a host-composition review (which services
> the row's context can reach, `webServer` is host-scoped, etc.). Until validated, prefer Option A
> and keep the gateway/DSH processes running under a supervisor.

## Keeping the pair alive

- DSH must stay running while OpenClaw calls it (the engine lives in the DSH process).
- OpenClaw Gateway can run via `openclaw gateway run` (foreground/daemon) or
  `openclaw gateway install` (Windows Scheduled Task).
