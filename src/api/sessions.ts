import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";

const AGENT_ID = "main";
const AGENT_SESSIONS_DIR = join(
  homedir(),
  ".openclaw",
  "agents",
  AGENT_ID,
  "sessions",
);
const INDEX_FILE = join(AGENT_SESSIONS_DIR, "sessions.json");

// Approximate context limit. The dashboard surfaces % full of this denominator;
// the real number depends on the model in use (gpt-5.5 ~ 200k, others differ).
// Imprecise but communicates the "running out of room" signal that matters in
// a personal-assistant context.
const CONTEXT_LIMIT = 200_000;

type Channel = "webchat" | "whatsapp" | "telegram" | "cron" | "other";

type IndexEntry = {
  sessionId: string;
  updatedAt?: number;
  sessionStartedAt?: number;
  lastInteractionAt?: number;
  chatType?: string;
  deliveryContext?: { channel?: string };
  lastChannel?: string;
  origin?: { provider?: string; surface?: string; label?: string };
  sessionFile?: string;
  compactionCount?: number;
  skillsSnapshot?: { skills?: Array<{ name: string }> };
};

type SessionsIndex = Record<string, IndexEntry>;

type SessionSummary = {
  key: string;
  sessionId: string;
  channel: Channel;
  subject: string;
  chatType: string;
  lastInteractionAt: string | null;
  turns: number;
  contextUsed: number;
  contextPct: number;
  contextLimit: number;
  lastError: { timestamp: string; reason: string } | null;
  model: string | null;
  compactionCount: number;
  skills: string[];
};

function sendJson(res: ServerResponse, status: number, body: unknown): boolean {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload, "utf8"),
  });
  res.end(payload);
  return true;
}

// Webchat first, then humans, then automated cron last.
const SORT_ORDER: Record<Channel, number> = {
  webchat: 0,
  whatsapp: 1,
  telegram: 2,
  cron: 3,
  other: 4,
};

function categorize(key: string): { channel: Channel; subject: string } {
  if (key === `agent:${AGENT_ID}:main`) {
    return { channel: "webchat", subject: "main" };
  }
  const wa = key.match(/:whatsapp:[^:]+:(.+)$/);
  if (wa?.[1]) return { channel: "whatsapp", subject: wa[1] };
  const tg = key.match(/:telegram:([^:]+):(.+)$/);
  if (tg?.[1] && tg?.[2]) return { channel: "telegram", subject: `${tg[1]}:${tg[2]}` };
  const cr = key.match(/:cron:(.+)$/);
  if (cr?.[1]) return { channel: "cron", subject: cr[1] };
  return { channel: "other", subject: key };
}

