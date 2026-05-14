import type {
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_ID = "main";
const WORKSPACE_DIR = join(homedir(), ".openclaw", "workspace");
const IDENTITY_FILE = join(WORKSPACE_DIR, "IDENTITY.md");

// Heartbeat: re-emit `agents` snapshot every HEARTBEAT_MS so the client knows
// the stream is alive even if no runtime events arrive. Activity/messages are
// PUSHED on real events — no longer polled.
const HEARTBEAT_MS = 10_000;

const MAIN_FOLDER = "main";
const MAIN_JID = `agent:${AGENT_ID}`;

// Plugin-wide buffers retain the last N events across SSE reconnects so a
// page refresh replays recent history. Survives client disconnect; dies on
// gateway restart.
const ACTIVITY_BUFFER_MAX = 100;
const MESSAGES_BUFFER_MAX = 100;

// Window pushed to each SSE client on every event (UI treats `items` as the
// authoritative current state of the feed).
const ACTIVITY_WINDOW = 30;
const MESSAGES_WINDOW = 30;
const APPROVALS_WINDOW = 10;

type AgentBrief = {
  jid: string;
  name: string;
  folder: string;
  online: boolean;
};

// Activity item shape, designed to match the Command-Center UI bundle's
// renderer (which reads .type, .status, .timestamp, .sender_name, .content,
// .task_prompt, .duration_ms). Extra fields (stream, kind, runId, ...) are
// preserved for forward-compat / drill-down views.
type ActivityItem = {
  id: string;
  type: "task_run" | "agent_event" | "message";
  status: "success" | "failed" | "running";
  timestamp: number;
  sender_name: string;
  content: string;
  task_prompt?: string;
  duration_ms?: number;

  // extended metadata
  stream: string;
  kind?: string;
  phase?: string;
  runId: string;
  sessionKey?: string;
  toolName?: string;
};

type MessageItem = {
  id: string;
  type: "message";
  timestamp: number;
  sender_name: string;
  content: string;
  status: "success";

  sessionKey?: string;
  sessionFile: string;
  messageId?: string;
};

type ApprovalItem = {
  id: string;
  ts: number;
  status: string;
  title: string;
  runId: string;
  sessionKey?: string;
};

async function readMainAgentName(): Promise<string> {
  try {
    const raw = await fs.readFile(IDENTITY_FILE, "utf8");
    const match = raw.match(/^[ \t-]*\*?\*?\s*Name\s*:?\*?\*?\s*(.+?)\s*$/im);
    if (match?.[1]) {
      const cleaned = match[1].replace(/[*_`]/g, "").trim();
      if (cleaned && cleaned !== "_(") return cleaned;
    }
  } catch {
    // IDENTITY.md missing — fall back
  }
  return AGENT_ID;
}

async function listAgentsBrief(): Promise<AgentBrief[]> {
  return [
    {
      jid: MAIN_JID,
      name: await readMainAgentName(),
      folder: MAIN_FOLDER,
      online: true,
    },
  ];
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// Extract a plain-text summary from a session JSONL message line. Sessions
// store rich objects (role, content as string OR array of {type, text} blocks).
// We surface the first ~200 chars of any text-bearing block for the UI feed.
function extractMessageText(messageLine: unknown): string {
  if (!messageLine || typeof messageLine !== "object") return "";
  const m = messageLine as Record<string, unknown>;
  if (typeof m.content === "string") return m.content.slice(0, 200);
  if (Array.isArray(m.content)) {
    for (const block of m.content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string" && b.text.trim()) {
          return b.text.slice(0, 200);
        }
      }
    }
  }
  if (typeof m.text === "string") return m.text.slice(0, 200);
  return "";
}

function extractMessageRole(messageLine: unknown): string {
  if (!messageLine || typeof messageLine !== "object") return "agent";
  const m = messageLine as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "";
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  if (role === "system") return "System";
  if (role === "tool") return "Tool";
  return role || "Agent";
}

// Read the last N bytes of a session JSONL and find the message line matching
// the given messageId. Returns the parsed object, or undefined if not found.
async function findMessageInSessionFile(
  sessionFile: string,
  messageId: string | undefined,
): Promise<unknown> {
  if (!messageId) return undefined;
  try {
    const TAIL_BYTES = 32 * 1024;
    const stat = await fs.stat(sessionFile);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const handle = await fs.open(sessionFile, "r");
    try {
      const buf = Buffer.alloc(stat.size - start);
      await handle.read(buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      const lines = text.split("\n").filter(Boolean);
      // Walk in reverse — match by id field, since recent message is likely at end.
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj && typeof obj === "object") {
            const o = obj as Record<string, unknown>;
            if (o.id === messageId || o.messageId === messageId) return obj;
          }
        } catch {
          // skip malformed line
        }
      }
    } finally {
      await handle.close();
    }
  } catch {
    // File missing or unreadable — return undefined.
  }
  return undefined;
}

function isCronSessionKey(sessionKey?: string): boolean {
  return typeof sessionKey === "string" && sessionKey.includes(":cron:");
}

function mapEventStatus(data: Record<string, unknown>, phase?: string): "success" | "failed" | "running" {
  const status = asString(data.status);
  if (status === "completed" || status === "approved") return "success";
  if (status === "failed" || status === "denied" || status === "error") return "failed";
  if (phase === "end" || phase === "complete") return "success";
  if (phase === "error") return "failed";
  return "running";
}

function translateAgentEvent(evt: {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
}): ActivityItem | null {
  const id = `${evt.runId}:${evt.seq}`;
  const data = evt.data ?? {};
  const phase = asString(data.phase);
  const kind = asString(data.kind);
  const dataTitle = asString(data.title);
  const toolName = asString(data.name);

  let label = "";
  let body = "";
  switch (evt.stream) {
    case "lifecycle":
      label = phase ? `Run ${phase}` : "Lifecycle";
      body = `Agent run ${phase ?? "event"}`;
      break;
    case "thinking":
      label = "Thinking";
      body = asString(data.summary) ?? "Reasoning…";
      break;
    case "tool":
      label = `Tool ${phase ?? ""}`.trim();
      body = dataTitle ?? `Tool: ${toolName ?? "?"}`;
      break;
    case "item": {
      label = kind ? kind.toUpperCase() : "Item";
      body = dataTitle ?? (kind ? `${kind}` : "Item event");
      break;
    }
    case "command_output":
      label = "Command";
      body = asString(data.output)?.slice(0, 200) ?? dataTitle ?? "Command output";
      break;
    case "patch": {
      const summary = asString(data.summary);
      label = "Patch";
      body = summary ?? "File edits";
      break;
    }
    case "plan":
      label = "Plan";
      body = dataTitle ?? asString(data.explanation) ?? "Plan update";
      break;
    case "approval":
      label = `Approval ${phase ?? ""}`.trim();
      body = dataTitle ?? "Approval requested";
      break;
    case "compaction":
      label = "Compaction";
      body = "Context compacted";
      break;
    case "error":
      label = "Error";
      body = asString(data.message) ?? "Error";
      break;
    case "assistant":
      // High-volume streaming chunks; surface only meaningful boundaries.
      if (phase !== "end" && phase !== "complete") return null;
      label = "Assistant";
      body = "Turn complete";
      break;
    default:
      label = evt.stream;
      body = evt.stream;
  }

  const isTaskRun = isCronSessionKey(evt.sessionKey);
  const status = mapEventStatus(data, phase);

  const item: ActivityItem = {
    id,
    type: isTaskRun ? "task_run" : "agent_event",
    status,
    timestamp: evt.ts,
    sender_name: label,
    content: body,
    stream: evt.stream,
    runId: evt.runId,
  };
  if (isTaskRun) item.task_prompt = body;
  if (kind) item.kind = kind;
  if (phase) item.phase = phase;
  if (evt.sessionKey) item.sessionKey = evt.sessionKey;
  if (toolName) item.toolName = toolName;
  return item;
}

function translateApprovalEvent(evt: {
  runId: string;
  seq: number;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
}): ApprovalItem {
  const data = evt.data ?? {};
  return {
    id: (asString(data.approvalId) ?? asString(data.itemId)) ?? `${evt.runId}:${evt.seq}`,
    ts: evt.ts,
    status: asString(data.status) ?? "pending",
    title: asString(data.title) ?? "Approval requested",
    runId: evt.runId,
    sessionKey: evt.sessionKey,
  };
}

function resolveExpectedToken(): string {
  return process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
}

export function createEventsHandler(
  runtime: OpenClawPluginApi["runtime"],
  logger: OpenClawPluginApi["logger"],
): OpenClawPluginHttpRouteHandler {
  const expectedToken = resolveExpectedToken();

  // ── Plugin-wide event state ───────────────────────────────────────────
  // Lives for the lifetime of the gateway process. Survives client refresh,
  // dies on gateway restart. New SSE connections receive a replay of these
  // buffers as their initial snapshot.
  const activityBuf: ActivityItem[] = [];
  const messagesBuf: MessageItem[] = [];
  const approvalsBuf = new Map<string, ApprovalItem>();

  type ConnectionListener = {
    onActivity: () => void;
    onMessages: () => void;
    onApprovals: () => void;
  };
  const connections = new Set<ConnectionListener>();

  const fanOut = (notify: (l: ConnectionListener) => void) => {
    for (const l of connections) {
      try {
        notify(l);
      } catch {
        // a single dead connection should not break the loop
      }
    }
  };

  // Subscribe ONCE to the runtime, regardless of how many SSE clients connect.
  runtime.events.onAgentEvent((evt) => {
    const item = translateAgentEvent(evt);
    if (item) {
      activityBuf.push(item);
      if (activityBuf.length > ACTIVITY_BUFFER_MAX) {
        activityBuf.splice(0, activityBuf.length - ACTIVITY_BUFFER_MAX);
      }
      fanOut((l) => l.onActivity());
    }

    if (evt.stream === "approval") {
      const data = evt.data ?? {};
      const phase = asString(data.phase);
      const approval = translateApprovalEvent(evt);
      if (
        phase === "resolved" ||
        asString(data.status) === "approved" ||
        asString(data.status) === "denied" ||
        asString(data.status) === "failed"
      ) {
        approvalsBuf.delete(approval.id);
      } else {
        approvalsBuf.set(approval.id, approval);
      }
      fanOut((l) => l.onApprovals());
    }
  });

  runtime.events.onSessionTranscriptUpdate((upd) => {
    void (async () => {
      const message =
        upd.message ?? (await findMessageInSessionFile(upd.sessionFile, upd.messageId));
      const item: MessageItem = {
        id: upd.messageId ?? `${upd.sessionFile}:${Date.now()}`,
        type: "message",
        timestamp: Date.now(),
        sender_name: extractMessageRole(message),
        content: extractMessageText(message) || "—",
        status: "success",
        sessionKey: upd.sessionKey,
        sessionFile: upd.sessionFile,
        messageId: upd.messageId,
      };
      messagesBuf.push(item);
      if (messagesBuf.length > MESSAGES_BUFFER_MAX) {
        messagesBuf.splice(0, messagesBuf.length - MESSAGES_BUFFER_MAX);
      }
      fanOut((l) => l.onMessages());
    })();
  });

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const queryToken = url.searchParams.get("token") ?? "";
    if (!expectedToken || queryToken !== expectedToken) {
      res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "missing or invalid token query param" }));
      return true;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    });
    if (typeof (res as { flushHeaders?: () => void }).flushHeaders === "function") {
      (res as { flushHeaders: () => void }).flushHeaders();
    }

    let alive = true;

    const send = (payload: unknown): boolean => {
      if (!alive) return false;
      try {
        return res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        return false;
      }
    };

    // UI renders items in the array order it receives them. We push to the end
    // of the buffer (insertion order is oldest → newest) but the dashboard wants
    // newest at top, so reverse the windowed slice before sending.
    const slicedActivity = () => activityBuf.slice(-ACTIVITY_WINDOW).reverse();
    const slicedMessages = () => messagesBuf.slice(-MESSAGES_WINDOW).reverse();
    const slicedApprovals = () =>
      Array.from(approvalsBuf.values()).slice(-APPROVALS_WINDOW).reverse();

    // Initial snapshot — agents + buffered history.
    send({ type: "init", agents: await listAgentsBrief() });
    if (activityBuf.length > 0) {
      send({ type: "activity", items: slicedActivity() });
    }
    if (messagesBuf.length > 0) {
      send({ type: "messages", items: slicedMessages() });
    }
    if (approvalsBuf.size > 0) {
      send({ type: "approval_requests", items: slicedApprovals() });
    }

    const listener: ConnectionListener = {
      onActivity: () => send({ type: "activity", items: slicedActivity() }),
      onMessages: () => send({ type: "messages", items: slicedMessages() }),
      onApprovals: () => send({ type: "approval_requests", items: slicedApprovals() }),
    };
    connections.add(listener);

    const heartbeat = setInterval(async () => {
      if (!alive) return;
      const ok = send({ type: "agents", agents: await listAgentsBrief() });
      if (!ok) cleanup();
    }, HEARTBEAT_MS);

    const cleanup = () => {
      if (!alive) return;
      alive = false;
      connections.delete(listener);
      clearInterval(heartbeat);
      try {
        res.end();
      } catch {
        // ignore
      }
      logger.info?.("[dashboard] events: client disconnected");
    };

    return await new Promise<boolean>((resolve) => {
      const onClose = () => {
        cleanup();
        resolve(true);
      };
      req.on("close", onClose);
      req.on("error", onClose);
      res.on("close", onClose);
      res.on("error", onClose);
    });
  };
}
