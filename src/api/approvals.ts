import type {
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import type { IncomingMessage, ServerResponse } from "node:http";

type PendingApproval = {
  id: string;
  groupFolder: string;
  toolName: string;
  toolInput: unknown;
  toolUseId: string;
  timestamp: string;
  receivedAt: number;
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

export function createApprovalsHandler(
  runtime: OpenClawPluginApi["runtime"],
  logger: OpenClawPluginApi["logger"],
): OpenClawPluginHttpRouteHandler {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);

    if (
      segments[0] !== "api" ||
      segments[1] !== "dashboard" ||
      segments[2] !== "approvals"
    ) {
      return sendJson(res, 404, { error: "not found" });
    }

    const method = (req.method ?? "GET").toUpperCase();
    const approvalId = segments[3];

    try {
      // GET /api/dashboard/approvals
      if (method === "GET" && !approvalId) {
        // TODO(OPC-156-fu): wire approval-handler-runtime from
        // openclaw/plugin-sdk/infra/approval-handler-runtime to list real
        // pending approvals. Today gateway-mediated approvals do not flow
        // through the plugin's runtime surface, so we return an empty list
        // to keep the dashboard happy.
        void runtime;
        return sendJson(res, 200, [] as PendingApproval[]);
      }

      // POST /api/dashboard/approvals/:id  body: { decision, alwaysAllow }
      if (method === "POST" && approvalId) {
        const body = await readJsonBody<{
          decision?: unknown;
          alwaysAllow?: unknown;
        }>(req);

        const decision = body.decision === "allow" || body.decision === "deny"
          ? body.decision
          : null;
        if (!decision) {
          return sendJson(res, 400, {
            error: "decision must be 'allow' or 'deny'",
          });
        }

        // TODO(OPC-156-fu): write approval response via gateway RPC so the
        // blocked tool call unblocks. For now we accept the request shape.
        logger.info?.(
          `[dashboard] approvals.respond (stub): id=${approvalId} decision=${decision} alwaysAllow=${Boolean(body.alwaysAllow)}`,
        );

        return sendJson(res, 202, {
          ok: true,
          approval_id: approvalId,
          decision,
          stubbed: true,
        });
      }

      return sendJson(res, 405, { error: `method ${method} not allowed` });
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      return sendJson(res, 500, { error: message });
    }
  };
}
