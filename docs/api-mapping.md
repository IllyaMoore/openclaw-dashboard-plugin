# API Mapping: Command Center → OpenClaw Runtime

> **OPC-151.** For every `/api/*` route in `Command-Center/src/dashboard/routes.ts`, this doc records the target call on the OpenClaw side (`api.runtime.*`, gateway RPC, or DELETE with rationale).

**Status:** _draft, in progress._

## Conventions

- **Source** column points to the Command-Center handler in `src/dashboard/api/<file>.ts`.
- **Target** column is the OpenClaw call: `runtime.<area>.<method>` for plugin-runtime calls, or `gateway:<rpc-method>` for gateway RPC, or `DELETE` to drop the surface entirely.
- **Shape diff** column flags whether the dashboard contract in `dashboard-next/src/lib/api.ts` needs an adapter glue layer or fits 1:1.

## Mapping

_(To be filled.)_

## Open questions

_(To be filled.)_
