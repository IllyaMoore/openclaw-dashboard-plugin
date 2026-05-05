# Agent ↔ Session-Scope Translation

> **OPC-152.** Command Center models an "agent" as `{ jid, name, folder, online, lastActivity, currentTask, containerName, pendingMessages, pendingTaskCount }` backed by NanoClaw's SQLite + filesystem (`groups/<folder>/CLAUDE.md` + per-agent IPC dir). OpenClaw has no first-class "agent" concept. This doc records the translation onto OpenClaw primitives (session scope keys + workspace skill folders) and pins the field-level mapping for the `/api/agents*` handler in [`api-mapping.md`](./api-mapping.md).

**Status:** complete first pass. Open follow-ups for Phase 2 listed at the bottom.

## OpenClaw session-key primer (citations)

All citations are inside the workspace junction at `../openclaw/`:

- **Format:** `agent:<agentId>:<rest>` — see `src/routing/session-key.ts:59` (`toAgentStoreSessionKey`) and `parseAgentSessionKey` in `src/sessions/session-key-utils.ts`.
- **Default agentId:** `"main"` (`DEFAULT_AGENT_ID` at `src/routing/session-key.ts:20`).
- **Default main key:** `"main"` (`DEFAULT_MAIN_KEY`). The canonical "agent talks in its own main session" key is `agent:main:main`.
- **Examples seen in production** (`openclaw health` output):
  - `agent:main:main` — main session.
  - `agent:main:cron:<flow-id>` — cron-bound session.
  - `agent:main:cron:<flow-id>:run:<uuid>` — specific run.
- **Validation regex:** `/^[a-z0-9][a-z0-9_-]{0,63}$/i` for each id segment (`VALID_ID_RE`, same file).
- **Special session-key recognisers:** `isCronSessionKey`, `isAcpSessionKey`, `isSubagentSessionKey` re-exported from `src/routing/session-key.ts:8-11`.
- **Storage paths:**
  - Session store JSON: `~/.openclaw/agents/<agentId>/sessions/sessions.json` (`resolveDefaultSessionStorePath` at `src/config/sessions/paths.ts:36`).
  - Transcripts dir: `~/.openclaw/agents/<agentId>/sessions/` — per-key JSONL files inside.
- **Workspace dir:** `~/.openclaw/workspace/` — same root for all `agentId`s under default install. Resolved per-agent via `runtime.agent.resolveAgentWorkspaceDir(cfg, agentId)`.

## Options considered

### Option A — One OpenClaw `agentId` per dashboard agent

Each NanoClaw folder (`ceo`, `legal`, `finance`, …) becomes a separate `agentId`. Each gets its own:

- Session store dir: `~/.openclaw/agents/ceo/sessions/`, `~/.openclaw/agents/legal/sessions/`, …
- Workspace dir: `~/.openclaw/workspace/` per agent (shared on disk by default, distinct logically).
- Cron/jobs scoped to that agentId.

**Pros:** clean isolation; mirrors NanoClaw's per-folder state model.

**Cons:**
- OpenClaw's main agent today is `agentId: main` and runs all cron jobs, channels, sessions. Splitting into 7+ agents requires either provisioning multiple Pi-agent instances (heavy) or stretching the meaning of `agentId` past what gateway code assumes.
- Production install on `i-06b306d0f3e7387be` already has 143 sessions under `agent:main:*` (per `openclaw health`). Migrating those into per-agentId stores is a one-way operation; we don't want a migration step in Phase 1.
- Cron jobs would need `agentId` rewriting; today all 23 production crons target `main`.
- Channels (WhatsApp, Telegram) are configured at root, not per-agentId; one inbound message would need re-routing logic to land in the right agentId.

### Option B — Single `agentId: main`, scope-per-dashboard-agent

Stay on OpenClaw's default `agentId: main` (matches the production install). Each dashboard "agent" gets a distinct **rest** segment under `agent:main:dashboard:<folder>`:

- Main session for all agents: `agent:main:main` (untouched).
- Dashboard "ceo" agent: `agent:main:dashboard:ceo`.
- Dashboard "legal" agent: `agent:main:dashboard:legal`.
- Cron job bound to "ceo" agent: bind via `runtime.tasks.managedFlows.bindSession({ sessionKey: "agent:main:dashboard:ceo" })`.

Prompt content (`CLAUDE.md`) lives in the plugin-private workspace subdirectory: `~/.openclaw/workspace/dashboard-agents/<folder>/CLAUDE.md`. Avoids collision with OpenClaw's own workspace files (`IDENTITY.md`, `USER.md`, `MEMORY.md`, etc.) and with the skills system (`workspace/skills/<id>/SKILL.md`).

