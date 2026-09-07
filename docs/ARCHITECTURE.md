# Architecture

## Two directions, one plugin

```
 A. DSH -> OpenClaw (bridge tools + skill import)
    DSH session model tool
      openclaw_run / openclaw_delegate / openclaw_send_message / openclaw_memory_search /
      openclaw_config_get / openclaw_diagnose        ->  `openclaw <argv>` (host shell, full access)
    openclaw_skills_import                            ->  scans <root>/**/SKILL.md and registers oc-* skills
                                                          into the DSH `skills` registry (runtime layer)

 B. OpenClaw -> DSH (engine: DSH is the model AND the tools)   <-- headline
    OpenClaw main agent (model = dsh/dsh-agent)
        |  OpenAI-compatible (api: openai-completions)
        v
    DSH web server (loopback)   http://127.0.0.1:3080/dsh-engine/v1/chat/completions
        |  plugin handler: bearer check -> build prompt from messages -> enqueue
        v
    subagents.start(provider="spawn", { prompt, parent = live session agent, signal })
        |  DSH child agent: full DSH toolset + model (inherits session provider)
        v
    run.result.output -> text  ->  JSON or SSE chunks (OpenAI shape) -> OpenClaw -> channel reply
```

## Route contract

| Route | Method | Auth | Body | Response |
|---|---|---|---|---|
| `{base}/models` | GET | none (probe) | – | `{object:"list", data:[{id:<model>}]}` + `x-dsh-engine` debug header |
| `{base}/chat/completions` | POST | `Authorization: Bearer <token>` | OpenAI chat payload (`model`, `messages`, `stream?`) | `chat.completion` JSON or SSE stream (`data: {chunk}\n\n` … `data: [DONE]`) |

`{base}` defaults to `/dsh-engine/v1` on the DSH web server (port from the harness, here 3080).
`model` id is accepted verbatim and echoed; the engine always runs the same DSH child turn.

## Execution semantics

- One chat request == one **one-shot DSH subagent turn** (`label: oc-engine`), parented to a live
  session agent so the child inherits the session's model route, workspace and full tool surface.
- Replies are the child's final assistant text (`ContentBlock[]` → text). Tool use happens *inside*
  DSH, invisible to OpenClaw, which only consumes final text — this is what "OpenClaw uses DSH as
  model AND tools" means in practice.
- Requests are serialized (`enqueue`, single-flight). Client disconnect aborts the child when
  `AbortController` exists; otherwise a no-op signal is used.
- Concurrency/authority guardrail: every inbound chat call can drive DSH tools. Only register the
  route on a loopback-bound server and keep the bearer token secret.

## DSH-side configuration knobs (DEFAULT_OPTIONS)

| Option | Default | Meaning |
|---|---|---|
| `engineBase` | `/dsh-engine/v1` | route prefix on the DSH web server |
| `engineToken` | `dsh-oc-engine` | bearer token for `/chat/completions` |
| `engineModel` | `dsh-agent` | model id advertised + echoed |
| `maxPromptChars` | 60000 | prompt cap per request |
| `cliSandboxMode` | `danger-full-access` | shell sandbox policy for `openclaw` CLI calls (mirror of the session override used during development; swap to `resolve({})` on confined hosts) |
| `cliCommand` | `openclaw` | CLI command (PATH-resolvable) |

## OpenClaw-side wiring (persisted in openclaw.json)

- `models.providers.dsh.{api:"openai-completions", baseUrl, apiKey, models:[{id:"dsh-agent"}]}`
- `agents.defaults.model = dsh/dsh-agent` (also lands in the agent's `models.json`)

Local OpenAI-compatible providers trust their exact configured `baseUrl` origin, and a non-secret
loopback apiKey is accepted (OpenClaw local-model documentation). The Gateway probes `{base}/models`
before cron/isolated runs.
