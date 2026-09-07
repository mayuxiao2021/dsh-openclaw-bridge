'use strict'
/**
 * dsh-workspace-manager — DSH workspace & session management plugin (host half).
 *
 * Registers model tools (dynamic-host sandbox, plain JS, no imports):
 *   dsh_workspace_list | dsh_workspace_create | dsh_workspace_rename
 *   dsh_workspace_delete | dsh_workspace_current
 *   dsh_session_list | dsh_session_rename | dsh_session_archive
 *
 * Services (all optional-read, guarded): workspaceRegistry, sessionPersistence,
 * sessionQuery, sessions, sessionTitle, sandboxPolicy. Any missing service
 * degrades per-tool with a clear error instead of crashing apply().
 *
 * Model tools registered via harness.defineTool/registerTool; every registration
 * disposer is unwound through ctx.effect so stop/update cleans up.
 */

function createWorkspaceManagerPlugin() {
  return {
    apply(ctx) {
      const wsr = ctx.get('workspaceRegistry')
      const sessionPers = ctx.get('sessionPersistence')
      const sessionQuerySvc = ctx.get('sessionQuery')
      const sessionStore = ctx.get('sessions')
      const sessionTitleSvc = ctx.get('sessionTitle')
      const sandboxPolicy = ctx.get('sandboxPolicy')

      const disposers = []

      function renderValue(value) {
        let out
        try { out = JSON.stringify(value, null, 2) } catch (e) { out = String(value) }
        return out.length > 16000 ? out.slice(0, 16000) + '\n...[truncated]' : out
      }
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
      function workspaceView(w) {
        if (!w) return null
        return { id: String(w.id), title: String(w.title || ''), path: String(w.path || ''), createdAt: String(w.createdAt || ''), sessionCount: Array.isArray(w.sessionIds) ? w.sessionIds.length : 0 }
      }
      async function currentWorkspace() {
        try {
          const root = sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' ? sandboxPolicy.workspaceRoot : undefined
          if (root && wsr) {
            const w = await wsr.resolveByPath(root)
            if (w) return workspaceView(w)
          }
        } catch (e) { /* ignore */ }
        return undefined
      }
      async function titleOf(sessionId) {
        if (!sessionQuerySvc) return undefined
        try {
          const t = await sessionQuerySvc.readTitle(sessionId)
          if (t && typeof t === 'object') {
            const anyT = t
            if (anyT.title !== undefined && typeof anyT.title === 'string') return anyT.title
            const nested = anyT.titleObservation || anyT
            if (nested && typeof nested.title === 'string') return nested.title
          }
        } catch (e) { /* ignore */ }
        return undefined
      }

      const tools = [
        def(
          'dsh_workspace_list',
          'List the DSH workspaces registered in this harness: id, title, path, session count, plus which workspace the current session/agent belongs to. Use it before dsh_workspace_rename / dsh_workspace_delete.',
          {},
          async () => {
            if (!wsr) return { ok: false, error: 'workspaceRegistry service unavailable' }
            try {
              const all = (await wsr.list()) || []
              const current = await currentWorkspace()
              return {
                ok: true,
                current: current,
                workspaces: all.map(workspaceView),
              }
            } catch (e) {
              return { ok: false, error: String((e && e.message) || e) }
            }
          },
        ),
        def(
          'dsh_workspace_create',
          'Create a new DSH workspace over an existing directory. Default title is the directory basename.',
          {
            path: { type: 'string', description: 'Absolute path of an existing directory for the workspace.', required: true },
            title: { type: 'string', description: 'Optional display title (defaults to the directory basename).' },
          },
          async (args) => {
            if (!wsr) return { ok: false, error: 'workspaceRegistry service unavailable' }
            if (!args.path) return { ok: false, error: 'path is required' }
            try {
              const w = await wsr.create(String(args.path), args.title ? String(args.title) : undefined)
              return { ok: true, workspace: workspaceView(w) }
            } catch (e) {
              return { ok: false, error: String((e && e.message) || e) }
            }
          },
        ),
        def(
          'dsh_workspace_rename',
          'Rename a DSH workspace (display title).',
          {
            id: { type: 'string', description: 'Workspace id (from dsh_workspace_list).', required: true },
            title: { type: 'string', description: 'New display title.', required: true },
          },
          async (args) => {
            if (!wsr) return { ok: false, error: 'workspaceRegistry service unavailable' }
            if (!args.id || !args.title) return { ok: false, error: 'id and title are required' }
            try {
              const w = await wsr.get(String(args.id))
              if (!w) return { ok: false, error: 'workspace not found: ' + args.id }
              await w.setTitle(String(args.title))
              return { ok: true, workspace: workspaceView(w) }
            } catch (e) {
              return { ok: false, error: String((e && e.message) || e) }
            }
          },
        ),
        def(
          'dsh_workspace_delete',
          'Delete a DSH workspace record (does not touch the directory).',
          {
            id: { type: 'string', description: 'Workspace id (from dsh_workspace_list).', required: true },
          },
          async (args) => {
            if (!wsr) return { ok: false, error: 'workspaceRegistry service unavailable' }
            if (!args.id) return { ok: false, error: 'id is required' }
            try {
              await wsr.delete(String(args.id))
              return { ok: true, deleted: String(args.id) }
            } catch (e) {
              return { ok: false, error: String((e && e.message) || e) }
            }
          },
        ),
        def(
          'dsh_workspace_current',
          'Show the DSH workspace the current agent/session is running in (resolved from the session working-directory root).',
          {},
          async () => {
            const current = await currentWorkspace()
            return { ok: true, current }
          },
        ),
        def(
          'dsh_session_list',
          'List DSH sessions (persisted headers): id, cwd, createdAt, origin (subagent?) and best-effort title. Optionally filter to sessions whose cwd belongs to one workspace id.',
          {
            workspaceId: { type: 'string', description: 'Optional workspace id to filter sessions by their cwd.' },
          },
          async (args) => {
            if (!sessionPers) return { ok: false, error: 'sessionPersistence service unavailable' }
            try {
              const headers = (await sessionPers.list()) || []
              const workspaces = wsr ? (await wsr.list()) || [] : []
              const byId = {}
              workspaces.forEach((w) => { byId[String(w.id)] = w })
              const out = []
              for (const h of headers) {
                let workspaceId
                if (h.cwd) {
                  for (const w of workspaces) {
                    const wp = String(w.path).replace(/[\\/]+$/, '')
                    const cw = String(h.cwd).replace(/[\\/]+$/, '')
                    if (cw === wp || cw.startsWith(wp + '\\') || cw.startsWith(wp + '/')) { workspaceId = String(w.id); break }
                  }
                }
                if (args.workspaceId && workspaceId !== String(args.workspaceId)) continue
                const entry = { id: String(h.id) }
                if (h.cwd) entry.cwd = h.cwd
                if (h.createdAt) entry.createdAt = h.createdAt
                if (h.origin) entry.origin = h.origin
                if (h.agentPreset) entry.agentPreset = h.agentPreset
                if (workspaceId) entry.workspaceId = workspaceId
                const t = await titleOf(h.id)
                if (t) entry.title = t
                out.push(entry)
              }
              return { ok: true, total: out.length, sessions: out }
            } catch (e) {
              return { ok: false, error: String((e && e.message) || e) }
            }
          },
        ),
        def(
          'dsh_session_rename',
          'Rename a LIVE DSH session title (only sessions currently loaded in the session store can be renamed).',
          {
            sessionId: { type: 'string', description: 'Session id (from dsh_session_list).', required: true },
            title: { type: 'string', description: 'New session title.', required: true },
          },
          async (args) => {
            if (!sessionStore || !sessionTitleSvc) return { ok: false, error: 'sessions/sessionTitle service unavailable' }
            try {
              const session = sessionStore.get(String(args.sessionId))
              if (!session) return { ok: false, error: 'session is not live in the session store (only active sessions can be renamed)' }
              await sessionTitleSvc.rename(session, String(args.title))
              return { ok: true, sessionId: String(args.sessionId), title: String(args.title) }
            } catch (e) {
              return { ok: false, error: String((e && e.message) || e) }
            }
          },
        ),
        def(
          'dsh_session_archive',
          'Archive a session out of its DSH workspace account (removes it from workspace membership; the session data itself is kept).',
          {
            sessionId: { type: 'string', description: 'Session id (from dsh_session_list).', required: true },
          },
          async (args) => {
            if (!wsr) return { ok: false, error: 'workspaceRegistry service unavailable' }
            if (!args.sessionId) return { ok: false, error: 'sessionId is required' }
            try {
              await wsr.archiveSession(String(args.sessionId))
              return { ok: true, archived: String(args.sessionId) }
            } catch (e) {
              return { ok: false, error: String((e && e.message) || e) }
            }
          },
        ),
      ]

      tools.forEach((tool) => { disposers.push(harness.registerTool(ctx, tool)) })
      ctx.effect(() => () => {
        disposers.forEach((d) => { try { d() } catch (e) { /* ignore */ } })
      })
      console.log('dsh-workspace-manager: registered ' + tools.length + ' workspace/session tools')
    },
  }
}

module.exports = { createWorkspaceManagerPlugin }
