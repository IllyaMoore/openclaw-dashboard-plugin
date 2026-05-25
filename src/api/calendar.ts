import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";

/**
 * /api/dashboard/calendar/events
 *
 * Projects Google Calendar events through the installed `gog` CLI. The host
 * keeps an OAuth token in /home/<user>/.config/gogcli/, gated by
 * GOG_KEYRING_PASSWORD + GOG_ACCOUNT env vars stored in ~/.openclaw/.env.
 *
 * We avoid `gog calendar events list --today/--week/--days` because those
 * paths return `404 notFound` against this account's primary calendar (gog
 * bug). Plain `gog calendar list` works and returns the active window of
 * events; we filter to the requested view client-side.
 */

const GOG_BIN = "/usr/local/bin/gog";
const ENV_FILE = join(homedir(), ".openclaw", ".env");

interface GogEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
}

interface DashboardEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): boolean {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload, "utf8"),
    "cache-control": "no-cache",
  });
  res.end(payload);
  return true;
}

async function loadGogEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  try {
    const raw = await fs.readFile(ENV_FILE, "utf8");
    for (const line of raw.split("\n")) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
      if (!m || !m[1]) continue;
      const key: string = m[1];
      const rawValue: string = m[2] ?? "";
      env[key] = rawValue.replace(/^"([^"]*)"$/, "$1");
    }
  } catch {
    // .env unreadable — caller falls back to empty events.
  }
  return env;
}

function runGogList(
  env: Record<string, string>,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      GOG_BIN,
      ["calendar", "list", "--json", "--results-only"],
      {
        env: {
          ...process.env,
          ...env,
          HOME: process.env.HOME ?? "/home/ubuntu",
        },
        timeout: 15_000,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("close", (code) =>
      resolve({ ok: code === 0, stdout, stderr }),
    );
    child.on("error", (err) =>
      resolve({ ok: false, stdout: "", stderr: String(err) }),
    );
  });
}

function viewBounds(
  view: "day" | "week",
  now = new Date(),
): { start: Date; end: Date } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + (view === "day" ? 1 : 7));
  return { start, end };
}

function project(events: GogEvent[], view: "day" | "week"): DashboardEvent[] {
  const { start: viewStart, end: viewEnd } = viewBounds(view);
  const out: DashboardEvent[] = [];
  for (const e of events) {
    if (!e.start) continue;
    const startStr = e.start.dateTime ?? e.start.date;
    if (!startStr) continue;
    const startDate = new Date(startStr);
    if (Number.isNaN(startDate.getTime())) continue;
    if (startDate < viewStart || startDate >= viewEnd) continue;
    if (e.status === "cancelled") continue;
    const endStr = e.end?.dateTime ?? e.end?.date ?? startStr;
    out.push({
      id: e.id ?? `${startStr}-${e.summary ?? ""}`,
      title: e.summary ?? "(no title)",
      start: startStr,
      end: endStr,
      allDay: !e.start.dateTime,
      ...(e.location ? { location: e.location } : {}),
      ...(e.description ? { description: e.description } : {}),
    });
  }
  out.sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );
  return out;
}

export const handleCalendarEvents: OpenClawPluginHttpRouteHandler = async (
  req,
  res,
) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const view: "day" | "week" =
    url.searchParams.get("view") === "week" ? "week" : "day";

  const env = await loadGogEnv();
  if (!env.GOG_ACCOUNT || !env.GOG_KEYRING_PASSWORD) {
    return sendJson(res, 200, {
      events: [],
      error: "gog_env_missing",
    });
  }

  const result = await runGogList(env);
  if (!result.ok) {
    return sendJson(res, 200, {
      events: [],
      error: "gog_failed",
      detail: result.stderr.slice(0, 200),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return sendJson(res, 200, {
      events: [],
      error: "gog_parse_failed",
    });
  }
  if (!Array.isArray(parsed)) {
    return sendJson(res, 200, {
      events: [],
      error: "gog_unexpected_shape",
    });
  }

  return sendJson(res, 200, {
    events: project(parsed as GogEvent[], view),
  });
};
