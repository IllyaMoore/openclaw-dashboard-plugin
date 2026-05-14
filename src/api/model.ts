import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_ID = "main";
const SESSIONS_INDEX = join(
  homedir(),
  ".openclaw",
  "agents",
  AGENT_ID,
  "sessions",
  "sessions.json",
);
const OPENCLAW_CONFIG = join(homedir(), ".openclaw", "openclaw.json");
const CHAT_SESSION_KEY = `agent:${AGENT_ID}:main`;

type ModelInfo = {
  provider: string | null;
  model: string | null;
  label: string;
  source: "session" | "config" | "fallback";
};

function formatLabel(provider: string | null, model: string | null): string {
  if (!model) return "Unknown";
  const m = model.toLowerCase();
  // Friendly names for the providers we actually run.
  if (m.includes("gpt-5.5")) return "GPT-5.5";
  if (m.includes("gpt-5")) return "GPT-5";
  if (m.includes("sonnet")) return "Claude Sonnet";
  if (m.includes("opus")) return "Claude Opus";
  if (m.includes("haiku")) return "Claude Haiku";
  return provider ? `${provider}:${model}` : model;
}

async function readModelFromSessions(): Promise<{
  provider: string | null;
  model: string | null;
} | null> {
  try {
    const raw = await fs.readFile(SESSIONS_INDEX, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entry = parsed[CHAT_SESSION_KEY] as
      | { model?: unknown; modelProvider?: unknown }
      | undefined;
    if (!entry) return null;
    return {
      provider: typeof entry.modelProvider === "string" ? entry.modelProvider : null,
      model: typeof entry.model === "string" ? entry.model : null,
    };
  } catch {
    return null;
  }
}

async function readModelFromConfig(): Promise<{
  provider: string | null;
  model: string | null;
} | null> {
  try {
    const raw = await fs.readFile(OPENCLAW_CONFIG, "utf8");
    const parsed = JSON.parse(raw) as {
      agents?: { defaults?: { model?: unknown; modelProvider?: unknown } };
    };
    const defaults = parsed.agents?.defaults;
    if (!defaults) return null;
    return {
      provider: typeof defaults.modelProvider === "string" ? defaults.modelProvider : null,
      model: typeof defaults.model === "string" ? defaults.model : null,
    };
  } catch {
    return null;
  }
}

async function resolveModel(): Promise<ModelInfo> {
  // Prefer the active session — it reflects any per-session override (e.g.
  // authProfileOverride flips the provider for a single chat).
  const fromSession = await readModelFromSessions();
  if (fromSession?.model) {
    return {
      provider: fromSession.provider,
      model: fromSession.model,
      label: formatLabel(fromSession.provider, fromSession.model),
      source: "session",
    };
  }

  const fromConfig = await readModelFromConfig();
  if (fromConfig?.model) {
    return {
      provider: fromConfig.provider,
      model: fromConfig.model,
      label: formatLabel(fromConfig.provider, fromConfig.model),
      source: "config",
    };
  }

  return { provider: null, model: null, label: "Unknown", source: "fallback" };
}

export const handleModel: OpenClawPluginHttpRouteHandler = async (_req, res) => {
  const info = await resolveModel();
  const payload = JSON.stringify(info);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload, "utf8"),
    "cache-control": "no-cache",
  });
  res.end(payload);
  return true;
};
