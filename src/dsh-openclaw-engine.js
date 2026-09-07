'use strict'
/**
 * dsh-openclaw-bridge — plugin (host half) factory.
 *
 * Exports `createOpenClawEnginePlugin(options)` returning a Cordis Host plugin whose apply(ctx):
 *   1. registers the bridge model tools (openclaw_*) and the skill importer,
 *   2. serves an OpenAI-compatible engine on the DSH web server at ENGINE_BASE
 *      (see README / docs) so OpenClaw can call DSH as its model + tools.
 *
 * The same body can be pasted into the `cordis_define` dynamic-plugin editor (host half) — DSH
 * evaluates plain JavaScript only (no TS/JSX/import); this file only adds the CJS wrapper for
 * repository readability/tests.
 *
 * Requires host services (all optional-read; guarded): shell, fs, skills, sandboxPolicy,
 * webServer, subagents, agents. Anything missing degrades gracefully.
 */

const DEFAULT_OPTIONS = Object.freeze({
  // OpenAI-compatible endpoint defaults (change before loading if 3080 is taken).
  engineBase: '/dsh-engine/v1',
  engineToken: 'dsh-oc-engine',
  engineModel: 'dsh-agent',
  // Cap text sent to a child agent turn per request.
  maxPromptChars: 60000,
  // Shell sandbox policy used for openclaw CLI calls: mirrors the session override on hosts
  // where confined backends are unusable. Swap to sandboxPolicySvc.resolve({}) on confined hosts.
  cliSandboxMode: 'danger-full-access',
  // OpenClaw CLI command name (PATH-resolvable).
  cliCommand: 'openclaw',
})

function slugify(x) {
  return String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-')
}

