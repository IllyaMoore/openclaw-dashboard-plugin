import type {
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { callGateway } from "openclaw/plugin-sdk/testing";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";

const AGENT_ID = "main";
const SESSIONS_DIR = join(homedir(), ".openclaw", "agents", AGENT_ID, "sessions");
const SESSIONS_INDEX = join(SESSIONS_DIR, "sessions.json");

// All dashboard chat traffic is routed through OpenClaw's main session
// (the same one Telegram / WhatsApp channels deliver to). The folder picker
// in the sidebar selects which agent persona is in scope for prompt/settings
// editing — for actual conversation, every dashboard tab shares the main chat.
// Real per-folder isolation needs runtime.agent.runEmbeddedAgent and is
// tracked as OPC-154-fu / OPC-152 follow-up.
const CHAT_SESSION_KEY = "main";

const FOLDER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

type DashboardMessage = {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message: boolean;
};

function scopeKey(folder: string): string {
  return `agent:${AGENT_ID}:dashboard:${folder}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): boolean {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload, "utf8"),
  });
  res.end(payload);
  return true;
}

async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {} as T;
  }
  return JSON.parse(raw) as T;
}

/**
 * Look up the OpenClaw session UUID that owns a given scope key.
 *
 * The agent host writes a registry at `~/.openclaw/agents/main/sessions/sessions.json`
 * mapping scope keys to session UUIDs. We read it directly; if the file is
 * missing or malformed we treat that as "no session yet" and return null.
 */
async function resolveSessionIdForScope(scope: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(SESSIONS_INDEX, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    // Canonical shape: { [scopeKey]: { sessionId: string, ... } }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entry = (parsed as Record<string, { sessionId?: unknown }>)[scope];
      if (entry && typeof entry.sessionId === "string") {
        return entry.sessionId;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// After a sessions.reset the gateway provisions a fresh session whose
// sessionFile path is not derivable from sessionId (different UUIDs). Read
// the authoritative `sessionFile` straight from sessions.json so the
// transcript loader always opens the right file.
async function resolveSessionFileForScope(scope: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(SESSIONS_INDEX, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entry = (parsed as Record<string, { sessionFile?: unknown }>)[scope];
      if (entry && typeof entry.sessionFile === "string") {
        return entry.sessionFile;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read a session JSONL file and project each event into a chat-style message.
 *
 * OpenClaw session JSONL holds heterogeneous events (turn boundaries, traces,
 * tool calls, prompts). We only keep events that look like a user/assistant
 * message — anything with a top-level `role` and text-shaped `content` or
 * `text` field.
 */
async function readSessionTranscript(
  sessionFile: string,
  scope: string,
  limit: number,
  offset: number,
): Promise<{ items: DashboardMessage[]; total: number }> {
  let raw: string;
  try {
    // `sessionFile` is an absolute path read from sessions.json. After
    // sessions.reset, the gateway may write the new jsonl under a different
    // UUID than `sessionId`, so prefer the indexed path over a derived one.
    raw = await fs.readFile(sessionFile, "utf8");
  } catch {
    return { items: [], total: 0 };
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const messages: DashboardMessage[] = [];

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (event.type !== "message") continue;

    const msg = event.message as
      | { role?: unknown; content?: unknown; timestamp?: unknown }
      | undefined;
    if (!msg || typeof msg.role !== "string") continue;

    const role = msg.role;
    if (role !== "user" && role !== "assistant" && role !== "system") continue;

    // Heartbeat round-trips ("[OpenClaw heartbeat poll]" → "HEARTBEAT_OK") are
    // internal keep-alive traffic injected by the runtime, not real chat. Drop
    // them so the transcript shows only conversational turns.
    const previewParts = Array.isArray(msg.content) ? msg.content : [];
    const firstText = previewParts.find(
      (p: unknown): p is { type: string; text: string } =>
        !!p &&
        typeof p === "object" &&
        (p as { type?: unknown }).type === "text" &&
        typeof (p as { text?: unknown }).text === "string",
    );
    const heartbeatText = firstText?.text?.trim() ?? "";
    if (
      heartbeatText === "[OpenClaw heartbeat poll]" ||
      heartbeatText === "HEARTBEAT_OK"
    ) {
      continue;
    }

    // OpenClaw stores `content` as an array of typed parts:
    //   [{type:"text", text:"..."}, {type:"toolCall", ...}, ...]
    // For chat-style transcripts we project only the text parts and join them.
    let text = "";
    if (Array.isArray(msg.content)) {
      text = msg.content
        .filter(
          (p): p is { type: string; text: string } =>
            !!p &&
            typeof p === "object" &&
            (p as { type?: unknown }).type === "text" &&
            typeof (p as { text?: unknown }).text === "string",
        )
        .map((p) => p.text)
        .join("\n\n");
    } else if (typeof msg.content === "string") {
      text = msg.content;
    }
    if (!text) continue;

    // The gateway prepends `[<weekday> <yyyy-mm-dd hh:mm UTC>] ` to every
    // inbound user message so the agent sees turn boundaries. Strip it for
    // display — both for readability and so the dashboard's 10s content-match
    // dedup against optimistic updates actually fires.
    if (role === "user") {
      text = text.replace(/^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\]\s*/, "");
    }

    const timestamp =
      typeof event.timestamp === "string"
        ? event.timestamp
        : typeof msg.timestamp === "number"
          ? new Date(msg.timestamp).toISOString()
          : new Date().toISOString();

    messages.push({
      id: typeof event.id === "string" ? event.id : `${sessionFile}-${messages.length}`,
      // Prefix with `dashboard-` so ChatBubble's source-label fallback skips
      // labelling these as "WhatsApp". The underlying main session is genuinely
      // shared across channels and we can't recover the originating channel
      // from JSONL alone — better to render no label than a wrong one.
      chat_jid: `dashboard-${scope}`,
      sender: role,
      sender_name: role === "user" ? "You" : role === "assistant" ? "Agent" : "System",
      content: text,
      timestamp,
      is_from_me: role === "user",
      is_bot_message: role === "assistant",
    });
  }

  // The dashboard UI expects newest-first (it reverses for display in
  // use-messages.ts). Sort descending by timestamp and slice from the head.
  messages.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  const total = messages.length;
  const sliced = messages.slice(offset, offset + limit);
  return { items: sliced, total };
}

export function createMessagesHandler(
  runtime: OpenClawPluginApi["runtime"],
  logger: OpenClawPluginApi["logger"],
): OpenClawPluginHttpRouteHandler {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);

    if (
      segments[0] !== "api" ||
      segments[1] !== "dashboard" ||
      segments[2] !== "messages"
    ) {
      return sendJson(res, 404, { error: "not found" });
    }

    const method = (req.method ?? "GET").toUpperCase();

    try {
      // GET /api/dashboard/messages?folder=X&limit=N&offset=O
      if (method === "GET" && segments.length === 3) {
        const folder = url.searchParams.get("folder")?.trim() ?? "";
        if (!folder) {
          return sendJson(res, 400, {
            error: "folder query parameter is required",
          });
        }
        if (!FOLDER_RE.test(folder)) {
          return sendJson(res, 400, { error: "invalid folder name" });
        }

        const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);
        const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
        const scope = scopeKey(folder);

        // Try the per-folder dashboard session first. If empty, fall back to
        // the shared main session — that's where dashboard POSTs are routed
        // and where the agent writes replies.
        let sessionFile = await resolveSessionFileForScope(scope);
        const projectedScope = scope; // keep the dashboard scope in the response shape
        if (!sessionFile) {
          sessionFile = await resolveSessionFileForScope(
            `agent:${AGENT_ID}:${CHAT_SESSION_KEY}`,
          );
        }

        if (!sessionFile) {
          return sendJson(res, 200, {
            messages: [],
            total: 0,
            limit,
            offset,
          });
        }

        const { items, total } = await readSessionTranscript(
          sessionFile,
          projectedScope,
          limit,
          offset,
        );
        return sendJson(res, 200, { messages: items, total, limit, offset });
      }

      // POST /api/dashboard/messages — inject a user message + wake the agent.
      //
      // Command-Center's POST shape allows either a structured systemEvent
      // ({folder, type, payload}) or a chat-style user message
      // ({text, group, ...}). We accept both. For chat, we project the user's
      // text into the scope's systemEvent queue and request a heartbeat so the
      // agent picks it up on its next turn.
      if (method === "POST" && segments.length === 3) {
        const body = await readJsonBody<{
          folder?: unknown;
          group?: unknown;
          text?: unknown;
          type?: unknown;
          payload?: unknown;
        }>(req);

        const folder =
          typeof body.folder === "string"
            ? body.folder.trim()
            : typeof body.group === "string"
              ? body.group.trim()
              : "";
        if (!FOLDER_RE.test(folder)) {
          return sendJson(res, 400, { error: "invalid or missing folder" });
        }

        const text =
          typeof body.text === "string"
            ? body.text.trim()
            : typeof body.payload === "string"
              ? body.payload.trim()
              : typeof body.payload === "object" &&
                  body.payload !== null &&
                  typeof (body.payload as { text?: unknown }).text === "string"
                ? (body.payload as { text: string }).text.trim()
                : "";

        if (!text) {
          return sendJson(res, 400, { error: "missing text or payload.text" });
        }

        const scope = scopeKey(folder);

        // Route through the gateway's chat.send RPC — same path the openclaw
        // built-in control UI takes. The gateway loads the session, picks an
        // agent (defaults to "main"), and dispatches the message asynchronously
        // to runEmbeddedAgent. The agent's reply lands in the main session
        // JSONL where the dashboard's GET handler picks it up on the next
        // poll.
        const idempotencyKey = randomUUID();
        const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
        if (!gatewayToken) {
          return sendJson(res, 500, {
            error: "gateway token not configured",
          });
        }

        let ack: { runId?: string; status?: string };
        try {
          ack = await callGateway<{ runId: string; status: string }>({
            url: "ws://127.0.0.1:18789",
            token: gatewayToken,
            method: "chat.send",
            params: {
              sessionKey: CHAT_SESSION_KEY,
              message: text,
              idempotencyKey,
              deliver: false,
            },
            timeoutMs: 10_000,
            clientName: "gateway-client",
          });
        } catch (err) {
          logger.warn?.(
            `[dashboard] chat.send failed for folder=${folder}: ${String(err)}`,
          );
          return sendJson(res, 502, {
            error: "gateway chat.send failed",
            detail: err instanceof Error ? err.message : String(err),
          });
        }

        logger.info?.(
          `[dashboard] chat.send accepted: folder=${folder} runId=${ack?.runId ?? "?"} chars=${text.length}`,
        );

        // Echo the assistant scope back so the front end can correlate, but
        // the *real* transcript lives under CHAT_SESSION_KEY ("main"). GET
        // /api/dashboard/messages reads from there.
        return sendJson(res, 200, {
          ok: true,
          success: true,
          scope,
          group: folder,
          jid: scope,
          runId: ack?.runId,
          chatSessionKey: CHAT_SESSION_KEY,
        });
      }

      // DELETE /api/dashboard/messages?folder=X — reset the chat session.
      // Maps the dashboard's per-folder Clear action to a real
      // `openclaw gateway call sessions.reset` against the shared chat
      // session (`agent:<AGENT_ID>:<CHAT_SESSION_KEY>`). The session JSONL is
      // archived to `.jsonl.reset.<timestamp>` and the in-memory agent
      // forgets context.
      if (method === "DELETE" && segments.length === 3) {
        const folder = url.searchParams.get("folder")?.trim() ?? "";
        if (!FOLDER_RE.test(folder)) {
          return sendJson(res, 400, { error: "invalid or missing folder" });
        }

        const sessionKey = `agent:${AGENT_ID}:${CHAT_SESSION_KEY}`;
        const result = await new Promise<{ ok: boolean; output: string }>(
          (resolve) => {
            const child = spawn("/usr/bin/openclaw", [
              "gateway",
              "call",
              "sessions.reset",
              "--params",
              JSON.stringify({ key: sessionKey }),
              "--json",
            ]);
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (c) => (stdout += String(c)));
            child.stderr.on("data", (c) => (stderr += String(c)));
            child.on("close", (code) => {
              resolve({
                ok: code === 0,
                output: (stdout + stderr).slice(0, 2000),
              });
            });
            child.on("error", (err) => {
              resolve({ ok: false, output: String(err).slice(0, 2000) });
            });
          },
        );

        if (!result.ok) {
          logger.warn?.(
            `[dashboard] reset failed: sessionKey=${sessionKey} output=${result.output}`,
          );
          return sendJson(res, 500, {
            error: "reset failed",
            sessionKey,
            output: result.output,
          });
        }

        logger.info?.(`[dashboard] reset: sessionKey=${sessionKey}`);
        return sendJson(res, 200, {
          reset: true,
          sessionKey,
          output: result.output,
        });
      }

      return sendJson(res, 405, { error: `method ${method} not allowed` });
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      return sendJson(res, 500, { error: message });
    }
  };
}

function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
