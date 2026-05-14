import type {
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";

const AGENT_ID = "main";
const MAIN_FOLDER = "main";
const CRON_JOBS_FILE = join(homedir(), ".openclaw", "cron", "jobs.json");
const OPENCLAW_BIN = process.env.OPENCLAW_BIN ?? "openclaw";

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

// OpenClaw cron job shape (subset we need). Real schedule.kind is "cron" | "every" | "at".
type OpenClawCronJob = {
  id: string;
  agentId?: string;
  sessionKey?: string;
  name?: string;
  enabled?: boolean;
  createdAtMs?: number;
  schedule?: {
    kind?: "cron" | "every" | "at";
    expr?: string;
    everyMs?: number;
    anchorMs?: number;
    at?: string;
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
  const sessionKey = job.sessionKey ?? "";
  // After refactor: every cron belongs to the singular OpenClaw agent (`main`).
  // Folder-personas are removed; the field is kept for UI bundle compatibility.
  const folder = MAIN_FOLDER;

  let scheduleType: "cron" | "interval" | "once" = "cron";
  let scheduleValue = "";
  const kind = job.schedule?.kind;
  if (kind === "cron") {
    scheduleType = "cron";
    scheduleValue = job.schedule?.expr ?? "";
  } else if (kind === "every") {
    scheduleType = "interval";
    scheduleValue = String(job.schedule?.everyMs ?? 0);
  } else if (kind === "at") {
    scheduleType = "once";
    scheduleValue = job.schedule?.at ?? "";
  }

  return {
    id: job.id,
    group_folder: folder,
    chat_jid: sessionKey,
    prompt: job.payload?.message ?? "",
    schedule_type: scheduleType,
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
  // After refactor: a single agent (`main`). Any folder other than `main` is
  // historical and matches nothing. Empty folder filter returns everything.
  if (folder && folder !== MAIN_FOLDER) {
    return [];
  }
  return jobs.map(mapJobToTask);
}

async function getTaskById(taskId: string): Promise<ScheduledTask | null> {
  const jobs = await readJobsFile();
  const job = jobs.find((j) => j.id === taskId);
  return job ? mapJobToTask(job) : null;
}

async function runOpenclawCron(
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(OPENCLAW_BIN, ["cron", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    proc.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr, exitCode: code ?? -1 });
    });
    proc.on("error", (err) => {
      resolve({
        ok: false,
        stdout,
        stderr: stderr + (err.message ?? "spawn error"),
        exitCode: -1,
      });
    });
  });
}

function parseJsonFromOutput<T = unknown>(stdout: string): T | null {
  const start = stdout.search(/[{[]/);
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start)) as T;
  } catch {
    return null;
  }
}

