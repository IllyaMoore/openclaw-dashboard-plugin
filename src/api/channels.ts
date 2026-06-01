import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ServerResponse, IncomingMessage } from "node:http";

/**
 * /api/dashboard/channels
 *
 * Surfaces channel pairing state + drives WhatsApp QR-pairing from the
 * dashboard. Phase 1 scope:
 *
 *   GET  /api/dashboard/channels
 *     -> { ts, channels: { whatsapp, telegram } } projected from
 *        `openclaw channels status --json`. Includes linked / running /
 *        healthState / lastInboundAt etc.
 *
 *   POST /api/dashboard/channels/whatsapp/login
 *     -> spawns `openclaw channels login --channel whatsapp` as a child
 *        process; returns { sessionId } that the client polls.
 *
 *   GET  /api/dashboard/channels/whatsapp/login/:sessionId
 *     -> { status, stdout, qrData, startedAt, finishedAt } — polled by
 *        the frontend until status flips to "linked", "failed", or
 *        "cancelled".
 *
 *   POST /api/dashboard/channels/whatsapp/login/:sessionId/cancel
 *     -> SIGTERM the child, mark cancelled.
 */

const OPENCLAW_BIN = "/usr/bin/openclaw";

type LoginStatus =
  | "starting"
  | "qr-ready"
  | "linked"
  | "failed"
  | "cancelled";

interface LoginSession {
  id: string;
  channel: string;
  process: ChildProcess;
  stdout: string;
  startedAt: number;
  finishedAt: number | null;
  status: LoginStatus;
  qrData: string | null;
  errorMessage: string | null;
}

// In-memory store of active login sessions (gateway is a single process so
// this is fine). Auto-cleanup after 10 minutes idle to avoid leaks.
const loginSessions = new Map<string, LoginSession>();
const MAX_SESSION_MS = 10 * 60 * 1000;

function pruneStaleSessions(): void {
  const now = Date.now();
  for (const [id, s] of loginSessions) {
    const age = now - (s.finishedAt ?? s.startedAt);
    if (age > MAX_SESSION_MS) {
      if (s.process.exitCode === null && !s.process.killed) {
        try {
          s.process.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
      loginSessions.delete(id);
    }
  }
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

function runOpenclawJson(
  args: string[],
  timeoutMs = 15_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(OPENCLAW_BIN, args, { timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += String(c)));
    child.stderr?.on("data", (c) => (stderr += String(c)));
    child.on("close", (code) =>
      resolve({ ok: code === 0, stdout, stderr }),
    );
    child.on("error", (err) =>
      resolve({ ok: false, stdout: "", stderr: String(err) }),
    );
  });
}

// `openclaw channels status --json` prefixes the JSON with config warnings.
// Strip everything before the first `{`.
function extractJsonBlob(raw: string): string | null {
  const idx = raw.indexOf("{");
  if (idx < 0) return null;
  return raw.slice(idx);
}

async function fetchChannelsStatus(): Promise<{
  ts: number | null;
  channels: Record<string, unknown> | null;
  error?: string;
}> {
  const result = await runOpenclawJson(["channels", "status", "--json"]);
  if (!result.ok) {
    return {
      ts: null,
      channels: null,
      error: `channels-status failed: ${result.stderr.slice(0, 200)}`,
    };
  }
  const jsonText = extractJsonBlob(result.stdout);
  if (!jsonText) {
    return { ts: null, channels: null, error: "no json in output" };
  }
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    return {
      ts:
        typeof parsed.ts === "number"
          ? parsed.ts
          : Date.now(),
      channels:
        (parsed.channels as Record<string, unknown>) ?? null,
    };
  } catch (err) {
    return {
      ts: null,
      channels: null,
      error: err instanceof Error ? err.message : "parse error",
    };
  }
}

// Heuristics: detect WhatsApp QR appearance and linked transitions from the
// child process stdout. The QR is rendered by `qrcode` (small terminal mode):
// each row is a long sequence of half-block characters (▀ ▄ █) plus a space,
// wrapped in ANSI bg/fg color codes (\x1b[47m, \x1b[40m, \x1b[30m, \x1b[37m,
// \x1b[0m). The escape codes inflate line length, so we must strip them
// before measuring glyph density. The final qrData we return to the client
// is a small HTML fragment with <span> spans for each color region — the
// frontend renders it via dangerouslySetInnerHTML inside a <pre>.
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;
const QR_GLYPH_RE = /[▀▄█]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, "");
}

