# API Mapping: Command Center → OpenClaw Runtime

> **OPC-151.** For every `/api/*` route in [`src/dashboard/routes.ts`](../../nanoclaw-dashboard/src/dashboard/routes.ts) of the NanoClaw `Command-Center` server, this doc records the target on the OpenClaw side: a `runtime.<area>.<method>` call from `PluginRuntimeCore`, a gateway RPC, or `DELETE` (drop the surface, with rationale).

**Status:** complete first pass. Open questions tracked in the bottom section.

## Conventions

| Column | Meaning |
|---|---|
| **Method · Path** | Command-Center route, exactly as registered in `routes.ts`. |
| **Source handler** | File under `nanoclaw-dashboard/src/dashboard/api/*.ts` and the function in it. |
| **OpenClaw target** | `runtime.<area>.<method>` (plugin runtime), `gateway:<rpc>` (gateway RPC), `config:<path>` (config mutation), `state:<bucket>` (plugin state store), `events:<source>` (event bus), or `DELETE` (drop). |
| **Shape diff** | Whether the JSON contract in [`dashboard-next/src/lib/api.ts`](../../nanoclaw-dashboard/dashboard-next/src/lib/api.ts) needs an adapter glue layer or fits 1:1. |
| **Notes** | Caveats, semantic translations, open questions inline. |

Path conventions used below:
- `runtime.tasks.flows.{list,get,create,update,delete}` — TaskFlow CRUD (one-time / interval / cron jobs). DTO-shaped, this is the canonical surface.
- `runtime.tasks.runs.list()` — recent run history per task (`TaskRunView[]`).
- `runtime.tasks.managedFlows.bindSession(...)` — bind a flow to a session scope key (used when creating a job tied to a chat).
- `runtime.config.mutateConfigFile(...)` — focused config mutation; specify `afterWrite: "hot-reload"` for non-restart changes.
- `runtime.agent.session.{loadSessionStore, saveSessionStore, updateSessionStoreEntry, resolveSessionFilePath}` — per-scope session-store access. Backs `~/.openclaw/agents/<agentId>/sessions/sessions.json` and the JSONL transcripts.
- `runtime.events.onAgentEvent(handler)` — subscribe to sanitized agent events; returns an unsubscribe function.
- `runtime.events.onSessionTranscriptUpdate(handler)` — subscribe to transcript appends.
- `runtime.system.enqueueSystemEvent(payload)` — inject a `systemEvent` into a target session.
- `runtime.state.openKeyedStore({ pluginId: "dashboard", bucket: ... })` — plugin-local KV store backed by filesystem under the plugin state dir.
- `gateway:<rpc>` — calls into the gateway via `runtime` gateway bindings (see `src/plugins/runtime/gateway-bindings.ts`); examples include `sessions.reset`, approvals RPC.
- Approval runtimes live under `src/plugin-sdk/approval-*-runtime.ts` (`approval-client-runtime`, `approval-delivery-runtime`, `approval-handler-runtime`, `approval-native-runtime`, `approval-gateway-runtime`). The plugin reaches them via the SDK exports, not `runtime.*`.

## Mapping

### Agents

