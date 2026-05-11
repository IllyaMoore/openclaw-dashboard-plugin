import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { handleHealth } from "./src/api/health.js";
import { handleAgents } from "./src/api/agents.js";
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
      path: "/api/dashboard/events",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createEventsHandler(api.runtime, api.logger),
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
      path: "/dashboard",
      auth: "gateway",
      match: "prefix",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createUiHandler({ rootDir: api.rootDir, logger: api.logger }),
    });
  },
});