async function readIndex(): Promise<SessionsIndex> {
  try {
    const raw = await fs.readFile(INDEX_FILE, "utf8");
    return JSON.parse(raw) as SessionsIndex;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

type JsonlEvent = {
  type?: string;
  customType?: string;
  modelId?: string;
  message?: {
    role?: string;
    usage?: { totalTokens?: number; input?: number; output?: number; cacheRead?: number };
  };
  data?: { error?: string };
  timestamp?: string;
};

async function aggregate(sessionFile: string | undefined): Promise<{
  turns: number;
  contextUsed: number;
  lastError: SessionSummary["lastError"];
  model: string | null;
}> {
  const result = {
    turns: 0,
    contextUsed: 0,
    lastError: null as SessionSummary["lastError"],
    model: null as string | null,
  };
  if (!sessionFile) return result;

  let raw: string;
  try {
    raw = await fs.readFile(sessionFile, "utf8");
  } catch {
    return result;
  }

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let evt: JsonlEvent;
    try {
      evt = JSON.parse(line) as JsonlEvent;
    } catch {
      continue;
    }
    if (evt.type === "model_change" && typeof evt.modelId === "string") {
      result.model = evt.modelId;
    }
    if (evt.type === "message" && evt.message?.role === "assistant") {
      result.turns += 1;
      const usage = evt.message?.usage;
      if (usage && typeof usage.totalTokens === "number") {
        // Last assistant message wins — represents "context heading into next turn"
        result.contextUsed = usage.totalTokens;
      } else if (usage) {
        const sum =
          (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0);
        if (sum) result.contextUsed = sum;
      }
    }
    if (evt.type === "custom" && evt.customType === "openclaw:prompt-error") {
      result.lastError = {
        timestamp: evt.timestamp ?? "",
        reason: String(evt.data?.error ?? "unknown"),
      };
    }
  }
  return result;
}

async function listSessions(): Promise<SessionSummary[]> {
  const index = await readIndex();
  const summaries: SessionSummary[] = [];
  for (const [key, entry] of Object.entries(index)) {
    const { channel, subject } = categorize(key);
    const agg = await aggregate(entry.sessionFile);
    summaries.push({
      key,
      sessionId: entry.sessionId,
      channel,
      subject,
      chatType: entry.chatType ?? "?",
      lastInteractionAt: entry.lastInteractionAt
        ? new Date(entry.lastInteractionAt).toISOString()
        : null,
      turns: agg.turns,
      contextUsed: agg.contextUsed,
      contextPct: Math.min(
        100,
        Math.round((agg.contextUsed / CONTEXT_LIMIT) * 100),
      ),
      contextLimit: CONTEXT_LIMIT,
      lastError: agg.lastError,
      model: agg.model,
      compactionCount: entry.compactionCount ?? 0,
      skills: entry.skillsSnapshot?.skills?.map((s) => s.name) ?? [],
    });
  }
  summaries.sort((a, b) => {
    const ca = SORT_ORDER[a.channel];
    const cb = SORT_ORDER[b.channel];
    if (ca !== cb) return ca - cb;
    const ta = a.lastInteractionAt ? Date.parse(a.lastInteractionAt) : 0;
    const tb = b.lastInteractionAt ? Date.parse(b.lastInteractionAt) : 0;
    return tb - ta;
  });
  return summaries;
}

async function readEvents(
  key: string,
  limit: number,
): Promise<unknown[] | null> {
  const index = await readIndex();
  const entry = index[key];
  if (!entry?.sessionFile) return null;
  let raw: string;
  try {
    raw = await fs.readFile(entry.sessionFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const events: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  const safeLimit = Math.max(1, Math.min(2000, limit));
  return events.slice(-safeLimit);
}

async function callGatewayReset(
  key: string,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/openclaw", [
      "gateway",
      "call",
      "sessions.reset",
      "--params",
      JSON.stringify({ key }),
      "--json",
    ]);
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += String(c)));
    child.stderr.on("data", (c) => (err += String(c)));
    child.on("close", (code) => {
      resolve({ ok: code === 0, output: out || err });
    });
    child.on("error", (e) => {
      resolve({ ok: false, output: String(e) });
    });
  });
}

export const handleSessions: OpenClawPluginHttpRouteHandler = async (
  req,
  res,
) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const segments = url.pathname.split("/").filter(Boolean);

  if (
    segments[0] !== "api" ||
    segments[1] !== "dashboard" ||
    segments[2] !== "sessions"
  ) {
    return sendJson(res, 404, { error: "not found" });
  }

  const key = segments[3] ? decodeURIComponent(segments[3]) : undefined;
  const sub = segments[4];
  const method = (req.method ?? "GET").toUpperCase();

  try {
    if (key === undefined) {
      if (method === "GET") {
        return sendJson(res, 200, await listSessions());
      }
      return sendJson(res, 405, { error: `method ${method} not allowed` });
    }

    if (sub === undefined) {
      if (method === "GET") {
        const list = await listSessions();
        const summary = list.find((s) => s.key === key);
        if (!summary) {
          return sendJson(res, 404, { error: `session "${key}" not found` });
        }
        return sendJson(res, 200, summary);
      }
      return sendJson(res, 405, { error: `method ${method} not allowed` });
    }

    if (sub === "events") {
      if (method !== "GET") {
        return sendJson(res, 405, { error: `method ${method} not allowed` });
      }
      const limitRaw = url.searchParams.get("limit") ?? "200";
      const limit = parseInt(limitRaw, 10) || 200;
      const events = await readEvents(key, limit);
      if (events === null) {
        return sendJson(res, 404, { error: `session "${key}" not found` });
      }
      return sendJson(res, 200, { key, events });
    }

    if (sub === "reset") {
      if (method !== "POST") {
        return sendJson(res, 405, { error: `method ${method} not allowed` });
      }
      const result = await callGatewayReset(key);
      if (!result.ok) {
        return sendJson(res, 500, {
          error: "reset failed",
          output: result.output.slice(0, 2000),
        });
      }
      return sendJson(res, 200, { key, reset: true, output: result.output.slice(0, 2000) });
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal error";
    return sendJson(res, 500, { error: message });
  }
};
