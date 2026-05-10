import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const WORKSPACE_BASE = join(
  homedir(),
  ".openclaw",
  "workspace",
  "dashboard-agents",
);

const PROMPT_FILE = "CLAUDE.md";
const SETTINGS_FILE = "settings.json";

const FOLDER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

type ApprovalMode = "ask" | "auto";

type AgentSettings = {
  approvalMode: ApprovalMode;
  name?: string;
  createdAt?: string;
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

function jid(folder: string): string {
  return `agent:main:dashboard:${folder}`;
}

function folderPath(folder: string): string {
  return join(WORKSPACE_BASE, folder);
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

async function ensureWorkspaceBase(): Promise<void> {
  await fs.mkdir(WORKSPACE_BASE, { recursive: true });
}

async function readSettings(folder: string): Promise<AgentSettings> {
  try {
    const raw = await fs.readFile(join(folderPath(folder), SETTINGS_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<AgentSettings>;
    return {
      approvalMode: parsed.approvalMode === "auto" ? "auto" : "ask",
      name: parsed.name,
      createdAt: parsed.createdAt,
    };
  } catch {
    return { approvalMode: "ask" };
  }
}

async function writeSettings(folder: string, settings: AgentSettings): Promise<void> {
  await fs.writeFile(
    join(folderPath(folder), SETTINGS_FILE),
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
}

async function folderExists(folder: string): Promise<boolean> {
  try {
    const stat = await fs.stat(folderPath(folder));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function listAgents(): Promise<AgentListItem[]> {
  await ensureWorkspaceBase();
  const entries = await fs.readdir(WORKSPACE_BASE, { withFileTypes: true });
  const items: AgentListItem[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = entry.name;
    if (!FOLDER_RE.test(folder)) continue;

    const settings = await readSettings(folder);
    items.push({
      jid: jid(folder),
      name: settings.name ?? folder,
      folder,
      // TODO(OPC-153 follow-up): wire runtime.tasks.runs.list() for live status.
      online: false,
      lastActivity: null,
      currentTask: null,
      containerName: null,
      pendingMessages: false,
      pendingTaskCount: 0,
    });
  }

  return items;
}

async function createAgent(input: {
  name?: unknown;
  folder?: unknown;
  description?: unknown;
}): Promise<
  | { ok: true; jid: string; name: string; folder: string }
  | { ok: false; status: number; error: string }
> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const folder = typeof input.folder === "string" ? input.folder.trim().toLowerCase() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";

  if (!name) {
    return { ok: false, status: 400, error: "name is required" };
  }
  if (!FOLDER_RE.test(folder)) {
    return {
      ok: false,
      status: 400,
      error: "folder must be 1–64 chars, lowercase alphanumeric / hyphen / underscore, starting with alphanumeric",
    };
  }

  await ensureWorkspaceBase();
  if (await folderExists(folder)) {
    return { ok: false, status: 409, error: `agent folder "${folder}" already exists` };
  }

  await fs.mkdir(folderPath(folder), { recursive: true });

  const promptBody =
    description ||
    `# ${name}\n\nDescribe this agent's role, responsibilities, and tone here.\n`;
  await fs.writeFile(join(folderPath(folder), PROMPT_FILE), promptBody, "utf8");

  await writeSettings(folder, {
    approvalMode: "ask",
    name,
    createdAt: new Date().toISOString(),
  });

  return { ok: true, jid: jid(folder), name, folder };
}

async function deleteAgent(
  folder: string,
): Promise<{ ok: true; folder: string } | { ok: false; status: number; error: string }> {
  if (!FOLDER_RE.test(folder)) {
    return { ok: false, status: 400, error: "invalid folder name" };
  }
  if (!(await folderExists(folder))) {
    return { ok: false, status: 404, error: `agent "${folder}" not found` };
  }
  await fs.rm(folderPath(folder), { recursive: true, force: true });
  return { ok: true, folder };
}

async function getAgentPrompt(
  folder: string,
): Promise<
  | { ok: true; folder: string; content: string }
  | { ok: false; status: number; error: string }
> {
  if (!FOLDER_RE.test(folder)) {
    return { ok: false, status: 400, error: "invalid folder name" };
  }
  if (!(await folderExists(folder))) {
    return { ok: false, status: 404, error: `agent "${folder}" not found` };
  }
  try {
    const content = await fs.readFile(join(folderPath(folder), PROMPT_FILE), "utf8");
    return { ok: true, folder, content };
  } catch {
    return { ok: false, status: 404, error: `${PROMPT_FILE} not found for "${folder}"` };
  }
}

async function updateAgentPrompt(
  folder: string,
  content: unknown,
): Promise<
  | { ok: true; folder: string; saved: true }
  | { ok: false; status: number; error: string }
> {
  if (!FOLDER_RE.test(folder)) {
    return { ok: false, status: 400, error: "invalid folder name" };
  }
  if (typeof content !== "string") {
    return { ok: false, status: 400, error: "content must be a string" };
  }
  if (!(await folderExists(folder))) {
    return { ok: false, status: 404, error: `agent "${folder}" not found` };
  }
  await fs.writeFile(join(folderPath(folder), PROMPT_FILE), content, "utf8");
  return { ok: true, folder, saved: true };
}

async function getAgentSettings(
  folder: string,
): Promise<
  | { ok: true; settings: AgentSettings }
  | { ok: false; status: number; error: string }
> {
  if (!FOLDER_RE.test(folder)) {
    return { ok: false, status: 400, error: "invalid folder name" };
  }
  if (!(await folderExists(folder))) {
    return { ok: false, status: 404, error: `agent "${folder}" not found` };
  }
  return { ok: true, settings: await readSettings(folder) };
}

async function updateAgentSettings(
  folder: string,
  approvalMode: unknown,
): Promise<
  | { ok: true; settings: AgentSettings }
  | { ok: false; status: number; error: string }
> {
  if (!FOLDER_RE.test(folder)) {
    return { ok: false, status: 400, error: "invalid folder name" };
  }
  if (approvalMode !== "ask" && approvalMode !== "auto") {
    return { ok: false, status: 400, error: 'approvalMode must be "ask" or "auto"' };
  }
  if (!(await folderExists(folder))) {
    return { ok: false, status: 404, error: `agent "${folder}" not found` };
  }
  const current = await readSettings(folder);
  const next: AgentSettings = { ...current, approvalMode };
  await writeSettings(folder, next);
  return { ok: true, settings: next };
}

export const handleAgents: OpenClawPluginHttpRouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const segments = url.pathname.split("/").filter(Boolean);
  // Expect: ["api", "dashboard", "agents", ...]

  if (
    segments[0] !== "api" ||
    segments[1] !== "dashboard" ||
    segments[2] !== "agents"
  ) {
    return sendJson(res, 404, { error: "not found" });
  }

  const folder = segments[3];
  const sub = segments[4];
  const method = (req.method ?? "GET").toUpperCase();

  try {
    // /api/dashboard/agents
    if (folder === undefined) {
      if (method === "GET") {
        const list = await listAgents();
        return sendJson(res, 200, list);
      }
      if (method === "POST") {
        const body = await readJsonBody<{
          name?: unknown;
          folder?: unknown;
          description?: unknown;
        }>(req);
        const result = await createAgent(body);
        if (!result.ok) {
          return sendJson(res, result.status, { error: result.error });
        }
        return sendJson(res, 201, {
          jid: result.jid,
          name: result.name,
          folder: result.folder,
        });
      }
      return sendJson(res, 405, { error: `method ${method} not allowed` });
    }

    // /api/dashboard/agents/:folder
    if (sub === undefined) {
      if (method === "DELETE") {
        const result = await deleteAgent(folder);
        if (!result.ok) {
          return sendJson(res, result.status, { error: result.error });
        }
        return sendJson(res, 200, { deleted: true, folder: result.folder });
      }
      return sendJson(res, 405, { error: `method ${method} not allowed` });
    }

    // /api/dashboard/agents/:folder/prompt
    if (sub === "prompt") {
      if (method === "GET") {
        const result = await getAgentPrompt(folder);
        if (!result.ok) {
          return sendJson(res, result.status, { error: result.error });
        }
        return sendJson(res, 200, { folder: result.folder, content: result.content });
      }
      if (method === "PUT") {
        const body = await readJsonBody<{ content?: unknown }>(req);
        const result = await updateAgentPrompt(folder, body.content);
        if (!result.ok) {
          return sendJson(res, result.status, { error: result.error });
        }
        return sendJson(res, 200, { folder: result.folder, saved: true });
      }
      return sendJson(res, 405, { error: `method ${method} not allowed` });
    }

    // /api/dashboard/agents/:folder/settings
    if (sub === "settings") {
      if (method === "GET") {
        const result = await getAgentSettings(folder);
        if (!result.ok) {
          return sendJson(res, result.status, { error: result.error });
        }
        return sendJson(res, 200, result.settings);
      }
      if (method === "PUT") {
        const body = await readJsonBody<{ approvalMode?: unknown }>(req);
        const result = await updateAgentSettings(folder, body.approvalMode);
        if (!result.ok) {
          return sendJson(res, result.status, { error: result.error });
        }
        return sendJson(res, 200, {
          ok: true,
          approvalMode: result.settings.approvalMode,
          agent: { folder, ...result.settings },
        });
      }
      return sendJson(res, 405, { error: `method ${method} not allowed` });
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal error";
    return sendJson(res, 500, { error: message });
  }
};
