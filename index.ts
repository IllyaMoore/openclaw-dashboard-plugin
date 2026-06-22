import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { handleHealth } from "./src/api/health.js";
import { handleAgents } from "./src/api/agents.js";
import { handleSessions } from "./src/api/sessions.js";
import { handleModel } from "./src/api/model.js";
import { createMessagesHandler } from "./src/api/messages.js";
import { createTasksHandler } from "./src/api/tasks.js";
import { createApprovalsHandler } from "./src/api/approvals.js";
import { createToolPoliciesHandler } from "./src/api/tool-policies.js";
import { createEventsHandler } from "./src/api/events.js";
import {
  createUploadHandler,
  createUploadsHandler,
} from "./src/api/uploads.js";
import { createUiHandler } from "./src/api/ui.js";
import { handleCalendarEvents } from "./src/api/calendar.js";
import { handleSkills } from "./src/api/skills.js";
import { handleChannels } from "./src/api/channels.js";
import { handleSecrets } from "./src/api/secrets.js";

export default definePluginEntry({
  id: "dashboard",
  name: "OpenClaw Dashboard",
  description: "Command-Center dashboard repackaged as an OpenClaw plugin",
  register(api) {
    api.registerHttpRoute({
      path: "/api/dashboard/health",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: handleHealth,
    });
    api.registerHttpRoute({
      path: "/api/dashboard/agents",
      auth: "gateway",
      match: "prefix",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: handleAgents,
    });
    api.registerHttpRoute({
      path: "/api/dashboard/sessions",
      auth: "gateway",
      match: "prefix",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: handleSessions,
    });
    api.registerHttpRoute({
      path: "/api/dashboard/skills",
      auth: "gateway",
      match: "prefix",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: handleSkills,
    });
    api.registerHttpRoute({
      path: "/api/dashboard/channels",
      auth: "gateway",
      match: "prefix",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: handleChannels,
    });
    api.registerHttpRoute({
      path: "/api/dashboard/messages",
      auth: "gateway",
      match: "prefix",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createMessagesHandler(api.runtime, api.logger),
    });
    api.registerHttpRoute({
      path: "/api/dashboard/tasks",
      auth: "gateway",
      match: "prefix",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createTasksHandler(api.runtime, api.logger),
    });
    api.registerHttpRoute({
      path: "/api/dashboard/approvals",
      auth: "gateway",
      match: "prefix",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createApprovalsHandler(api.runtime, api.logger),
    });
    api.registerHttpRoute({
      path: "/api/dashboard/tool-policies",
      auth: "gateway",
      match: "prefix",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createToolPoliciesHandler(api.runtime, api.logger),
    });
    api.registerHttpRoute({
      // SSE route is auth:"plugin" because EventSource cannot send a Bearer
      // header. The handler itself validates the OPENCLAW_GATEWAY_TOKEN passed
      // as a ?token=<token> query string (mirroring the openclaw control UI's
      // hash-token approach but on the SSE-friendly side).
      path: "/api/dashboard/events",
      auth: "plugin",
      match: "exact",
      handler: createEventsHandler(api.runtime, api.logger),
    });
    api.registerHttpRoute({
      path: "/api/dashboard/model",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: handleModel,
    });
    api.registerHttpRoute({
      path: "/api/dashboard/secrets",
      auth: "gateway",
      match: "prefix",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: handleSecrets,
    });
    // The standalone /dashboard/secrets popup is retired — secrets management
    // lives inside the main dashboard's System modal now (header lock icon /
    // Cmd+. shortcut). The /api/dashboard/secrets routes above keep working.
    api.registerHttpRoute({
      path: "/api/dashboard/calendar/events",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: handleCalendarEvents,
    });
    api.registerHttpRoute({
      path: "/api/dashboard/upload",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createUploadHandler(api.runtime, api.logger),
    });
    api.registerHttpRoute({
      path: "/api/dashboard/uploads",
      auth: "gateway",
      match: "prefix",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createUploadsHandler(api.runtime, api.logger),
    });
    api.registerHttpRoute({
      // The bundled UI is plain static HTML/JS/CSS — no secrets, no live
      // data. We mark it as `auth: "plugin"` so the gateway middleware does
      // NOT 401 the initial page load (browsers can't send a Bearer header
      // for a top-level navigation). Inside the page, every fetch to
      // /api/dashboard/* still hits the gated routes above and must carry
      // its own gateway credential — the data plane stays locked down.
      path: "/dashboard",
      auth: "plugin",
      match: "prefix",
      handler: createUiHandler({ rootDir: api.rootDir, logger: api.logger }),
    });
  },
});