| Method · Path | Source handler | OpenClaw target | Shape diff | Notes |
|---|---|---|---|---|
| `GET /api/agents` | `agents.ts:getAgents` | Compose: walk `<workspace>/<scope>/CLAUDE.md` files **+** `runtime.agent.session.loadSessionStore({ scope })` for activity **+** `runtime.tasks.runs.list()` filtered by `sessionKey` for `currentTask` / `pendingTaskCount`. | **Adapter needed.** OpenClaw has no native `Agent` shape. Synthesize `{ jid, name, folder, online, lastActivity, currentTask, containerName: null, pendingMessages, pendingTaskCount }` from these inputs. `containerName` returns `null` always (no Docker per-agent in OpenClaw deployments). | OPC-152 finalises `agent ↔ scope` mapping. The `?source=dashboard|channel` filter has no equivalent — drop it or treat all scopes uniformly. |
| `POST /api/agents` | `agents.ts:createAgent` | 1. Create directory `<workspace>/<folder>/`. 2. Write `CLAUDE.md` (use Anthropic API for `description` → prompt, same as today). 3. *Optional:* register an entry in plugin keyed-store `state:dashboard/agents` for any UI-only metadata. **No** session-store write — sessions are file-backed and created lazily by the agent loop on first message. | 1:1 response shape `{ jid, name, folder }`. `jid` becomes the synthetic scope key (e.g. `scope:<folder>`). | The Anthropic-API prompt-generation flow (`generateAgentPrompt` in current handler) ports over verbatim — pure data transform, no NanoClaw deps. |
| `DELETE /api/agents/:folder` | `agents.ts:deleteAgent` | Archive workspace folder by rename: `<workspace>/<folder>/` → `<workspace>/<folder>.archived-<ts>/`. **No** session-store deletion — sessions persist as historical record. | 1:1. | OpenClaw has no "delete session" gesture; archiving the workspace folder removes the agent from listing while preserving transcript history under `~/.openclaw/agents/`. |
| `GET /api/agents/:folder/prompt` | `agents.ts:getAgentPrompt` | Read `<workspace>/<folder>/CLAUDE.md` via `runtime.agent.resolveAgentWorkspaceDir({ scope })`. | 1:1 (`{ folder, content }`). | — |
| `PUT /api/agents/:folder/prompt` | `agents.ts:updateAgentPrompt` | Write same path. Atomic write (tmp + rename). | 1:1 (`{ folder, saved: true }`). | — |
| `GET /api/agents/:folder/settings` | `agents.ts:getAgentSettings` | Read `state:dashboard/agent-settings/<folder>.approvalMode`. Default `"auto"`. | 1:1 (`{ approvalMode }`). | `approvalMode` is dashboard-only metadata; OpenClaw's `tools.profile` and `agents.defaults.trustedToolPolicy` cover the actual policy. The dashboard's `approvalMode` is a per-scope override flag the plugin records and consults when emitting per-tool approval prompts. Open question OPC-152: do we keep this concept or fold it into `tools.profile` / `trustedToolPolicy`? |
| `PUT /api/agents/:folder/settings` | `agents.ts:updateAgentSettings` | Write `state:dashboard/agent-settings/<folder>.approvalMode`. | 1:1 (`{ ok, approvalMode, agent }`). | The `agent` field today reports `queue.killByFolder(...)` outcome (`"killed" | "none"`). In OpenClaw the closest is `gateway:sessions.reset { key: <scope> }` for the active scope — but only when `approvalMode` flips to `"ask"` to invalidate any in-flight tool calls. Likely simplify: always return `agent: "none"`. |

### Tasks (cron / TaskFlows)

| Method · Path | Source handler | OpenClaw target | Shape diff | Notes |
|---|---|---|---|---|
| `GET /api/tasks?group=&runs=N` | `tasks.ts:getTasks` | `runtime.tasks.flows.list()`, filter by `sessionKey` if `group` provided. Merge recent runs from `runtime.tasks.runs.list()` keyed by flow id, slice `N` per task. | **Adapter needed.** Map `TaskFlowView` → `ScheduledTask` shape (see `dashboard-next/src/lib/api.ts:155`). OpenClaw `schedule.expr` ↔ Command-Center `schedule_value`. `schedule.kind` (`cron`/`interval`/`once`) ↔ `schedule_type`. `lastRunAtMs` (epoch ms) → `last_run` ISO. `lastStatus` → `last_result`. Map `enabled` → `status: "active" | "paused"`. `delivery.channel` is OpenClaw-only; drop or surface as extra field. | Use canonical TaskFlow API (DTO), not deprecated `runtime.taskFlow`. |
| `POST /api/tasks` | `tasks.ts:createNewTask` | `runtime.tasks.flows.create({ name, schedule, sessionTarget, payload, delivery, ... })`. For `agentTurn` payload set `payload.kind: "agentTurn"`, `payload.message: prompt`, `payload.model`. For `context_mode === "isolated"` set `sessionTarget: "isolated"`; for `"group"` set `sessionTarget: "main"` (or scope-bound). | Adapter on inputs. Schedule translation: `cron`→`{ kind:"cron", expr, tz: <runtime tz> }`, `interval`→`{ kind:"interval", everyMs }`, `once`→`{ kind:"once", at }`. | The `chat_jid` / `group_folder` from request maps onto `sessionKey` via OPC-152 design. |
| `PATCH /api/tasks/:id` | `tasks.ts:patchTask` | `runtime.tasks.flows.update(id, patch)`. `status: "paused"` → `enabled: false`; `status: "active"` → `enabled: true`. | Adapter. | OpenClaw recomputes `nextRunAtMs` automatically on schedule change. The Command-Center `next_run` field is read-only after this. |
| `DELETE /api/tasks/:id` | `tasks.ts:removeTask` | `runtime.tasks.flows.delete(id)`. | 1:1 (`{ deleted: true }`). | — |
| `POST /api/tasks/:id/run` | `tasks.ts:triggerTask` | `runtime.tasks.flows.runOnce(id)` (if exposed) **or** `runtime.system.enqueueSystemEvent({ kind: "cron-trigger", flowId: id })`. **OPEN:** confirm canonical method name in `runtime-tasks.ts`. | 1:1 (`{ triggered: true, task_id }`). | Today's NanoClaw implementation is `dbUpdateTask(id, { next_run: now })` — i.e. just rewinds the schedule clock. We need a real "run now" call on the OpenClaw side. |

