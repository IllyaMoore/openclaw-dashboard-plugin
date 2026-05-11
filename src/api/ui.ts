import type {
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { promises as fs } from "node:fs";
import { join, normalize, resolve, extname } from "node:path";
import type { ServerResponse } from "node:http";

const ROUTE_PREFIX = "/dashboard";
const FALLBACK_FILE = "index.html";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function mimeFor(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function sendJsonError(res: ServerResponse, status: number, error: string): boolean {
  const body = JSON.stringify({ error });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body, "utf8"),
  });
  res.end(body);
  return true;
}

async function tryServe(
  res: ServerResponse,
  uiRoot: string,
  relPath: string,
): Promise<boolean> {
  const normalised = normalize(relPath).replace(/^[/\\]+/, "");
  // Defence against path traversal: ensure the resolved absolute path is still
  // inside uiRoot.
  const absolute = resolve(uiRoot, normalised);
  if (!absolute.startsWith(resolve(uiRoot))) {
    return sendJsonError(res, 403, "forbidden");
  }

  try {
    const stat = await fs.stat(absolute);
    if (stat.isDirectory()) {
      return tryServe(res, uiRoot, join(normalised, "index.html"));
    }
    const data = await fs.readFile(absolute);
    res.writeHead(200, {
      "content-type": mimeFor(absolute),
      "content-length": data.byteLength,
      "cache-control":
        absolute.endsWith(".html") || absolute.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=3600",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

export function createUiHandler(
  api: Pick<OpenClawPluginApi, "rootDir" | "logger">,
): OpenClawPluginHttpRouteHandler {
  // Plugin install layout (post-npm-pack):
  //   <rootDir>/dist/...
  //   <rootDir>/ui/<built static export>
  //   <rootDir>/openclaw.plugin.json
  //   <rootDir>/package.json
  //
  // If rootDir is not provided (rare — local dev), fall back to a path
  // relative to this module via import.meta.url. Production-installed plugins
  // always have rootDir set.
  const uiRootFromApi = api.rootDir ? join(api.rootDir, "ui") : undefined;
  const uiRoot = uiRootFromApi ?? "";

  return async (req, res) => {
    if (!uiRoot) {
      return sendJsonError(res, 500, "dashboard UI bundle path is not configured");
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    let relPath = url.pathname;

    // Strip the /dashboard prefix from the request URL so the rest maps onto
    // the static bundle on disk: /dashboard/foo.css -> /foo.css
    if (relPath.startsWith(ROUTE_PREFIX)) {
      relPath = relPath.slice(ROUTE_PREFIX.length);
    }
    if (relPath === "" || relPath === "/") {
      relPath = `/${FALLBACK_FILE}`;
    }

    // First try the exact path.
    if (await tryServe(res, uiRoot, relPath)) return true;

    // SPA fallback: for any client-side route we cannot find on disk, return
    // the bundle's index.html so the SPA router takes over.
    if (await tryServe(res, uiRoot, `/${FALLBACK_FILE}`)) return true;

    api.logger?.info?.(`[dashboard] ui: 404 for ${url.pathname}`);
    return sendJsonError(res, 404, "not found");
  };
}
