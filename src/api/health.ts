import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_ID = "dashboard";
const PLUGIN_VERSION = "0.1.0";

export const handleHealth: OpenClawPluginHttpRouteHandler = (_req, res) => {
  const body = JSON.stringify({
    status: "ok",
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    timestamp: new Date().toISOString(),
  });

  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body, "utf8"),
  });
  res.end(body);

  return true;
};