### Messages (transcripts + send)

| Method · Path | Source handler | OpenClaw target | Shape diff | Notes |
|---|---|---|---|---|
| `GET /api/messages?group=&limit=&offset=` | `messages.ts:getMessages` | `runtime.agent.session.resolveSessionFilePath({ scope, chatJid })` → read JSONL transcript → page in-memory. | **Adapter needed.** OpenClaw transcript line shape ≠ Command-Center `Message` (`{ id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message }`). Map: transcript `role: "user" / "assistant"` → `is_bot_message`. Synthetic `chat_jid` from scope. `is_from_me` true for `role: "user"` if source is dashboard. | The current `chat_jid: dashboard-<folder>` synthetic JID has no analog — invent same convention plugin-side. |
| `POST /api/messages` | `messages.ts:postMessage` (calls `chat.ts:sendGroupMessage`) | Two-path: (a) **inject into agent** — `runtime.system.enqueueSystemEvent({ scope, kind: "user-message", text, attachments })`, **or** (b) **send via channel** — call channel send via `runtime.channels.<id>.send(...)` from registered channel plugin. Today's NanoClaw write to `data/ipc/<folder>/input/<ts>-dashboard.json` collapses both into one path; in OpenClaw they are distinct. | Adapter on input (`replyTo` for cross-agent forward becomes a separate `enqueueSystemEvent` to a different scope). Output `{ success, group, jid }` 1:1. | The `xagent-<folder>-<ts>` synthetic JID for cross-agent forwards is a NanoClaw concept; preserve as plugin-local convention. |
| `DELETE /api/messages?group=` | `messages.ts:clearMessages` | `gateway:sessions.reset { key: <scope> }`. | 1:1 (`{ ok, deleted }`). | Aligns with the documented gateway RPC `sessions.reset` (used by `openclaw cron status` etc.). |

### Activity / Events (SSE)

| Method · Path | Source handler | OpenClaw target | Shape diff | Notes |
|---|---|---|---|---|
| `GET /api/events` (SSE) | `events.ts:streamEvents` | Subscribe `events:onAgentEvent` + `events:onSessionTranscriptUpdate`. Compose four SSE message types from these streams: `init`, `agents`, `messages`, `activity`, `approval_requests`. | **Adapter needed.** Today's handler polls every 2s; the OpenClaw event sources are push-based, so the plugin can deliver lower-latency updates. Output JSON shape stays compatible: `{ type: "init" | "agents" | "messages" | "activity" | "approval_requests", ... }`. | `approval_requests` payload comes from approval-runtime polling (see Approvals row). Heartbeat every 15s for proxy keep-alive. |
| `GET /api/activity?limit=N` | `activity.ts:getActivity` | Tail `runtime.events.onAgentEvent` into a ring buffer in `state:dashboard/activity-buffer`, return last `N`. | Adapter. Today this reads from a SQLite `activity` table; we keep an in-memory buffer instead, persisted to keyed-store on shutdown for restart-survival. | Optionally drop entirely — `/api/events` covers the live stream and the dashboard's history-tab can read the same buffer via that stream's `init` payload. |
| `GET /api/activity/stream` (SSE) | `activity.ts:streamActivity` | Same source as `/api/events` but emit only the `activity` channel. | 1:1 wire format. | Likely DELETE in favor of `/api/events` once dashboard refactors to single SSE endpoint. Keep as alias for backward compat through Phase 2. |

### Approvals + tool policies

