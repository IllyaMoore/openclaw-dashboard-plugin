import type {
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

type UploadedFile = {
  id: string;
  name: string;
  size: number;
  mime: string;
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

/**
 * Drain the request body so the client connection closes cleanly even when
 * we don't actually parse the multipart. Caller can rely on this to count
 * the byte length.
 */
async function drainRequest(req: IncomingMessage): Promise<number> {
  let bytes = 0;
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length;
  }
  return bytes;
}

export function createUploadHandler(
  runtime: OpenClawPluginApi["runtime"],
  logger: OpenClawPluginApi["logger"],
): OpenClawPluginHttpRouteHandler {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);

    // /api/dashboard/upload (POST single)
    if (
      segments[0] !== "api" ||
      segments[1] !== "dashboard" ||
      segments[2] !== "upload"
    ) {
      return sendJson(res, 404, { error: "not found" });
    }

    if ((req.method ?? "GET").toUpperCase() !== "POST") {
      return sendJson(res, 405, { error: "method not allowed" });
    }

    try {
      // TODO(OPC-158-fu): parse multipart via busboy and persist files to
      //   ~/.openclaw/extensions/dashboard/uploads/<id>.<ext>
      // Today we drain the body so the client closes cleanly, log size,
      // and surface stubbed=true. The contract shape ({ files: [...] }) is
      // preserved so the frontend can build the upload widget against it.
      const size = await drainRequest(req);
      void runtime;

      const fakeId = randomUUID();
      logger.info?.(`[dashboard] upload (stub): bytes=${size} id=${fakeId}`);

      return sendJson(res, 202, {
        files: [
          {
            id: fakeId,
            name: "stub-upload.bin",
            size,
            mime: "application/octet-stream",
          },
        ] satisfies UploadedFile[],
        stubbed: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      return sendJson(res, 500, { error: message });
    }
  };
}

export function createUploadsHandler(
  runtime: OpenClawPluginApi["runtime"],
  logger: OpenClawPluginApi["logger"],
): OpenClawPluginHttpRouteHandler {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);

    // /api/dashboard/uploads/:id (GET or DELETE)
    if (
      segments[0] !== "api" ||
      segments[1] !== "dashboard" ||
      segments[2] !== "uploads"
    ) {
      return sendJson(res, 404, { error: "not found" });
    }

    const id = segments[3];
    if (!id) {
      return sendJson(res, 400, { error: "upload id is required" });
    }

    const method = (req.method ?? "GET").toUpperCase();

    try {
      // GET /api/dashboard/uploads/:id — fetch file binary
      if (method === "GET") {
        // TODO(OPC-158-fu): resolve id to a file in the plugin keyed store
        // and stream it with the right content-type + content-disposition.
        // Until real upload-write lands, every read 404s.
        void runtime;
        logger.info?.(`[dashboard] uploads.get (stub 404): id=${id}`);
        return sendJson(res, 404, { error: "file not found" });
      }

      // DELETE /api/dashboard/uploads/:id
      if (method === "DELETE") {
        // TODO(OPC-158-fu): unlink the stored file.
        logger.info?.(`[dashboard] uploads.delete (stub): id=${id}`);
        return sendJson(res, 202, { ok: true, deleted: false, stubbed: true });
      }

      return sendJson(res, 405, { error: `method ${method} not allowed` });
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      return sendJson(res, 500, { error: message });
    }
  };
}