**Pros:** zero migration on production, natural fit for OpenClaw's session-key shape, cron + transcript isolation come for free, no new gateway-level concepts.

**Cons:**
- The dashboard's per-agent system prompt (`CLAUDE.md`) is *not* injected by OpenClaw's default prompt-builder — we need a plugin hook (next section).
- 7+ scopes share one agent identity / model-auth / channel-policy. That's actually fine, but it means dashboard "agents" aren't first-class OpenClaw agents, just personas.

### Option C — Pseudo-channel + per-chat systemPrompt

Register the dashboard as an OpenClaw channel via `api.registerChannel(...)` and use the existing per-channel `direct.<peerId>.systemPrompt` mechanism (documented at `../openclaw/docs/channels/whatsapp.md:625-695` for WhatsApp; same shape for any channel). Each dashboard "agent" becomes a synthetic peerId.

**Pros:** the system-prompt overlay mechanism already exists and is tested. No new plugin hook needed.

**Cons:**
- Forces us to implement a `ChannelPlugin`, which has a much larger surface than `registerHttpRoute` (lifecycle, send/receive, login flow, allow-from policy, group support, etc.).
- The dashboard isn't a messaging platform — it's a UI. Implementing `ChannelPlugin` semantics for a dashboard is impedance mismatch; channel patterns assume external transport.

## Decision: Option B

We adopt **Option B** with the following concrete spec.

### Scope-key format

```
agent:main:dashboard:<folder>
```

