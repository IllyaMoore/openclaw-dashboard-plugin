import type {
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_ID = "main";
const WORKSPACE_BASE = join(
  homedir(),
  ".openclaw",
  "workspace",
  "dashboard-agents",
);
const FOLDER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const POLL_INTERVAL_MS = 2000;

type AgentBrief = {
  jid: string;
  name: string;
  folder: string;
  online: boolean;
};

async function readAgentSettings(folder: string): Promise<{ name?: string }> {
  try {
    const raw = await fs.readFile(
      join(WORKSPACE_BASE, folder, "settings.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { name?: unknown };
    return { name: typeof parsed.name === "string" ? parsed.name : undefined };
  } catch {
    return {};
  }
}

async function listAgentsBrief(): Promise<AgentBrief[]> {
  try {
    await fs.mkdir(WORKSPACE_BASE, { recursive: true });
    const entries = await fs.readdir(WORKSPACE_BASE, { withFileTypes: true });
    const items: AgentBrief[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folder = entry.name;
      if (!FOLDER_RE.test(folder)) continue;
      const settings = await readAgentSettings(folder);
      items.push({
        jid: `agent:${AGENT_ID}:dashboard:${folder}`,
        name: settings.name ?? folder,
        folder,
        // TODO(OPC-157-fu): derive from runtime.tasks.runs.list().
        online: false,
      });
    }

    return items;
  } catch {
    return [];
  }
}

export function createEventsHandler(
  runtime: OpenClawPluginApi["runtime"],
  logger: OpenClawPluginApi["logger"],
): OpenClawPluginHttpRouteHandler {
  return async (req, res) => {
    // SSE handshake: open-ended response, no buffering, keep-alive.
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    });
    // Hint to flush headers immediately so the client opens the stream.
    if (typeof (res as { flushHeaders?: () => void }).flushHeaders === "function") {
      (res as { flushHeaders: () => void }).flushHeaders();
    }

    const send = (payload: unknown): boolean => {
      try {
        return res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        return false;
      }
    };

    // Initial snapshot: matches Command-Center { type: "init", agents } shape.
    const initialAgents = await listAgentsBrief();
    send({ type: "init", agents: initialAgents });

    // Poll loop: emit fresh agents snapshot every POLL_INTERVAL_MS, and empty
    // activity/messages/approval_requests envelopes so the client knows the
    // stream is alive even with no real events to push.
    //
    // TODO(OPC-157-fu): replace polling with real runtime subscriptions
    //   - runtime.events.onAgentEvent -> activity items
    //   - runtime.events.onSessionTranscriptUpdate -> message append events
    //   - approval-handler-runtime -> approval_requests (when surfaced)
    void runtime;

    let cancelled = false;
    const interval = setInterval(async () => {
      if (cancelled) return;
      const agents = await listAgentsBrief();
      const ok =
        send({ type: "agents", agents }) &&
        send({ type: "activity", items: [] }) &&
        send({ type: "messages", items: [] }) &&
        send({ type: "approval_requests", items: [] });

      if (!ok) {
        cancelled = true;
        clearInterval(interval);
      }
    }, POLL_INTERVAL_MS);

    // Return a promise that resolves when the client disconnects.
    return await new Promise<boolean>((resolve) => {
      const cleanup = () => {
        if (cancelled) return;
        cancelled = true;
        clearInterval(interval);
        try {
          res.end();
        } catch {
          // Ignore errors after disconnect.
        }
        logger.info?.("[dashboard] events: client disconnected");
        resolve(true);
      };
      req.on("close", cleanup);
      req.on("error", cleanup);
      res.on("close", cleanup);
      res.on("error", cleanup);
    });
  };
}
