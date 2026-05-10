import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { handleHealth } from "./src/api/health.js";
import { handleAgents } from "./src/api/agents.js";

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
  },
});
