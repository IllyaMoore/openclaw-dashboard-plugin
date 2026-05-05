# OpenClaw Dashboard Plugin

OpenClaw extension that ports the [Command Center](https://github.com/IllyaMoore/Command-Center) Next.js dashboard to run as a first-class plugin against an OpenClaw gateway.

## Status

**Pre-alpha.** Discovery and design phase. No code yet.

Tracked in Linear: [OpenClaw Plugin: Command Center Dashboard](https://linear.app/storypages/project/openclaw-plugin-command-center-dashboard-e2e1caac830a).

## Goal

Replace the standalone NanoClaw HTTP server (`Command-Center/src/dashboard/server.ts`) with an OpenClaw plugin that registers `/api/*` and `/dashboard/*` routes on the existing gateway via `api.registerHttpRoute(...)`. The plugin holds no private database — sessions, cron, approvals, tool policies, and events all flow through `api.runtime.*` and gateway RPC.

## Layout (target)

```
openclaw-dashboard-plugin/
├── docs/
│   ├── api-mapping.md       # OPC-151: Command-Center /api/* → OpenClaw runtime
│   └── agent-model.md       # OPC-152: agent ↔ session-scope translation
├── package.json             # openclaw.extensions: ["./index.ts"]
├── openclaw.plugin.json     # plugin manifest
├── index.ts                 # plugin entry: registerHttpRoute + runtime init
├── src/
│   ├── api/                 # ported Command-Center handlers, via api.runtime.*
│   │   ├── agents.ts        # session scopes + workspace skill folders
│   │   ├── messages.ts      # transcript read + systemEvent inject
│   │   ├── tasks.ts         # runtime.tasks.flows
│   │   ├── approvals.ts     # gateway approvals RPC
│   │   ├── policies.ts      # tools.sandbox.tools.{allow,deny} mutate
│   │   ├── events.ts        # SSE from runtime.events.onAgentEvent
│   │   ├── upload.ts        # runtime.state.openKeyedStore
│   │   └── settings.ts      # timezone via mutateConfigFile
│   └── http/
│       ├── router.ts        # path matching + parseBody
│       └── static.ts        # serve bundled dashboard-next/out
└── ui/                      # copy of Command-Center/dashboard-next, builds to ui/out
```

## Phases

1. **Discovery & design** ([OPC-148](https://linear.app/storypages/issue/OPC-148)) — produce `docs/api-mapping.md` and `docs/agent-model.md`.
2. **Implementation** ([OPC-149](https://linear.app/storypages/issue/OPC-149)) — scaffold the plugin package, port each handler family.
3. **Build & deploy** ([OPC-150](https://linear.app/storypages/issue/OPC-150)) — wire `next build` + `tsdown`, install on production EC2 via Terraform.

## References

- Command Center source: `E:\code\Command-Center-personal`
- OpenClaw monorepo: `E:\code\openclaw-src`
- Plugin SDK: `openclaw-src/packages/plugin-sdk`
- Reference plugin (HTTP route registration): `openclaw-src/extensions/webhooks`
- Plugin docs: `openclaw-src/docs/plugins/building-plugins.md`

## License

MIT