function pushScheduleArgs(args: string[], body: Record<string, unknown>): boolean {
  const kind = body.schedule_type;
  const value = body.schedule_value;
  if (kind === "cron" && typeof value === "string" && value.trim()) {
    args.push("--cron", value.trim());
    if (typeof body.schedule_tz === "string" && body.schedule_tz.trim()) {
      args.push("--tz", body.schedule_tz.trim());
    }
    return true;
  }
  if (kind === "interval" && (typeof value === "string" || typeof value === "number")) {
    args.push("--every", String(value));
    return true;
  }
  if (kind === "once" && typeof value === "string" && value.trim()) {
    args.push("--at", value.trim());
    return true;
  }
  return false;
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
        const args: string[] = ["add"];

        if (typeof body.name === "string" && body.name.trim()) {
          args.push("--name", body.name.trim());
        }
        if (typeof body.description === "string" && body.description.trim()) {
          args.push("--description", body.description.trim());
        }
        if (!pushScheduleArgs(args, body)) {
          return sendJson(res, 400, {
            error: "schedule_type and schedule_value are required (cron|interval|once)",
          });
        }
        if (body.context_mode === "group") {
          args.push("--session", "main");
        } else {
          args.push("--session", "isolated");
        }
        if (typeof body.prompt === "string" && body.prompt.trim()) {
          args.push("--message", body.prompt);
        } else {
          return sendJson(res, 400, { error: "prompt is required" });
        }
        // group_folder is intentionally ignored — folder-personas are deprecated.
        // Crons belong to the singular OpenClaw agent (`main`).
        if (typeof body.model === "string" && body.model.trim()) {
          args.push("--model", body.model.trim());
        }
        if (typeof body.timeout_seconds === "number" && body.timeout_seconds > 0) {
          args.push("--timeout-seconds", String(Math.floor(body.timeout_seconds)));
        }
        if (body.light_context !== false) args.push("--light-context");
        if (body.deliver === true) {
          args.push("--announce");
          if (typeof body.deliver_channel === "string") {
            args.push("--channel", body.deliver_channel);
          }
          if (typeof body.deliver_to === "string") {
            args.push("--to", body.deliver_to);
          }
        } else {
          args.push("--no-deliver");
        }
        args.push("--json");

        logger.info?.(`[dashboard] tasks.create: name=${String(body.name ?? "")}`);
        const r = await runOpenclawCron(args);
        if (!r.ok) {
          return sendJson(res, 502, {
            error: "cron add failed",
            stderr: r.stderr.trim(),
            exitCode: r.exitCode,
          });
        }
        const job = parseJsonFromOutput<OpenClawCronJob>(r.stdout);
        if (!job?.id) {
          return sendJson(res, 502, {
            error: "cron add returned no job",
            stdout: r.stdout.slice(0, 500),
          });
        }
        return sendJson(res, 201, mapJobToTask(job));
      }

      // POST /api/dashboard/tasks/:id/run — trigger now
      if (method === "POST" && taskId && subResource === "run") {
        logger.info?.(`[dashboard] tasks.runNow: id=${taskId}`);
        const r = await runOpenclawCron(["run", taskId, "--json"]);
        if (!r.ok) {
          return sendJson(res, 502, {
            error: "cron run failed",
            stderr: r.stderr.trim(),
            exitCode: r.exitCode,
          });
        }
        const out = parseJsonFromOutput<{ runId?: string; enqueued?: boolean }>(r.stdout);
        return sendJson(res, 202, {
          accepted: true,
          task_id: taskId,
          run_id: out?.runId ?? null,
          enqueued: out?.enqueued ?? true,
        });
      }

      // PATCH /api/dashboard/tasks/:id — partial update
      if (method === "PATCH" && taskId && !subResource) {
        const body = await readJsonBody<Record<string, unknown>>(req);
        logger.info?.(
          `[dashboard] tasks.patch: id=${taskId} keys=${Object.keys(body).join(",")}`,
        );

        // Status changes go through enable/disable sub-commands.
        if (body.status === "active" || body.status === "paused") {
          const sub = body.status === "active" ? "enable" : "disable";
          const r = await runOpenclawCron([sub, taskId, "--json"]);
          if (!r.ok) {
            return sendJson(res, 502, {
              error: `cron ${sub} failed`,
              stderr: r.stderr.trim(),
              exitCode: r.exitCode,
            });
          }
        }

        // Field edits via `cron edit`. Skip if only status changed.
        const fieldKeys = Object.keys(body).filter((k) => k !== "status");
        if (fieldKeys.length > 0) {
          const args: string[] = ["edit", taskId];
          if (typeof body.name === "string" && body.name.trim()) {
            args.push("--name", body.name.trim());
          }
          if (typeof body.description === "string") {
            args.push("--description", body.description);
          }
          if (body.schedule_type !== undefined) {
            pushScheduleArgs(args, body);
          }
          if (typeof body.prompt === "string" && body.prompt.trim()) {
            args.push("--message", body.prompt);
          }
          if (body.context_mode === "group") {
            args.push("--session", "main");
          } else if (body.context_mode === "isolated") {
            args.push("--session", "isolated");
          }
          if (typeof body.model === "string" && body.model.trim()) {
            args.push("--model", body.model.trim());
          }
          if (typeof body.timeout_seconds === "number" && body.timeout_seconds > 0) {
            args.push("--timeout-seconds", String(Math.floor(body.timeout_seconds)));
          }
          args.push("--json");

          // edit subcommand only when there are actual flags beyond [edit, id, --json]
          if (args.length > 3) {
            const r = await runOpenclawCron(args);
            if (!r.ok) {
              return sendJson(res, 502, {
                error: "cron edit failed",
                stderr: r.stderr.trim(),
                exitCode: r.exitCode,
              });
            }
          }
        }

        const updated = await getTaskById(taskId);
        if (!updated) return sendJson(res, 404, { error: `task ${taskId} not found after patch` });
        return sendJson(res, 200, updated);
      }

      // DELETE /api/dashboard/tasks/:id
      if (method === "DELETE" && taskId && !subResource) {
        logger.info?.(`[dashboard] tasks.delete: id=${taskId}`);
        const r = await runOpenclawCron(["rm", taskId, "--json"]);
        if (!r.ok) {
          return sendJson(res, 502, {
            error: "cron rm failed",
            stderr: r.stderr.trim(),
            exitCode: r.exitCode,
          });
        }
        return sendJson(res, 200, { ok: true, id: taskId });
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
