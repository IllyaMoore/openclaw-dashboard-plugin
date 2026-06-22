import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getSecretsStore, type SecretType } from "../secrets/store.js";

/**
 * HTTP routes for managing dashboard-tracked secrets.
 *
 * Surface:
 *   GET    /api/dashboard/secrets            → list (values masked)
 *   GET    /api/dashboard/secrets/:name      → reveal full value
 *   PUT    /api/dashboard/secrets/:name      → create/update value+meta
 *   DELETE /api/dashboard/secrets/:name      → remove
 *   POST   /api/dashboard/secrets/_restart   → return instruction to restart
 *
 * All routes require gateway auth + trusted-operator scope. Every operator
 * is admin per the M6 design decision.
 *
 * Secret VALUES never appear in response bodies for the list endpoint
 * (only masked) and never appear in the audit log.
 */

const ALLOWED_TYPES = new Set<SecretType>([
  "anthropic_routine_bearer",
  "github_pat_fine_grained",
  "github_pat_classic",
  "api_key",
  "generic",
]);

function sendJson(res: ServerResponse, status: number, body: unknown): true {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload, "utf8"),
    "cache-control": "no-store",
  });
  res.end(payload);
  return true;
}

async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

/**
 * Parse `/api/dashboard/secrets[/<name|_restart>]`. Returns the trailing
 * segment if any, or null for the bare list/index path.
 */
function parseTail(rawUrl: string | undefined): string | null | { error: string } {
  const url = rawUrl ?? "/";
  const pathOnly = url.split("?", 1)[0] ?? "/";
  const segs = pathOnly.split("/").filter(Boolean);
  // Expected: ["api", "dashboard", "secrets", ...]
  if (segs.length === 3) return null;
  if (segs.length === 4) {
    const tail = segs[3] ?? "";
    if (tail.startsWith("_")) return tail; // internal action like _restart
    if (!/^[A-Z][A-Z0-9_]*$/.test(tail)) {
      return { error: `invalid secret name "${tail}"` };
    }
    return tail;
  }
  return { error: "unexpected path" };
}

function actorFromRequest(req: IncomingMessage): string | undefined {
  // The gateway sets an x-openclaw-operator header on authed routes that
  // identifies who's calling. If absent, we just leave actor undefined —
  // the audit line still records the action.
  const raw = req.headers["x-openclaw-operator"];
  if (typeof raw === "string" && raw) return raw;
  return undefined;
}

export const handleSecrets: OpenClawPluginHttpRouteHandler = async (req, res) => {
  const method = (req.method ?? "GET").toUpperCase();
  const tail = parseTail(req.url);
  if (typeof tail === "object" && tail !== null) {
    return sendJson(res, 400, { ok: false, message: tail.error });
  }
  const store = getSecretsStore();
  const actor = actorFromRequest(req);

  // Internal action: restart instruction.
  if (tail === "_restart-gateway") {
    if (method !== "POST") {
      return sendJson(res, 405, { ok: false, message: "use POST" });
    }
    await store.audit({ action: "restart-gateway", actor, ok: true });
    return sendJson(res, 200, {
      ok: true,
      message:
        "Gateway must be restarted to pick up updated env vars. Run on the instance: " +
        "`sudo -u ubuntu XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart openclaw-gateway`",
    });
  }
  if (typeof tail === "string" && tail.startsWith("_")) {
    return sendJson(res, 404, { ok: false, message: `unknown action ${tail}` });
  }

  // Collection endpoint.
  if (tail === null) {
    if (method !== "GET") {
      return sendJson(res, 405, { ok: false, message: "use GET" });
    }
    try {
      const items = await store.list();
      await store.audit({ action: "list", actor, ok: true });
      return sendJson(res, 200, { ok: true, secrets: items });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await store.audit({ action: "list", actor, ok: false, reason: message });
      return sendJson(res, 500, { ok: false, message });
    }
  }

  // Per-secret endpoint.
  const name = tail;
  if (method === "GET") {
    try {
      const revealed = await store.reveal(name);
      if (!revealed) {
        await store.audit({
          action: "reveal",
          actor,
          name,
          ok: false,
          reason: "not found",
        });
        return sendJson(res, 404, { ok: false, message: `unknown secret ${name}` });
      }
      await store.audit({ action: "reveal", actor, name, ok: true });
      return sendJson(res, 200, {
        ok: true,
        name: revealed.name,
        value: revealed.value,
        meta: revealed.meta,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await store.audit({
        action: "reveal",
        actor,
        name,
        ok: false,
        reason: message,
      });
      return sendJson(res, 500, { ok: false, message });
    }
  }

  if (method === "PUT") {
    let body: Record<string, unknown>;
    try {
      body = (await readJsonBody<Record<string, unknown>>(req)) ?? {};
    } catch (err) {
      return sendJson(res, 400, {
        ok: false,
        message: `invalid json body: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const label = typeof body["label"] === "string" ? body["label"] : "";
    const typeRaw = typeof body["type"] === "string" ? body["type"] : "";
    const format = typeof body["format"] === "string" ? body["format"] : "";
    const how_to_get =
      typeof body["how_to_get"] === "string" ? body["how_to_get"] : "";
    if (!label || !typeRaw || !format || !how_to_get) {
      return sendJson(res, 400, {
        ok: false,
        message: "missing required fields: label, type, format, how_to_get",
      });
    }
    if (!ALLOWED_TYPES.has(typeRaw as SecretType)) {
      return sendJson(res, 400, {
        ok: false,
        message: `unknown type "${typeRaw}"; allowed: ${Array.from(ALLOWED_TYPES).join(", ")}`,
      });
    }
    const value = typeof body["value"] === "string" ? body["value"] : undefined;
    const scope = typeof body["scope"] === "string" ? body["scope"] : undefined;
    const notes = typeof body["notes"] === "string" ? body["notes"] : undefined;
    try {
      const entry = await store.set(name, {
        ...(value !== undefined ? { value } : {}),
        label,
        type: typeRaw as SecretType,
        format,
        how_to_get,
        ...(scope !== undefined ? { scope } : {}),
        ...(notes !== undefined ? { notes } : {}),
      });
      await store.audit({ action: "set", actor, name, ok: true });
      return sendJson(res, 200, { ok: true, secret: entry });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await store.audit({
        action: "set",
        actor,
        name,
        ok: false,
        reason: message,
      });
      return sendJson(res, 400, { ok: false, message });
    }
  }

  if (method === "DELETE") {
    try {
      const removed = await store.delete(name);
      await store.audit({
        action: "delete",
        actor,
        name,
        ok: removed,
        ...(removed ? {} : { reason: "not found" }),
      });
      if (!removed) {
        return sendJson(res, 404, { ok: false, message: `unknown secret ${name}` });
      }
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await store.audit({
        action: "delete",
        actor,
        name,
        ok: false,
        reason: message,
      });
      return sendJson(res, 500, { ok: false, message });
    }
  }

  return sendJson(res, 405, {
    ok: false,
    message: `method ${method} not allowed; use GET/PUT/DELETE`,
  });
};
