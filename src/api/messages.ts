import type {
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const AGENT_ID = "main";
const SESSIONS_DIR = join(homedir(), ".openclaw", "agents", AGENT_ID, "sessions");
const SESSIONS_INDEX = join(SESSIONS_DIR, "sessions.json");

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

/**
 * Read a session JSONL file and project each event into a chat-style message.
 *
 * OpenClaw session JSONL holds heterogeneous events (turn boundaries, traces,
 * tool calls, prompts). We only keep events that look like a user/assistant
 * message — anything with a top-level `role` and text-shaped `content` or
 * `text` field.
 */
async function readSessionTranscript(
  sessionId: string,
  scope: string,
  limit: number,
  offset: number,
): Promise<{ items: DashboardMessage[]; total: number }> {
  let raw: string;
  try {
    raw = await fs.readFile(join(SESSIONS_DIR, `${sessionId}.jsonl`), "utf8");
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

    const timestamp =
      typeof event.timestamp === "string"
        ? event.timestamp
        : typeof msg.timestamp === "number"
          ? new Date(msg.timestamp).toISOString()
          : new Date().toISOString();

    messages.push({
      id: typeof event.id === "string" ? event.id : `${sessionId}-${messages.length}`,
      chat_jid: scope,
      sender: role,
      sender_name: role === "user" ? "Dashboard" : role === "assistant" ? "Agent" : "System",
      content: text,
      timestamp,
      is_from_me: role === "user",
      is_bot_message: role === "assistant",
    });
  }

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

        const sessionId = await resolveSessionIdForScope(scope);
        if (!sessionId) {
          return sendJson(res, 200, {
            messages: [],
            total: 0,
            limit,
            offset,
          });
        }

        const { items, total } = await readSessionTranscript(
          sessionId,
          scope,
          limit,
          offset,
        );
        return sendJson(res, 200, { messages: items, total, limit, offset });
      }

      // POST /api/dashboard/messages — inject systemEvent into a session
      if (method === "POST" && segments.length === 3) {
        const body = await readJsonBody<{
          folder?: unknown;
          type?: unknown;
          payload?: unknown;
        }>(req);

        const folder = typeof body.folder === "string" ? body.folder.trim() : "";
        if (!FOLDER_RE.test(folder)) {
          return sendJson(res, 400, { error: "invalid or missing folder" });
        }

        const scope = scopeKey(folder);

        // TODO(OPC-154-fu): wire api.runtime.system.enqueueSystemEvent so the
        // injected event actually lands in the agent's next turn. For now we
        // log it and tell the caller it was accepted; the dashboard can build
        // against this surface today and the real enqueue lands in a follow-up.
        logger.info?.(
          `[dashboard] systemEvent inject (stub): scope=${scope} type=${String(body.type ?? "")}`,
        );
        void runtime; // mark used so tooling does not complain

        return sendJson(res, 202, {
          accepted: true,
          scope,
          stubbed: true,
        });
      }

      // DELETE /api/dashboard/messages?folder=X — reset session
      if (method === "DELETE" && segments.length === 3) {
        const folder = url.searchParams.get("folder")?.trim() ?? "";
        if (!FOLDER_RE.test(folder)) {
          return sendJson(res, 400, { error: "invalid or missing folder" });
        }

        const scope = scopeKey(folder);

        // TODO(OPC-154-fu): wire a real gateway sessions.reset call so the
        // session JSONL is truncated and the in-memory agent state is reset.
        // For now we accept the request and surface stubbed=true so callers
        // know the underlying reset has not happened yet.
        logger.info?.(`[dashboard] reset (stub): scope=${scope}`);

        return sendJson(res, 202, {
          accepted: true,
          scope,
          stubbed: true,
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
