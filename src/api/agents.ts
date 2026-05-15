import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";

const AGENT_ID = "main";
const WORKSPACE_DIR = join(homedir(), ".openclaw", "workspace");
const IDENTITY_FILE = join(WORKSPACE_DIR, "IDENTITY.md");
const MEMORY_FILE = join(WORKSPACE_DIR, "MEMORY.md");

const MAIN_FOLDER = "main";
const MAIN_JID = `agent:${AGENT_ID}`;

const DEPRECATED_BODY = {
  error:
    "folder-based dashboard agents are deprecated; agents are now declared via openclaw.json `agents.*`",
  hint: "the dashboard surfaces the singular OpenClaw agent (main). edit prompts via the agent's workspace IDENTITY.md.",
};

type AgentListItem = {
  jid: string;
  name: string;
  folder: string;
  online: boolean;
  lastActivity: string | null;
  currentTask: string | null;
  containerName: string | null;
  pendingMessages: boolean;
  pendingTaskCount: number;
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

async function listAgents(): Promise<AgentListItem[]> {
  return [
    {
      jid: MAIN_JID,
      name: await readMainAgentName(),
      folder: MAIN_FOLDER,
      online: true,
      // TODO: derive from sessions.json (latest updatedAt across sessions).
      lastActivity: null,
      currentTask: null,
      containerName: null,
      pendingMessages: false,
      pendingTaskCount: 0,
    },
  ];
}

async function readMainIdentityFile(): Promise<string> {
  try {
    return await fs.readFile(IDENTITY_FILE, "utf8");
  } catch {
    return "";
  }
}

async function writeMainIdentityFile(content: string): Promise<void> {
  await fs.mkdir(WORKSPACE_DIR, { recursive: true });
  await fs.writeFile(IDENTITY_FILE, content, "utf8");
}

async function readMainMemoryFile(): Promise<{ content: string; mtime: string | null }> {
  try {
    const [stat, content] = await Promise.all([
      fs.stat(MEMORY_FILE),
      fs.readFile(MEMORY_FILE, "utf8"),
    ]);
    return { content, mtime: stat.mtime.toISOString() };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Empty memory is normal initial state; not an error.
      return { content: "", mtime: null };
    }
    throw err;
  }
}

async function currentMemoryMtime(): Promise<string | null> {
  try {
    const stat = await fs.stat(MEMORY_FILE);
    return stat.mtime.toISOString();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeMainMemoryFile(content: string): Promise<string> {
  await fs.mkdir(WORKSPACE_DIR, { recursive: true });
  await fs.writeFile(MEMORY_FILE, content, "utf8");
  const stat = await fs.stat(MEMORY_FILE);
  return stat.mtime.toISOString();
}

export const handleAgents: OpenClawPluginHttpRouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const segments = url.pathname.split("/").filter(Boolean);
  // Expect: ["api", "dashboard", "agents", ...]

  if (segments[0] !== "api" || segments[1] !== "dashboard" || segments[2] !== "agents") {
    return sendJson(res, 404, { error: "not found" });
  }

  const folder = segments[3];
  const sub = segments[4];
  const method = (req.method ?? "GET").toUpperCase();

  try {
    // /api/dashboard/agents
    if (folder === undefined) {
      if (method === "GET") {
        return sendJson(res, 200, await listAgents());
      }
      // POST (folder creation) — deprecated.
      if (method === "POST") {
        return sendJson(res, 410, DEPRECATED_BODY);
      }
      return sendJson(res, 405, { error: `method ${method} not allowed` });
    }

    // /api/dashboard/agents/:folder
    if (sub === undefined) {
      if (method === "GET") {
        if (folder !== MAIN_FOLDER) {
          return sendJson(res, 404, { error: `agent "${folder}" not found` });
        }
        return sendJson(res, 200, (await listAgents())[0]);
      }
      // DELETE (folder removal) — deprecated.
      if (method === "DELETE") {
        return sendJson(res, 410, DEPRECATED_BODY);
      }
      return sendJson(res, 405, { error: `method ${method} not allowed` });
    }

    // /api/dashboard/agents/:folder/prompt — backed by workspace IDENTITY.md for main.
    if (sub === "prompt") {
      if (folder !== MAIN_FOLDER) {
        return sendJson(res, 410, DEPRECATED_BODY);
      }
      if (method === "GET") {
        return sendJson(res, 200, {
          folder: MAIN_FOLDER,
          content: await readMainIdentityFile(),
        });
      }
      if (method === "PUT") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: { content?: unknown } = {};
        if (raw.trim()) {
          try {
            body = JSON.parse(raw) as { content?: unknown };
          } catch {
            return sendJson(res, 400, { error: "body must be JSON with `content` string" });
          }
        }
        if (typeof body.content !== "string") {
          return sendJson(res, 400, { error: "content must be a string" });
        }
        await writeMainIdentityFile(body.content);
        return sendJson(res, 200, { folder: MAIN_FOLDER, saved: true });
      }
      return sendJson(res, 405, { error: `method ${method} not allowed` });
    }

    // /api/dashboard/agents/:folder/memory — backed by workspace MEMORY.md for main.
    if (sub === "memory") {
      if (folder !== MAIN_FOLDER) {
        return sendJson(res, 410, DEPRECATED_BODY);
      }
      if (method === "GET") {
        const { content, mtime } = await readMainMemoryFile();
        return sendJson(res, 200, { folder: MAIN_FOLDER, content, mtime });
      }
      if (method === "PUT") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: { content?: unknown; lastSeenMtime?: unknown } = {};
        if (raw.trim()) {
          try {
            body = JSON.parse(raw) as { content?: unknown; lastSeenMtime?: unknown };
          } catch {
            return sendJson(res, 400, {
              error: "body must be JSON with `content` string and optional `lastSeenMtime`",
            });
          }
        }
        if (typeof body.content !== "string") {
          return sendJson(res, 400, { error: "content must be a string" });
        }
        const lastSeen =
          typeof body.lastSeenMtime === "string"
            ? body.lastSeenMtime
            : body.lastSeenMtime === null
              ? null
              : undefined;

        // Conflict detection: only when client supplied a non-null mtime baseline.
        if (typeof lastSeen === "string") {
          const current = await currentMemoryMtime();
          if (current !== null && current !== lastSeen) {
            return sendJson(res, 409, { error: "Memory was modified externally" });
          }
        }

        const newMtime = await writeMainMemoryFile(body.content);
        return sendJson(res, 200, { folder: MAIN_FOLDER, saved: true, mtime: newMtime });
      }
      return sendJson(res, 405, { error: `method ${method} not allowed` });
    }

    // /api/dashboard/agents/:folder/settings — deprecated (was approvalMode store).
    if (sub === "settings") {
      return sendJson(res, 410, DEPRECATED_BODY);
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal error";
    return sendJson(res, 500, { error: message });
  }
};