| Method · Path | Source handler | OpenClaw target | Shape diff | Notes |
|---|---|---|---|---|
| `GET /api/approvals` | `approvals.ts:getPendingApprovals` | `approval-client-runtime.listPendingApprovals()` (from `openclaw/plugin-sdk/approval-client-runtime`). | **OPEN.** Shape of OpenClaw approval items vs NanoClaw `approval-manager.getPending()` — need a side-by-side once we read both surfaces. Likely adapter. | NanoClaw scans `data/ipc/*/approvals/` directory; OpenClaw has a typed runtime. |
| `POST /api/approvals/:id` | `approvals.ts:respondToApproval` | `approval-client-runtime.respondToApproval(id, { decision: "allow" \| "deny", alwaysAllow })`. | 1:1 (`{ ok }`). | `alwaysAllow: true` translates to mutating `tools.sandbox.tools.allow` (or `agents.defaults.trustedToolPolicy`) via `config:tools.sandbox.tools.allow` mutation. |
| `GET /api/tool-policies?group=` | `approvals.ts:getToolPoliciesForGroup` | Read `tools.sandbox.tools.{allow,deny}` from `runtime.config.current()`, filter by scope-prefixed entries (convention: prefix tool patterns with `<scope>:` for per-scope policies). | **Adapter needed.** Today returns `[{ group_folder, tool_pattern, action: "allow"\|"deny"\|"ask" }]`. OpenClaw merges `allow`/`deny` lists; `"ask"` has no native equivalent — store separately in `state:dashboard/policies/<scope>` as overlay. | OPC-152 sub-discussion: per-scope policies aren't first-class in OpenClaw; we layer them on top of global lists. |
| `PUT /api/tool-policies` | `approvals.ts:upsertPolicy` | `runtime.config.mutateConfigFile({ path: "tools.sandbox.tools.allow", op: "merge", value: [...] })` for `"allow"`/`"deny"`; for `"ask"` write `state:dashboard/policies/<scope>/<pattern>`. `afterWrite: "hot-reload"`. | 1:1 (`{ ok }`). | — |
| `DELETE /api/tool-policies` | `approvals.ts:removePolicy` | Inverse of upsert; remove entry from list or state. | 1:1. | — |

### Settings

| Method · Path | Source handler | OpenClaw target | Shape diff | Notes |
|---|---|---|---|---|
| `GET /api/settings/timezone` | `settings.ts:getTimezonesetting` | Read `runtime.config.current().time.timezone` (or wherever timezone lives in `OpenClawConfig`; in cron jobs we see `schedule.tz` as field — confirm root path). | 1:1 (`{ timezone }`). | OPEN: confirm the canonical config path for global timezone (cron jobs accept per-job `tz`; assume root is `time.timezone` or `general.timezone`). |
| `POST /api/settings/timezone` | `settings.ts:updateTimezone` | `runtime.config.mutateConfigFile({ path: "time.timezone", value: tz, afterWrite: "hot-reload" })`. | 1:1 (`{ success, timezone }`). | Validation via `Intl.supportedValuesOf("timeZone")` ports verbatim. |

### Uploads

| Method · Path | Source handler | OpenClaw target | Shape diff | Notes |
|---|---|---|---|---|
| `POST /api/upload` | `upload.ts:handleUpload` | Multipart parse via `busboy` (port verbatim, no NanoClaw deps). Persist bytes under `runtime.state.resolveStateDir({ pluginId: "dashboard" })/uploads/`. Persist metadata in `state:dashboard/uploads/<id>` keyed-store entry (`{ id, name, size, mime, ext, createdAt }`). | 1:1 (`{ files: UploadedFile[] }`). | Limits (`MAX_UPLOAD_SIZE`, `MAX_ATTACHMENTS_PER_MESSAGE`) and the `ALLOWED_UPLOAD_EXTENSIONS` set port over from `nanoclaw-dashboard/src/config.ts`. |
| `GET /api/uploads/:id` | `upload.ts:serveUpload` | Look up id in keyed-store, stream the file from `runtime.state.resolveStateDir(...)/uploads/`. | 1:1 (binary response). | UUID validation + path-traversal guard preserved. `INLINE_TYPES` set ports verbatim. Cache-Control `public, max-age=86400` preserved. |

### Health + debug

| Method · Path | Source handler | OpenClaw target | Shape diff | Notes |
|---|---|---|---|---|
| `GET /api/health` | inline in `routes.ts` | Inline in plugin: `{ status: "ok", timestamp: new Date().toISOString() }`. | 1:1. | Trivial — handler stays inline. |
| `GET /api/debug/queue` | inline (returns `getDashboardQueue()?.getStatus()`) | `runtime.tasks.runs.list()` (active runs) merged with active session info from session store. | Adapter. | `GroupQueue` is NanoClaw-specific; OpenClaw has no equivalent "queue" abstraction. Repurpose as "runs-in-flight" view. |

### DELETE — surfaces dropped from the plugin