// Convert qrcode-terminal ANSI escapes into HTML <span>s with inline color
// styles. Only the small alphabet of codes we observe in qrcode output is
// honoured; everything else passes through as text. Output is safe to drop
// into dangerouslySetInnerHTML — we HTML-escape literal text and never emit
// attributes we don't control.
function ansiToHtml(input: string): string {
  let out = "";
  let i = 0;
  let bg: string | null = null;
  let fg: string | null = null;
  let openSpan = false;

  const closeSpan = () => {
    if (openSpan) {
      out += "</span>";
      openSpan = false;
    }
  };

  const openSpanIfNeeded = () => {
    if (openSpan) return;
    const styles: string[] = [];
    if (bg) styles.push(`background:${bg}`);
    if (fg) styles.push(`color:${fg}`);
    if (styles.length > 0) {
      out += `<span style="${styles.join(";")}">`;
      openSpan = true;
    }
  };

  while (i < input.length) {
    if (input[i] === "\x1b" && input[i + 1] === "[") {
      const m = /^\x1b\[([0-9;]*)m/.exec(input.slice(i));
      if (m && m[0] != null && m[1] != null) {
        const code = m[1];
        i += m[0].length;
        closeSpan();
        switch (code) {
          case "0":
          case "":
            bg = null;
            fg = null;
            break;
          case "30":
            fg = "#000";
            break;
          case "37":
            fg = "#fff";
            break;
          case "40":
            bg = "#000";
            break;
          case "47":
            bg = "#fff";
            break;
          default:
            break;
        }
        continue;
      }
    }
    const ch = input[i] ?? "";
    if (ch === "&" || ch === "<" || ch === ">") {
      openSpanIfNeeded();
      out +=
        ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;";
    } else if (ch === "\n") {
      closeSpan();
      out += "\n";
    } else {
      openSpanIfNeeded();
      out += ch;
    }
    i += 1;
  }
  closeSpan();
  return out;
}

function classifyStdout(stdout: string): {
  qrData: string | null;
  linked: boolean;
} {
  // Walk lines; identify a contiguous QR block by counting half-block glyphs
  // after stripping ANSI. The QR rows are tens-to-hundreds of glyphs wide.
  const lines = stdout.split("\n");
  let qrStart = -1;
  let qrEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const plain = stripAnsi(raw);
    const glyphCount = (plain.match(QR_GLYPH_RE)?.length ?? 0);
    // Density on the stripped line; QR rows are almost entirely block glyphs
    // (possibly with leading/trailing whitespace), so density should be high.
    const density = glyphCount / Math.max(1, plain.length);
    const looksLikeQrRow = glyphCount >= 10 && density > 0.5;
    if (looksLikeQrRow) {
      if (qrStart < 0) qrStart = i;
      qrEnd = i;
    } else if (qrStart >= 0 && qrEnd >= 0 && i - qrEnd > 2) {
      break;
    }
  }
  let qrData: string | null = null;
  if (qrStart >= 0 && qrEnd > qrStart) {
    const block = lines.slice(qrStart, qrEnd + 1).join("\n");
    qrData = ansiToHtml(block);
  }

  const lower = stripAnsi(stdout).toLowerCase();
  // Be picky here. The CLI prints "open ... linked devices" in its
  // pre-pair instructions, so a bare /\blinked\b/ would fire before the
  // user has scanned anything. Match phrases the CLI only emits on
  // success.
  const linked =
    /credentials saved for future sends/.test(lower) ||
    /\blinked!/.test(lower) ||
    /linked after restart/.test(lower) ||
    /web session ready/.test(lower) ||
    /paired successfully/.test(lower);

  return { qrData, linked };
}

function projectSession(s: LoginSession): {
  id: string;
  channel: string;
  status: LoginStatus;
  qrData: string | null;
  stdoutTail: string;
  startedAt: number;
  finishedAt: number | null;
  errorMessage: string | null;
} {
  return {
    id: s.id,
    channel: s.channel,
    status: s.status,
    qrData: s.qrData,
    // Trim stdout to last 4 KB; strip ANSI so the diagnostic pane stays
    // readable when something goes wrong before we recognise the QR.
    stdoutTail: stripAnsi(s.stdout).slice(-4096),
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    errorMessage: s.errorMessage,
  };
}