function createOpenClawEnginePlugin(options = {}) {
  const OPT = Object.assign({}, DEFAULT_OPTIONS, options || {})

  return {
    apply(ctx) {
      // ---- service captures -------------------------------------------------------------
      const shell = ctx.get('shell')
      const fsSvc = ctx.get('fs')
      const skillsSvc = ctx.get('skills')
      const sandboxPolicySvc = ctx.get('sandboxPolicy')
      const webServer = ctx.get('webServer')
      const subagents = ctx.get('subagents')
      const agentsSvc = ctx.get('agents')

      // ---- lifecycle/disposer bookkeeping ------------------------------------------------
      const disposers = [] // every registration returned a disposer; effect-unwound on stop.
      const state = { home: undefined, disposeImported: null }

      // AbortController is NOT guaranteed in the dynamic-host VM; fall back to a no-op signal.
      let AbortCtor = undefined
      try { if (typeof AbortController !== 'undefined') AbortCtor = AbortController } catch (e) { AbortCtor = undefined }

      // ---- tiny shared helpers -----------------------------------------------------------
      function joinPath(base) {
        let out = String(base)
        for (let i = 1; i < arguments.length; i++) {
          const part = String(arguments[i])
          if (!part) continue
          if (out.endsWith('/') || out.endsWith('\\')) out = out.slice(0, -1)
          out += (out.indexOf('\\') >= 0 ? '\\' : '/') + part
        }
        return out
      }
      function quoteArg(v) {
        return "'" + String(v).replace(/'/g, "''") + "'"
      }
      // Host shell is PowerShell on Windows: the command name must stay bare; only args are quoted.
      function buildCommand(argv) {
        const rest = ['--no-color'].concat(argv.map(String))
        return OPT.cliCommand + ' ' + rest.map(quoteArg).join(' ')
      }
      function clamp(s, max) {
        const t = String(s || '')
        return t.length > max ? t.slice(0, max) + '\n...[truncated]' : t
      }
      function renderValue(value) {
        let out
        try { out = JSON.stringify(value, null, 2) } catch (e) { out = String(value) }
        return out.length > 16000 ? out.slice(0, 16000) + '\n...[truncated]' : out
      }
      function fullAccessPolicy() {
        if (!sandboxPolicySvc) return undefined
        try { return sandboxPolicySvc.resolve({ mode: OPT.cliSandboxMode }) } catch (e) { return undefined }
      }
      function makeSignal(ctrl) {
        if (ctrl) return ctrl.signal
        return { aborted: false, onabort: undefined, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false }, throwIfAborted() {} }
      }

      // ---- run one openclaw CLI command ---------------------------------------------------
      async function runCli(argv, exec, opts) {
        if (!shell) return { ok: false, error: 'host shell service unavailable' }
        const timeoutMs = Math.min(Math.max((opts && opts.timeoutMs) || 60000, 1000), 900000)
        const request = { command: buildCommand(argv), timeoutMs, stdoutMaxBytes: 4 * 1024 * 1024 }
        const policy = fullAccessPolicy()
        if (policy) request.sandboxPolicy = policy
        if (exec && exec.signal) request.signal = exec.signal
        try {
          const spec = shell.resolve(request)
          const result = await shell.run(spec)
          return {
            ok: result.exitCode === 0,
            exitCode: result.exitCode,
            timedOut: !!result.timedOut,
            aborted: !!result.aborted,
            stdout: clamp(result.stdout ? result.stdout.text : '', 240000),
            stderr: clamp(result.stderr ? result.stderr.text : '', 120000),
          }
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) }
        }
      }

      // ---- $HOME + OpenClaw skill roots ---------------------------------------------------
      async function getHome() {
        if (state.home !== undefined) return state.home
        state.home = null
        if (!shell) return null
        try {
          const request = { command: 'echo $HOME', timeoutMs: 15000, stdoutMaxBytes: 8192 }
          const policy = fullAccessPolicy()
          if (policy) request.sandboxPolicy = policy
          const spec = shell.resolve(request)
          const result = await shell.run(spec)
          const home = (result.stdout ? result.stdout.text : '').trim()
          if (home) state.home = home
        } catch (e) { /* ignore */ }
        return state.home
      }
      async function defaultRoots() {
        const home = await getHome()
        if (!home) return []
        return [
          joinPath(home, '.openclaw', 'skills'),
          joinPath(home, '.claude', 'skills'),
          joinPath(home, 'AppData', 'Roaming', 'npm', 'node_modules', 'openclaw', 'skills'),
        ]
      }

      // ---- fs helpers ---------------------------------------------------------------------
      async function readFileText(abs) {
        try { return await fsSvc.readText(await fsSvc.resolve(abs)) } catch (e) { return undefined }
      }
      async function listDirNames(abs) {
        try {
          const entries = await fsSvc.listDir(await fsSvc.resolve(abs))
          return (entries || []).map((e) => e && e.name).filter(Boolean)
        } catch (e) { return null }
      }

      // ---- SKILL.md parsing / scanning ----------------------------------------------------
      function parseSkill(text) {
        let src = String(text || '')
        if (src.charCodeAt(0) === 0xfeff) src = src.slice(1)
        const nl = src.indexOf('\n')
        const head = nl < 0 ? src : src.slice(0, nl).trim()
        if (head !== '---') return { name: undefined, description: undefined, body: src }
        const rest = src.slice(nl + 1)
        const endLine = rest.indexOf('\n---')
        if (endLine < 0) return { name: undefined, description: undefined, body: src }
        const fm = rest.slice(0, endLine)
        const body = rest.slice(endLine + '\n---'.length + 1).replace(/^\s*\n/, '').trim()
        let name, description
        fm.split(/\r?\n/).forEach((line) => {
          const m = /^name\s*:\s*(.+)$/.exec(line)
          if (m) name = String(m[1]).trim().replace(/^["']|["']$/g, '')
          const d = /^description\s*:\s*(.+)$/.exec(line)
          if (d) description = String(d[1]).trim().replace(/^["']|["']$/g, '')
        })
        return { name, description, body }
      }
      const MAX_SKILLS = 400
      const MAX_DIRS = 1500
      async function scanRoots(rootAbsList, budget) {
        const found = []
        const roots = []
        for (let ri = 0; ri < rootAbsList.length && found.length < MAX_SKILLS; ri++) {
          const root = rootAbsList[ri]
          let existed = false
          let before = found.length
          const rootMd = await readFileText(joinPath(root, 'SKILL.md'))
          if (rootMd !== undefined) {
            found.push(Object.assign({ dir: root, root }, parseSkill(rootMd)))
            existed = true
          }
          async function walk(dirAbs, depth) {
            if (budget.dirs <= 0 || found.length >= MAX_SKILLS) return
            budget.dirs--
            const names = await listDirNames(dirAbs)
            if (names === null) return
            existed = true
            for (let i = 0; i < names.length && budget.dirs > 0 && found.length < MAX_SKILLS; i++) {
              const childAbs = joinPath(dirAbs, names[i])
              const md = await readFileText(joinPath(childAbs, 'SKILL.md'))
              if (md !== undefined) {
                found.push(Object.assign({ dir: childAbs, root }, parseSkill(md)))
                continue
              }
              if (depth > 1) await walk(childAbs, depth - 1)
            }
          }
          if (budget.dirs > 0) await walk(root, 3)
          roots.push({ root, existed, skills: found.length - before })
        }
        return { roots, skills: found }
      }
      function registerImported(entries) {
        if (!skillsSvc) throw new Error('host skills service unavailable')
        if (state.disposeImported) { try { state.disposeImported() } catch (e) { /* ignore */ } state.disposeImported = null }
        const imported = []
        const errors = []
        const disposerList = []
        const seen = {}
        entries.forEach((entry) => {
          const raw = entry.name || (entry.dir.split(/[\\/]/).pop() || 'skill')
          const name = 'oc-' + slugify(raw)
          if (name === 'oc-') { errors.push({ dir: entry.dir, reason: 'invalid name after slugify' }); return }
          if (seen[name]) { errors.push({ name, reason: 'duplicate within import batch' }); return }
          seen[name] = true
          if (!entry.body) { errors.push({ name, reason: 'empty SKILL.md body' }); return }
          try {
            const disposer = skillsSvc.register({
              name,
              description: entry.description || ('OpenClaw skill imported from ' + entry.dir),
              content: entry.body,
              source: 'runtime',
              resourceBase: { kind: 'directory', path: entry.dir },
            })
            disposerList.push(disposer)
            imported.push({ name, description: entry.description || '', from: entry.dir })
          } catch (e) {
            errors.push({ name, reason: String((e && e.message) || e) })
          }
        })
        state.disposeImported = () => disposerList.forEach((d) => { try { d() } catch (e) { /* ignore */ } })
        if (disposerList.length) {
          ctx.effect(() => () => { try { state.disposeImported && state.disposeImported() } catch (e) { /* ignore */ } })
        }
        return { imported, errors }
      }

      // ---- model-tool helper --------------------------------------------------------------
      function def(name, description, params, execute) {
        return harness.defineTool({
          name,
          description,
          parameters: params,
          output: {
            schema: { type: 'json' },
            render(args, value) { return [{ type: 'text', text: renderValue(value) }] },
          },
          execute,
        })
      }

      // =====================================================================================
      // OpenAI-compatible engine — DSH as OpenClaw's model + tools.
      // =====================================================================================
      const ENGINE_BASE = OPT.engineBase
      let providerName
      if (subagents) {
        try {
          const names = subagents.list()
          const prefer = ['agent', 'spawn', 'fork', 'default']
          for (let i = 0; i < prefer.length && !providerName; i++) {
            if (names.indexOf(prefer[i]) >= 0) providerName = prefer[i]
          }
          if (!providerName && names.length) providerName = names[0]
        } catch (e) { /* ignore */ }
      }
      let queueTail = Promise.resolve()
      function enqueue(fn) {
        const run = queueTail.then(fn, fn)
        queueTail = run.then(() => {}, () => {})
        return run
      }
      function findParent() {
        if (!agentsSvc) return undefined
        try { const cur = agentsSvc.currentInitiator(); if (cur) return cur } catch (e) { /* ignore */ }
        try {
          const list = agentsSvc.list()
          if (list && list.length) return list[list.length - 1]
        } catch (e) { /* ignore */ }
        return undefined
      }
      function readBody(req) {
        return new Promise((resolve, reject) => {
          const dec = new TextDecoder('utf-8')
          let text = ''
          req.on('data', (c) => { text += dec.decode(c, { stream: true }) })
          req.on('end', () => { text += dec.decode(); resolve(text) })
          req.on('error', reject)
          req.on('aborted', () => reject(new Error('client aborted request')))
        })
      }
      function blocksToText(blocks) {
        return (blocks || [])
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text).join('\n')
      }
      function msgText(m) {
        if (!m) return ''
        if (typeof m.content === 'string') return m.content
        if (Array.isArray(m.content)) {
          return m.content
            .filter((b) => b && (b.type === 'text' || b.type === 'input_text') && typeof b.text === 'string')
            .map((b) => b.text).join('\n')
        }
        return ''
      }
      function messagesToPrompt(messages) {
        const lines = []
        ;(messages || []).forEach((m) => {
          const role = String(m.role || 'user')
          const text = msgText(m)
          if (!text) return
          if (role === 'system') lines.push('[system instruction]\n' + text)
          else if (role === 'assistant') lines.push('[assistant context]\n' + text)
          else if (role === 'tool') lines.push('[tool result]\n' + text)
          else lines.push('[user]\n' + text)
        })
        let prompt = lines.join('\n\n')
        if (!prompt) prompt = '(empty request)'
        if (prompt.length > OPT.maxPromptChars) prompt = prompt.slice(0, OPT.maxPromptChars) + '\n...[truncated]'
        return prompt
      }
      async function runEngineTurn(prompt, signal) {
        if (!subagents || !providerName) throw new Error('DSH engine not ready: subagents provider unavailable')
        const parent = findParent()
        if (!parent) throw new Error('DSH engine not ready: no live parent agent to spawn the turn')
        const run = await subagents.start(providerName, {
          label: 'oc-engine',
          prompt: [{ type: 'text', text: prompt }],
          parent,
          signal,
        })
        let result
        try {
          result = await run.result
        } finally {
          try { await run.dispose() } catch (e) { /* ignore */ }
        }
        const text = blocksToText(result.output)
        if (!text && result.diagnostic) throw new Error('DSH engine child failed: ' + result.diagnostic)
        if (!text && result.stopReason !== 'completed') throw new Error('DSH engine child stopped: ' + result.stopReason)
        if (!text) throw new Error('DSH engine child produced no output (' + result.stopReason + ')')
        return text
      }
      function engineDebug() {
        let port = '?'
        try { if (webServer && typeof webServer.port === 'number') port = String(webServer.port) } catch (e) { /* ignore */ }
        return {
          providers: subagents ? subagents.list() : [],
          chosenProvider: providerName,
          hasParent: !!findParent(),
          port,
          base: ENGINE_BASE,
          abortControllerAvailable: !!AbortCtor,
        }
      }
      function jsonError(res, code, message) {
        try {
          res.writeHead(code, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: String(message), type: 'dsh_engine_error' } }))
        } catch (e) { try { res.destroy() } catch (err) { /* ignore */ } }
      }
      if (webServer) {
        // Effect-owned routes: registering without capturing/disposing would leak them across
        // stop/update until the next DSH process restart (see docs/TROUBLESHOOTING.md).
        disposers.push(webServer.register({
          kind: 'exact',
          path: ENGINE_BASE + '/models',
          handler(req, res) {
            try { if (req && typeof req.resume === 'function') req.resume() } catch (e) { /* ignore */ }
            try {
              res.writeHead(200, {
                'Content-Type': 'application/json',
                'x-dsh-engine': JSON.stringify(engineDebug()),
              })
              res.end(JSON.stringify({ object: 'list', data: [{ id: OPT.engineModel, object: 'model', created: 0, owned_by: 'dsh' }] }))
            } catch (e) {
              jsonError(res, 500, String((e && e.message) || e))
            }
          },
        }))
        disposers.push(webServer.register({
          kind: 'exact',
          path: ENGINE_BASE + '/chat/completions',
          async handler(req, res) {
            try {
              const auth = String(req.headers['authorization'] || '')
              if (auth !== 'Bearer ' + OPT.engineToken) { jsonError(res, 401, 'invalid or missing bearer token'); return }
              let body
              try {
                body = JSON.parse((await readBody(req)) || '{}')
              } catch (e) {
                jsonError(res, 400, 'invalid JSON body: ' + String((e && e.message) || e))
                return
              }
              const messages = Array.isArray(body.messages) ? body.messages : []
              const prompt = messagesToPrompt(messages)
              const model = typeof body.model === 'string' ? body.model : OPT.engineModel
              const stream = !!body.stream
              const ctrl = AbortCtor ? new AbortCtor() : undefined
              if (ctrl) req.on('close', () => { try { ctrl.abort() } catch (e) { /* ignore */ } })
              const signal = makeSignal(ctrl)
              const started = Date.now()
              const chunk = (payload) => 'data: ' + JSON.stringify(payload) + '\n\n'
              let text
              try {
                text = await enqueue(() => runEngineTurn(prompt, signal))
              } catch (e) {
                jsonError(res, 500, String((e && e.message) || e))
                return
              }
              try {
                if (stream) {
                  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
                  res.write(chunk({ id: 'chatcmpl-dsh-' + started, object: 'chat.completion.chunk', created: Math.floor(started / 1000), model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }))
                  res.write(chunk({ id: 'chatcmpl-dsh-' + started, object: 'chat.completion.chunk', created: Math.floor(started / 1000), model, choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] }))
                  res.end('data: [DONE]\n\n')
                } else {
                  res.writeHead(200, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({
                    id: 'chatcmpl-dsh-' + started,
                    object: 'chat.completion',
                    created: Math.floor(started / 1000),
                    model,
                    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
                    usage: {
                      prompt_tokens: Math.ceil(prompt.length / 4),
                      completion_tokens: Math.ceil(text.length / 4),
                      total_tokens: Math.ceil((prompt.length + text.length) / 4),
                    },
                  }))
                }
              } catch (e) {
                if (res.headersSent) { try { res.end('data: [DONE]\n\n') } catch (err) { /* ignore */ } }
                else jsonError(res, 500, String((e && e.message) || e))
              }
            } catch (e) {
              console.error('dsh-engine handler error: ' + String((e && e.message) || e))
              if (!res.headersSent) jsonError(res, 500, String((e && e.message) || e))
              else { try { res.end() } catch (err) { /* ignore */ } }
            }
          },
        }))
      }

      // ---- bridge + importer model tools ----------------------------------------------------
      const tools = [
        def(
          'openclaw_run',
          'Run any non-interactive `openclaw` CLI command against the local OpenClaw install and return its output. Examples: ["skills","list","--json"], ["config","get","agents.defaults.model","--json"], ["channels","list","--json"], ["plugins","list"], ["memory","status"]. Never pass commands that open a TUI or start a foreground daemon (tui, chat, terminal, gateway run) - they hang until the timeout. Prefer the dedicated openclaw_delegate / openclaw_send_message / openclaw_memory_search / openclaw_config_get / openclaw_skills_import tools when they match.',
          {
            args: { type: 'array', items: { type: 'string' }, description: 'openclaw subcommand words and flags (e.g. ["skills","list","--json"]).', required: true },
            timeoutSec: { type: 'integer', description: 'Optional per-call timeout in seconds (default 60, max 900).' },
          },
          async (args, exec) => {
            const argv = Array.isArray(args.args) ? args.args.map(String) : []
            if (!argv.length) return { ok: false, error: 'provide at least one openclaw subcommand word' }
            return runCli(argv, exec, { timeoutMs: ((args.timeoutSec || 60) * 1000) })
          },
        ),
        def(
          'openclaw_diagnose',
          'Inspect the local OpenClaw installation: CLI version, active config file, whether the Gateway is assumed reachable, and which OpenClaw skill roots exist and can be imported into DSH. Run this first when OpenClaw integration seems broken.',
          {},
          async (args, exec) => {
            const out = {}
            const version = await runCli(['--version'], exec, { timeoutMs: 20000 })
            out.version = version.ok ? String(version.stdout).trim() : null
            out.cliReachable = !!version.ok
            if (!version.ok) out.cliError = clamp(String(version.stderr || version.error || ''), 2000)
            const cfg = await runCli(['config', 'file'], exec, { timeoutMs: 20000 })
            out.configFilePath = cfg.ok ? String(cfg.stdout).trim() : clamp(String(cfg.stderr || cfg.stdout || cfg.error || ''), 2000)
            out.home = await getHome()
            const scanned = await scanRoots(await defaultRoots(), { dirs: 900 })
            out.skillRoots = scanned.roots.map((r) => ({ root: r.root, exists: r.existed, skills: r.skills }))
            out.gatewayNote = 'Commands that need the OpenClaw Gateway (message send, agent via gateway, health) require a running `openclaw gateway run`; use openclaw_delegate with local=true for an embedded agent turn.'
            return out
          },
        ),
        def(
          'openclaw_delegate',
          'Ask the local OpenClaw agent to run one turn: `openclaw agent --json -m <message>`. Defaults to the Gateway-hosted agent (start it with `openclaw_run` ["gateway","run"] in the background first, or pass local=true to run the embedded agent with local model keys). Delivery: set deliver=true and optionally replyChannel/replyTo to have the answer posted back to an OpenClaw channel.',
          {
            message: { type: 'string', description: 'The task/instruction body for the OpenClaw agent.', required: true },
            agent: { type: 'string', description: 'OpenClaw agent id (defaults to the configured default agent).' },
            sessionKey: { type: 'string', description: 'Explicit session key to continue an existing conversation.' },
            local: { type: 'boolean', description: 'Run the embedded agent locally instead of via the Gateway (default false).' },
            deliver: { type: 'boolean', description: 'Deliver the reply back to the routing channel (default false).' },
            replyChannel: { type: 'string', description: 'Delivery channel override (e.g. telegram) used together with deliver.' },
            replyTo: { type: 'string', description: 'Delivery target override (e.g. @username or +E.164) used together with deliver.' },
            timeoutSec: { type: 'integer', description: 'Agent timeout in seconds (default 300).' },
          },
          async (args, exec) => {
            if (!args.message) return { ok: false, error: 'message is required' }
            const argv = ['agent', '--json', '-m', String(args.message), '--timeout', String(args.timeoutSec || 300)]
            if (args.agent) argv.push('--agent', String(args.agent))
            if (args.sessionKey) argv.push('--session-key', String(args.sessionKey))
            if (args.local) argv.push('--local')
            if (args.deliver) {
              argv.push('--deliver')
              if (args.replyChannel) argv.push('--reply-channel', String(args.replyChannel))
              if (args.replyTo) argv.push('--reply-to', String(args.replyTo))
            }
            return runCli(argv, exec, { timeoutMs: Math.min(((args.timeoutSec || 300) * 1000) + 15000, 900000) })
          },
        ),
        def(
          'openclaw_send_message',
          'Send a message through a channel connected to the local OpenClaw Gateway: `openclaw message send`. Needs the Gateway running and at least one channel configured. Target formats: WhatsApp/Telegram phone (+E.164) or chat id, Telegram @username, Slack/Discord channel:<id> or user:<id>, etc. Provide message and/or a local media file path.',
          {
            target: { type: 'string', description: 'Recipient: channel-prefixed target or bare id/username/E.164.', required: true },
            message: { type: 'string', description: 'Text body (omit when sending media only).' },
            media: { type: 'string', description: 'Local media file path or URL to attach.' },
            channel: { type: 'string', description: 'Channel name when more than one channel is configured (discord|telegram|whatsapp|...).' },
            account: { type: 'string', description: 'Channel account id override.' },
            replyTo: { type: 'string', description: 'Optional reply-to message id.' },
            silent: { type: 'boolean', description: 'Send without notification (Telegram/Discord).' },
            timeoutSec: { type: 'integer', description: 'Optional timeout in seconds (default 90).' },
          },
          async (args, exec) => {
            if (!args.target) return { ok: false, error: 'target is required' }
            if (!args.message && !args.media) return { ok: false, error: 'provide message or media (or both)' }
            const argv = ['message', 'send', '--json', '--target', String(args.target)]
            if (args.message) argv.push('--message', String(args.message))
            if (args.media) argv.push('--media', String(args.media))
            if (args.channel) argv.push('--channel', String(args.channel))
            if (args.account) argv.push('--account', String(args.account))
            if (args.replyTo) argv.push('--reply-to', String(args.replyTo))
            if (args.silent) argv.push('--silent')
            return runCli(argv, exec, { timeoutMs: ((args.timeoutSec || 90) * 1000) })
          },
        ),
        def(
          'openclaw_memory_search',
          'Search the local OpenClaw semantic memory store: `openclaw memory search <query> --json`. Useful to recall facts the OpenClaw assistant already knows (contacts, plans, notes) before delegating work to it.',
          {
            query: { type: 'string', description: 'Search query text.', required: true },
            maxResults: { type: 'integer', description: 'Maximum number of results (default 5).' },
            agent: { type: 'string', description: 'OpenClaw agent id whose memory to search.' },
            timeoutSec: { type: 'integer', description: 'Optional timeout in seconds (default 90).' },
          },
          async (args, exec) => {
            if (!args.query) return { ok: false, error: 'query is required' }
            const argv = ['memory', 'search', String(args.query), '--json']
            if (args.maxResults && args.maxResults > 0) argv.push('--max-results', String(args.maxResults))
            if (args.agent) argv.push('--agent', String(args.agent))
            return runCli(argv, exec, { timeoutMs: ((args.timeoutSec || 90) * 1000) })
          },
        ),
        def(
          'openclaw_config_get',
          'Read one value from the local OpenClaw openclaw.json config by dotted/bracket path, e.g. agents.defaults.model, agents.defaults.workspace, channels. Secrets are redacted by OpenClaw. Secrets are never printed by OpenClaw config get.',
          {
            path: { type: 'string', description: 'Config path in dot or bracket notation (e.g. agents.defaults.workspace).', required: true },
            timeoutSec: { type: 'integer', description: 'Optional timeout in seconds (default 30).' },
          },
          async (args, exec) => {
            if (!args.path) return { ok: false, error: 'path is required' }
            return runCli(['config', 'get', String(args.path), '--json'], exec, { timeoutMs: ((args.timeoutSec || 30) * 1000) })
          },
        ),
        def(
          'openclaw_skills_import',
          'Scan OpenClaw skill roots for SKILL.md folders and import them into the DSH skill catalog as oc-<name> runtime skills (replacing the previous import). Default roots: ~/.openclaw/skills, ~/.claude/skills and the installed openclaw package skills dir; pass extra roots (absolute paths) to add more. Use dryRun=true to preview without registering.',
          {
            roots: { type: 'array', items: { type: 'string' }, description: 'Optional extra absolute skill-root directories to scan.' },
            includeDefaults: { type: 'boolean', description: 'Also scan default roots when roots are given (default true).' },
            dryRun: { type: 'boolean', description: 'Only scan and report; do not register skills (default false).' },
          },
          async (args, exec) => {
            if (!fsSvc || !skillsSvc) return { ok: false, error: 'fs or skills host service unavailable' }
            let list = []
            if (Array.isArray(args.roots)) list = list.concat(args.roots.filter(Boolean).map(String))
            if (args.includeDefaults !== false) list = list.concat(await defaultRoots())
            const seen = {}
            list = list.filter((p) => { if (!p || seen[p]) return false; seen[p] = true; return true })
            if (!list.length) return { ok: false, error: 'no skill roots to scan' }
            const scanned = await scanRoots(list, { dirs: MAX_DIRS })
            const base = {
              ok: true,
              dryRun: !!args.dryRun,
              scanned: scanned.roots.map((r) => ({ root: r.root, exists: r.existed, skillsFound: r.skills })),
              totalSkillsFound: scanned.skills.length,
            }
            if (args.dryRun) {
              base.preview = scanned.skills.map((s) => ({ dir: s.dir, name: s.name || (s.dir.split(/[\\/]/).pop() || ''), description: s.description || '' }))
              return base
            }
            const outcome = registerImported(scanned.skills)
            base.imported = outcome.imported
            base.errors = outcome.errors
            return base
          },
        ),
        def(
          'ocengine_diagnose',
          'Diagnose the DSH OpenAI-compatible engine that OpenClaw uses as its model+tools backend: webServer port, discovered subagent providers, chosen provider, live parent-agent availability, engine base path and token name. Call this when OpenClaw reports it cannot reach the dsh provider.',
          {},
          async () => engineDebug(),
        ),
      ]

      // ---- registration & cleanup -----------------------------------------------------------
      tools.forEach((tool) => { disposers.push(harness.registerTool(ctx, tool)) })
      ctx.effect(() => () => {
        disposers.forEach((d) => { try { d() } catch (e) { /* ignore */ } })
        try { state.disposeImported && state.disposeImported() } catch (e) { /* ignore */ }
      })
      console.log('dsh-openclaw: engine=' + ENGINE_BASE + ' provider=' + providerName + ' tools=' + tools.length)
    },
  }
}

module.exports = { createOpenClawEnginePlugin, DEFAULT_OPTIONS }