These routes are owned by `extensions/google` (OpenClaw's official Google integration) and the `gog` skill, not by the dashboard plugin. The corresponding pages in `dashboard-next/` either delete or replace with a stub linking to the OpenClaw Google extension.

| Method · Path | Source handler | Reason |
|---|---|---|
| `GET /api/auth/google-calendar/status`, `GET /api/auth/google-calendar`, `GET /api/auth/google-calendar/callback`, `POST /api/auth/google-calendar/disconnect` | `calendar.ts:get*/handle*OAuthCallback`, `disconnectCalendar` | OAuth lifecycle handled by `extensions/google` and the `gog` CLI. |
| `GET /api/auth/gmail/*` | `gmail.ts` | Same. |
| `GET /api/auth/google-sheets/*` | `sheets.ts` | Same. |
| `GET /api/auth/google-drive/*` | `drive.ts` | Same. |
| `GET /api/calendar`, `POST /api/calendar`, `GET /api/calendar/events`, `POST /api/calendar/events` | `calendar.ts:getCalendarEvents`, `createCalendarEvent` | Calendar reads/writes done via `gog` skill from agent or via Google MCP. The dashboard's calendar widget either: (a) calls the Google MCP server directly, or (b) shows a placeholder until Phase 3 decides whether to keep the widget. |
| `GET /api/chat`, `GET /api/chat/stream`, `POST /api/chat` | `chat.ts:sendChatMessage`, `streamChatMessages` | Marked legacy in current handler comments. Superseded by `/api/messages` family. |
| `* /mcp/google` | `google-mcp-server.ts` (NanoClaw bundle) | OpenClaw `extensions/google` provides a fully featured MCP server. Drop the NanoClaw embedded MCP entirely. |

## Open questions

1. **Canonical "run now" call on `runtime.tasks.flows`.** Today's Command-Center handler simulates by setting `next_run = now`. In `runtime-tasks.types.ts` we see `runs.list()` and `flows.list()` exposed — need to confirm whether `flows.runOnce(id)` (or similar) is in the public surface, or whether we go through `runtime.system.enqueueSystemEvent` and let the cron service pick it up. → resolve in OPC-155.
2. **Approval payload shape.** NanoClaw's `approval-manager.getPending()` returns a custom shape. `approval-client-runtime.listPendingApprovals` likely returns a different one. Side-by-side comparison needed before writing the adapter. → resolve in OPC-156.
3. **Per-scope tool policies.** OpenClaw's `tools.sandbox.tools.{allow,deny}` is global. NanoClaw's policies are per-folder. We synthesize per-scope by prefixing tool patterns (`<scope>:<pattern>`) — but this may not match OpenClaw's evaluator semantics. Verify against `audit-loopback-logging.test.ts` and approval-runtime tests. → resolve in OPC-156.
4. **Global timezone path.** Confirm whether `time.timezone` is the canonical root config path (vs `general.timezone`, `agents.defaults.timezone`, etc.). → resolve in OPC-155 / OPC-152 secondary.
5. **`approvalMode` per agent.** Keep as plugin-local concept (state store) or replace with OpenClaw's `tools.profile` / `agents.defaults.trustedToolPolicy`? → resolve in OPC-152.
6. **`agent` ↔ `scope` key format.** Top-level OPC-152 question. Today the dashboard uses synthetic `dashboard-<folder>` JIDs that flow through to message-store keys. The plugin should pick a stable `scope:<folder>` (or `dashboard:<folder>`) format and translate everywhere consistently.
7. **Agent activity (`online`, `currentTask`, `pendingMessages`)** — derive from session-store mtime + `runtime.tasks.runs.list()` (filter by `sessionKey`). Need to verify the timing is fresh enough for sub-5s SSE updates. → resolve in OPC-153.
8. **`/api/activity` legacy.** Decide whether to keep alongside `/api/events` or drop. Affects how much logic we port from `activity.ts`. Recommendation: drop after Phase 2 stabilises. → resolve in OPC-157.

## Counts

- **Routes mapped to OpenClaw runtime:** 19
- **Routes dropped (handed to `extensions/google` / legacy):** 13 (4 OAuth × 4 services + 2 calendar + 3 chat-legacy + 1 MCP, with overlap = 13 distinct method/path pairs)
- **Open questions blocking Phase 2:** 8 (numbered above)

Once OPC-152 finalises the agent ↔ scope model, items 5–7 above resolve and Phase 2 sub-issues (OPC-153–OPC-159) can pick up handler-by-handler.