function startWhatsAppLogin(): LoginSession {
  pruneStaleSessions();
  const id = randomUUID();
  const proc = spawn(OPENCLAW_BIN, [
    "channels",
    "login",
    "--channel",
    "whatsapp",
    "--verbose",
  ]);
  const session: LoginSession = {
    id,
    channel: "whatsapp",
    process: proc,
    stdout: "",
    startedAt: Date.now(),
    finishedAt: null,
    status: "starting",
    qrData: null,
    errorMessage: null,
  };

  const onChunk = (chunk: Buffer | string) => {
    session.stdout += String(chunk);
    if (session.stdout.length > 64 * 1024) {
      // Truncate from the head to keep the buffer bounded; the QR block
      // we care about is always near the tail.
      session.stdout = session.stdout.slice(-32 * 1024);
    }
    const { qrData, linked } = classifyStdout(session.stdout);
    if (qrData && (!session.qrData || qrData !== session.qrData)) {
      session.qrData = qrData;
      if (session.status === "starting") session.status = "qr-ready";
    }
    if (linked) {
      session.status = "linked";
    }
  };

  proc.stdout?.on("data", onChunk);
  proc.stderr?.on("data", onChunk);
  proc.on("close", (code) => {
    session.finishedAt = Date.now();
    if (session.status === "starting" || session.status === "qr-ready") {
      // Process closed without an explicit "linked" signal — treat as
      // failed unless someone cancelled it.
      session.status = code === 0 ? "linked" : "failed";
      if (code !== 0) {
        session.errorMessage = `process exited with code ${code}`;
      }
    }
  });
  proc.on("error", (err) => {
    session.finishedAt = Date.now();
    session.status = "failed";
    session.errorMessage = String(err);
  });

  loginSessions.set(id, session);
  return session;
}

function cancelLogin(sessionId: string): boolean {
  const session = loginSessions.get(sessionId);
  if (!session) return false;
  if (session.process.exitCode === null && !session.process.killed) {
    try {
      session.process.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  session.status = "cancelled";
  if (!session.finishedAt) session.finishedAt = Date.now();
  return true;
}

export const handleChannels: OpenClawPluginHttpRouteHandler = async (
  req: IncomingMessage,
  res: ServerResponse,
) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const segments = url.pathname.split("/").filter(Boolean);
  // ["api", "dashboard", "channels", ...]
  if (
    segments[0] !== "api" ||
    segments[1] !== "dashboard" ||
    segments[2] !== "channels"
  ) {
    return sendJson(res, 404, { error: "not found" });
  }

  const method = (req.method ?? "GET").toUpperCase();

  try {
    // GET /api/dashboard/channels
    if (segments.length === 3 && method === "GET") {
      const result = await fetchChannelsStatus();
      return sendJson(res, 200, result);
    }

    // POST /api/dashboard/channels/whatsapp/login
    if (
      segments.length === 5 &&
      segments[3] === "whatsapp" &&
      segments[4] === "login" &&
      method === "POST"
    ) {
      const session = startWhatsAppLogin();
      return sendJson(res, 200, projectSession(session));
    }

    // GET /api/dashboard/channels/whatsapp/login/:sessionId
    if (
      segments.length === 6 &&
      segments[3] === "whatsapp" &&
      segments[4] === "login" &&
      method === "GET"
    ) {
      const sid = segments[5];
      if (!sid) return sendJson(res, 400, { error: "missing session id" });
      const session = loginSessions.get(sid);
      if (!session) return sendJson(res, 404, { error: "session not found" });
      return sendJson(res, 200, projectSession(session));
    }

    // POST /api/dashboard/channels/whatsapp/login/:sessionId/cancel
    if (
      segments.length === 7 &&
      segments[3] === "whatsapp" &&
      segments[4] === "login" &&
      segments[6] === "cancel" &&
      method === "POST"
    ) {
      const sid = segments[5];
      if (!sid) return sendJson(res, 400, { error: "missing session id" });
      const ok = cancelLogin(sid);
      if (!ok) return sendJson(res, 404, { error: "session not found" });
      return sendJson(res, 200, { cancelled: true });
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal error";
    return sendJson(res, 500, { error: message });
  }
};
