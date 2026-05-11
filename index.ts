import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { handleHealth } from "./src/api/health.js";
import { handleAgents } from "./src/api/agents.js";
import { createMessagesHandler } from "./src/api/messages.js";
import { createTasksHandler } from "./src/api/tasks.js";

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
  },
});
