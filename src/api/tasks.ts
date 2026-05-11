import type {
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const AGENT_ID = "main";
const SCOPE_PREFIX = `agent:${AGENT_ID}:dashboard:`;
const CRON_JOBS_FILE = join(homedir(), ".openclaw", "cron", "jobs.json");

const FOLDER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Command-Center compatible shape
type ScheduledTask = {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: "cron" | "interval" | "once";
  schedule_value: string;
  context_mode: "group" | "isolated";
  model: string | null;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: "active" | "paused" | "completed";
  created_at: string;
};

type TaskRunLog = {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: "success" | "error";
  result: string | null;
  error: string | null;
};

// OpenClaw cron job shape (subset we need)
type OpenClawCronJob = {
  id: string;
  agentId?: string;
  sessionKey?: string;
  name?: string;
  enabled?: boolean;
  createdAtMs?: number;
  schedule?: {
    kind?: "cron" | "interval" | "once";
    expr?: string;
    intervalMs?: number;
    when?: string;
    tz?: string;
  };
  sessionTarget?: "isolated" | "main";
  payload?: {
    kind?: string;
    message?: string;
    model?: string;
    [k: string]: unknown;
  };
  state?: {
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    lastResult?: string;
  };
};

function folderFromScopeKey(scopeKey: string): string | null {
  if (!scopeKey.startsWith(SCOPE_PREFIX)) return null;
  return scopeKey.slice(SCOPE_PREFIX.length);
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
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

function msToIso(ms: number | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function mapJobToTask(job: OpenClawCronJob): ScheduledTask {
  const folder = folderFromScopeKey(job.sessionKey ?? "") ?? "";
  const scheduleKind = job.schedule?.kind ?? "cron";
  const scheduleValue =
    scheduleKind === "cron"
      ? (job.schedule?.expr ?? "")
      : scheduleKind === "interval"
        ? String(job.schedule?.intervalMs ?? 0)
        : (job.schedule?.when ?? "");

  return {
    id: job.id,
    group_folder: folder,
    chat_jid: job.sessionKey ?? "",
    prompt: job.payload?.message ?? "",
    schedule_type: scheduleKind,
    schedule_value: scheduleValue,
    context_mode: job.sessionTarget === "main" ? "group" : "isolated",
    model: job.payload?.model ?? null,
    next_run: msToIso(job.state?.nextRunAtMs),
    last_run: msToIso(job.state?.lastRunAtMs),
    last_result: job.state?.lastResult ?? null,
    status: job.enabled === false ? "paused" : "active",
    created_at: msToIso(job.createdAtMs) ?? new Date(0).toISOString(),
  };
}

async function readJobsFile(): Promise<OpenClawCronJob[]> {
  try {
    const raw = await fs.readFile(CRON_JOBS_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (Array.isArray(parsed)) {
      return parsed as OpenClawCronJob[];
    }
    if (parsed && typeof parsed === "object") {
      const maybeJobs = (parsed as { jobs?: unknown }).jobs;
      if (Array.isArray(maybeJobs)) {
        return maybeJobs as OpenClawCronJob[];
      }
      // Map keyed by id
      return Object.values(parsed as Record<string, OpenClawCronJob>);
    }
    return [];
  } catch {
    return [];
  }
}

async function listTasks(folder: string | null): Promise<ScheduledTask[]> {
  const jobs = await readJobsFile();
  return jobs
    .filter((j) => {
      const key = j.sessionKey ?? "";
      if (!key.startsWith(SCOPE_PREFIX)) return false;
      if (!folder) return true;
      return folderFromScopeKey(key) === folder;
    })
    .map(mapJobToTask);
}

async function getTaskById(taskId: string): Promise<ScheduledTask | null> {
  const jobs = await readJobsFile();
  const job = jobs.find((j) => j.id === taskId && (j.sessionKey ?? "").startsWith(SCOPE_PREFIX));
  return job ? mapJobToTask(job) : null;
}

// Read recent runs for a task via runtime.tasks.runs.bindSession(scope).list()
function recentRunsFor(
  runtime: OpenClawPluginApi["runtime"],
  scopeKey: string,
  taskId: string,
  limit: number,
): TaskRunLog[] {
  try {
    const bound = runtime.tasks.runs.bindSession({ sessionKey: scopeKey });
    const all = bound.list();
    return all
      .filter((r) => r.id === taskId || r.flowId === taskId)
      .slice(0, limit)
      .map((r) => {
        const startedAt = typeof r.startedAt === "number" ? r.startedAt : undefined;
        const endedAt = typeof r.endedAt === "number" ? r.endedAt : undefined;
        return {
          task_id: taskId,
          run_at: startedAt
            ? new Date(startedAt).toISOString()
            : new Date(r.createdAt).toISOString(),
          duration_ms:
            startedAt != null && endedAt != null ? Math.max(0, endedAt - startedAt) : 0,
          status:
            r.status === "succeeded"
              ? ("success" as const)
              : r.status === "failed"
                ? ("error" as const)
                : ("success" as const),
          result: typeof r.terminalSummary === "string" ? r.terminalSummary : null,
          error: typeof r.error === "string" ? r.error : null,
        };
      });
  } catch {
    return [];
  }
}

export function createTasksHandler(
  runtime: OpenClawPluginApi["runtime"],
  logger: OpenClawPluginApi["logger"],
): OpenClawPluginHttpRouteHandler {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);

    if (segments[0] !== "api" || segments[1] !== "dashboard" || segments[2] !== "tasks") {
      return sendJson(res, 404, { error: "not found" });
    }

    const method = (req.method ?? "GET").toUpperCase();
    const taskId = segments[3];
    const subResource = segments[4];

    try {
      // GET /api/dashboard/tasks?folder=X&runs=N
      if (method === "GET" && !taskId) {
        const folder = url.searchParams.get("folder")?.trim() ?? null;
        if (folder && !FOLDER_RE.test(folder)) {
          return sendJson(res, 400, { error: "invalid folder name" });
        }
        const runs = clampInt(url.searchParams.get("runs"), 5, 0, 50);

        const tasks = await listTasks(folder);
        const withRuns = tasks.map((t) => ({
          ...t,
          recent_runs:
            runs > 0
              ? recentRunsFor(runtime, t.chat_jid, t.id, runs)
              : ([] as TaskRunLog[]),
        }));
        return sendJson(res, 200, withRuns);
      }

      // GET /api/dashboard/tasks/:id
      if (method === "GET" && taskId && !subResource) {
        const task = await getTaskById(taskId);
        if (!task) return sendJson(res, 404, { error: `task ${taskId} not found` });
        return sendJson(res, 200, task);
      }

      // POST /api/dashboard/tasks — create
      if (method === "POST" && !taskId) {
        const body = await readJsonBody<Record<string, unknown>>(req);
        // TODO(OPC-155-fu): wire actual cron-job creation. Today the cron
        // CRUD path lives behind a gateway RPC / CLI surface that this plugin
        // does not yet talk to; we accept the request and return a stub so
        // the dashboard can build against the contract.
        logger.info?.(
          `[dashboard] tasks.create (stub): folder=${String(body.group_folder ?? "")}`,
        );
        return sendJson(res, 202, { accepted: true, stubbed: true });
      }

      // POST /api/dashboard/tasks/:id/run — trigger now
      if (method === "POST" && taskId && subResource === "run") {
        // TODO(OPC-155-fu): real run-now requires a cron-runner RPC.
        logger.info?.(`[dashboard] tasks.runNow (stub): id=${taskId}`);
        return sendJson(res, 202, { accepted: true, task_id: taskId, stubbed: true });
      }

      // PATCH /api/dashboard/tasks/:id — partial update
      if (method === "PATCH" && taskId && !subResource) {
        const body = await readJsonBody<Record<string, unknown>>(req);
        // TODO(OPC-155-fu): wire cron-job patch via gateway/cron RPC.
        logger.info?.(`[dashboard] tasks.patch (stub): id=${taskId} keys=${Object.keys(body)}`);
        return sendJson(res, 202, { accepted: true, task_id: taskId, stubbed: true });
      }

      // DELETE /api/dashboard/tasks/:id
      if (method === "DELETE" && taskId && !subResource) {
        // TODO(OPC-155-fu): wire cron-job delete via gateway/cron RPC.
        logger.info?.(`[dashboard] tasks.delete (stub): id=${taskId}`);
        return sendJson(res, 202, { accepted: true, task_id: taskId, stubbed: true });
      }

      return sendJson(res, 405, { error: `method ${method} not allowed` });
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      return sendJson(res, 500, { error: message });
    }
  };
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