- `<folder>` validated against `^[a-z0-9][a-z0-9_-]{0,63}$` (matches OpenClaw's `VALID_ID_RE`).
- Reserved subset: `<folder>` cannot be `main`, `cron`, `acp`, or any token already used as a session-key segment (avoids collision with `parseAgentSessionKey` shape detection).
- Stable across the agent's lifetime; the dashboard's `jid` field exposes this string as-is.

### Workspace layout

```
~/.openclaw/workspace/dashboard-agents/
├── ceo/
│   └── CLAUDE.md           # system prompt for the ceo agent
├── legal/
│   └── CLAUDE.md
└── finance/
    └── CLAUDE.md
```

`dashboard-agents/` chosen so the plugin's data is grouped under one prefix and easy to back up / migrate. Resolved via `runtime.agent.resolveAgentWorkspaceDir(cfg, "main")` + `path.join(..., "dashboard-agents", folder)`.

### System-prompt injection

OpenClaw's plugin SDK exposes `PluginAgentTurnPrepareEvent` (see `src/plugins/types.ts:209-220`). The plugin registers a turn-prepare hook that:

1. Inspects the turn's `sessionKey`.
2. If it matches `agent:main:dashboard:<folder>`, reads `~/.openclaw/workspace/dashboard-agents/<folder>/CLAUDE.md` and contributes it as a `ProviderSystemPromptContribution` (type from `src/agents/system-prompt-contribution.ts`).
3. Otherwise no-op.

This is the mechanism that **replaces NanoClaw's hard-coded "groups/<folder>/CLAUDE.md → child process spawn with that as system prompt"** plumbing. No child-process spawning; the plugin's prompt overlay rides on whatever model session OpenClaw runs anyway.

### Plugin-private metadata (state store)

Things that are dashboard-only and don't belong in OpenClaw config:

- `approvalMode` per agent (`"ask" | "auto"`) — `state:dashboard/agent-settings/<folder>.approvalMode`.
- Display name (`name` field, free-text human label) when it differs from `<folder>` — `state:dashboard/agent-settings/<folder>.name`.
- Created-at timestamp — `state:dashboard/agent-settings/<folder>.createdAt`.

Persisted via `runtime.state.openKeyedStore({ pluginId: "dashboard", bucket: "agent-settings" })`.

## Field-level mapping

For each field in the dashboard's `Agent` shape (see `nanoclaw-dashboard/dashboard-next/src/lib/api.ts:1-11`):

| Dashboard field | OpenClaw source | Notes |
|---|---|---|
| `jid` | `agent:main:dashboard:<folder>` | Stable session-key string. |
| `name` | `state:dashboard/agent-settings/<folder>.name` (fallback: capitalised `<folder>`) | Human display label. |
| `folder` | Plugin-managed string segment. | Validated, never trust client-supplied. |
| `online` | `runtime.tasks.runs.list().some(run => run.sessionKey === <scope> && run.status === "running")` **or** session-store entry `status === "active"` within last N seconds. | Threshold tuned in OPC-153. |
| `lastActivity` | Session-store entry `lastInteractionAtMs` for the scope, ISO-formatted. | Falls back to transcript file mtime if entry missing. |
| `currentTask` | `runtime.tasks.runs.list()` filtered by `sessionKey`, pick most recent in `status: "running" \| "queued"`. Project to `taskId`. | Empty string / null when idle. |
| `containerName` | Always `null`. | NanoClaw-specific — no Docker per-agent in OpenClaw. |
| `pendingMessages` | `false` for now (Phase 2 may surface input-buffer state if useful). | Today's NanoClaw `pendingMessages` flag tracks IPC inbox; OpenClaw doesn't have an inbox queue exposed at this layer. |
| `pendingTaskCount` | `runtime.tasks.runs.list()` filter by `sessionKey` + `status: "queued"`. Length. | — |

## Endpoint translations (cross-link to api-mapping)

| Dashboard endpoint | Implementation outline |
|---|---|
| `GET /api/agents` | Walk `~/.openclaw/workspace/dashboard-agents/`. For each `<folder>` with a `CLAUDE.md`, synthesize an `Agent` row using the mapping table above. Filter results by `?source=` (drop in v1 — OPC-153 to confirm). |
| `POST /api/agents` | Validate `folder` against the regex + reserved-words list. Create directory, write `CLAUDE.md` (use Anthropic API for prompt generation if `description` provided, same code path as today). Write `state:dashboard/agent-settings/<folder>` with `name`, `createdAt`, `approvalMode: "auto"`. Return `{ jid: "agent:main:dashboard:<folder>", name, folder }`. |
| `DELETE /api/agents/:folder` | Rename `dashboard-agents/<folder>` → `dashboard-agents/<folder>.archived-<unix-ms>`. Mark `state:dashboard/agent-settings/<folder>.archived = true`. **Do not** touch session-store or transcripts — they remain queryable for audit. |
| `GET /api/agents/:folder/prompt` | Read `dashboard-agents/<folder>/CLAUDE.md`. Return `{ folder, content }`. |
| `PUT /api/agents/:folder/prompt` | Atomic write (tmp + rename) of `dashboard-agents/<folder>/CLAUDE.md`. Return `{ folder, saved: true }`. The next agent turn picks up the new prompt automatically (turn-prepare hook reads on each turn). |
| `GET /api/agents/:folder/settings` | Read keyed-store entry. Return `{ approvalMode }` (default `"auto"`). |
| `PUT /api/agents/:folder/settings` | Update keyed-store entry. Return `{ ok, approvalMode, agent: "none" }` (we drop NanoClaw's `killByFolder` semantics — see `api-mapping.md` open question 5). |

## Open follow-ups (Phase 2)

1. **Reserved scope-key segment list** — finalise the exact list of forbidden `<folder>` values to prevent collision with OpenClaw's own session-key shapes. Likely: `main`, `cron`, `acp`, `run`, `subagent`, `dashboard` (yes, even `dashboard` itself, to avoid `agent:main:dashboard:dashboard`). → Resolved during OPC-153 scaffolding.
2. **Turn-prepare hook implementation** — concrete code for the system-prompt overlay. Verify the contribution merges correctly with OpenClaw's built-in workspace prompt without duplicating identity blocks. → OPC-153 / OPC-154.
3. **Migration story for existing NanoClaw users** — out of scope for this plugin (Command-Center is one-user / one-machine; no production multi-tenant install needs migration). Documented here for future reference: a one-shot script could read `groups/<folder>/CLAUDE.md` from a NanoClaw install and write into `dashboard-agents/<folder>/CLAUDE.md` of the OpenClaw plugin. Not built unless someone asks.
4. **`approvalMode` semantics** — kept as plugin-local concept. The plugin enforces it by intercepting tool-policy-evaluation when emitting approval prompts. → OPC-156.
5. **`source=channel` filter** — drop in v1 (current handler accepts `?source=channel|dashboard`). The new plugin only knows about dashboard scopes; channel-bound scopes (e.g., `agent:main:whatsapp:...`) are filtered out by the workspace-folder walk (they don't have a `dashboard-agents/<folder>/CLAUDE.md`). → No work needed; document and move on.
6. **Display ordering** — surface `lastActivity` desc by default. Already covered by the field mapping. → Implementation detail in OPC-153.

## Cross-references

- API mapping table (sibling doc): [`api-mapping.md`](./api-mapping.md).
- Linear epic: [OPC-148 — Phase 1](https://linear.app/storypages/issue/OPC-148).
- Sub-issues that consume this design: [OPC-153](https://linear.app/storypages/issue/OPC-153) (`/api/agents` port), [OPC-154](https://linear.app/storypages/issue/OPC-154) (`/api/messages` — uses scope keys), [OPC-155](https://linear.app/storypages/issue/OPC-155) (`/api/tasks` — bind cron jobs to scope keys), [OPC-156](https://linear.app/storypages/issue/OPC-156) (`approvalMode` enforcement).
