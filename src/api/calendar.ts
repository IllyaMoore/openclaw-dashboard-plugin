import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";

/**
 * /api/dashboard/calendar/events stub.
 *
 * The dashboard's `useCalendar` hook polls this path every 5 minutes. There
 * is no calendar surface in the OpenClaw runtime to project from yet, so the
 * stub returns `{ events: [] }` and 200 — the UI renders an empty calendar
 * panel without spamming console errors.
 *
 * TODO(OPC-159-fu-calendar): if a real Google Calendar / Outlook source
 * gets wired through the OpenClaw gateway, project events here.
 */
export const handleCalendarEvents: OpenClawPluginHttpRouteHandler = (_req, res) => {
  const body = JSON.stringify({ events: [] });
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body, "utf8"),
    "cache-control": "no-cache",
  });
  res.end(body);
  return true;
};
