import type {
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import type { IncomingMessage, ServerResponse } from "node:http";

const FOLDER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ACTIONS = new Set(["allow", "deny", "ask"]);

type ToolPolicy = {
  id: number;
  group_folder: string;
  tool_pattern: string;
  action: "allow" | "deny" | "ask";
  created_at: string;
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

export function createToolPoliciesHandler(
  runtime: OpenClawPluginApi["runtime"],
  logger: OpenClawPluginApi["logger"],
): OpenClawPluginHttpRouteHandler {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);

    if (
      segments[0] !== "api" ||
      segments[1] !== "dashboard" ||
      segments[2] !== "tool-policies"
    ) {
      return sendJson(res, 404, { error: "not found" });
    }

    const method = (req.method ?? "GET").toUpperCase();

    try {
      // GET /api/dashboard/tool-policies?folder=X
      if (method === "GET") {
        const folder = url.searchParams.get("folder")?.trim() ?? "";
        if (!folder) {
          return sendJson(res, 400, {
            error: "folder query parameter is required",
          });
        }
        if (!FOLDER_RE.test(folder)) {
          return sendJson(res, 400, { error: "invalid folder name" });
        }

        // TODO(OPC-156-fu): read per-agent tool policies from
        // tools.sandbox.tools.allow/deny in the OpenClaw config and project
        // them as ToolPolicy[]. For now we return an empty list so the UI can
        // render the policy editor with a known shape.
        void runtime;
        return sendJson(res, 200, [] as ToolPolicy[]);
      }

      // PUT /api/dashboard/tool-policies  body: { group_folder, tool_pattern, action }
      if (method === "PUT") {
        const body = await readJsonBody<{
          group_folder?: unknown;
          tool_pattern?: unknown;
          action?: unknown;
        }>(req);

        const folder =
          typeof body.group_folder === "string" ? body.group_folder.trim() : "";
        const pattern =
          typeof body.tool_pattern === "string" ? body.tool_pattern.trim() : "";
        const action = typeof body.action === "string" ? body.action : "";

        if (!FOLDER_RE.test(folder)) {
          return sendJson(res, 400, {
            error: "invalid or missing group_folder",
          });
        }
        if (!pattern) {
          return sendJson(res, 400, { error: "tool_pattern is required" });
        }
        if (!ACTIONS.has(action)) {
          return sendJson(res, 400, {
            error: `action must be one of: allow, deny, ask`,
          });
        }

        // TODO(OPC-156-fu): wire mutateConfigFile so the policy actually
        // lands in tools.sandbox.tools.{allow,deny}. For now we record the
        // shape and surface the stubbed flag.
        logger.info?.(
          `[dashboard] tool-policies.upsert (stub): folder=${folder} pattern=${pattern} action=${action}`,
        );
        return sendJson(res, 202, { ok: true, stubbed: true });
      }

      // DELETE /api/dashboard/tool-policies  body: { group_folder, tool_pattern }
      if (method === "DELETE") {
        const body = await readJsonBody<{
          group_folder?: unknown;
          tool_pattern?: unknown;
        }>(req);

        const folder =
          typeof body.group_folder === "string" ? body.group_folder.trim() : "";
        const pattern =
          typeof body.tool_pattern === "string" ? body.tool_pattern.trim() : "";

        if (!FOLDER_RE.test(folder)) {
          return sendJson(res, 400, {
            error: "invalid or missing group_folder",
          });
        }
        if (!pattern) {
          return sendJson(res, 400, { error: "tool_pattern is required" });
        }

        // TODO(OPC-156-fu): wire mutateConfigFile to remove the matching
        // entry from tools.sandbox.tools.{allow,deny}.
        logger.info?.(
          `[dashboard] tool-policies.delete (stub): folder=${folder} pattern=${pattern}`,
        );
        return sendJson(res, 202, { ok: true, deleted: false, stubbed: true });
      }

      return sendJson(res, 405, { error: `method ${method} not allowed` });
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      return sendJson(res, 500, { error: message });
    }
  };
}
