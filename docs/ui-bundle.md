# UI bundle — reproducibility notes

The `plugin/ui/` folder ships a static export of the Command-Center
`dashboard-next/` Next.js app. The bundle is checked in so the npm
tarball is self-contained: `openclaw plugins install @openclaw/dashboard`
needs no Next build on the host.

This document records the exact source changes applied on top of the
upstream `dashboard-next/` to produce the bundle. Re-run the steps below
verbatim to regenerate the same `out/` directory and replace `plugin/ui/`.

## Upstream snapshot

The frontend lives in a sibling folder of this plugin, not in git:

```
openclaw-dashboard-plugin/
├── nanoclaw-dashboard/dashboard-next/   ← Command-Center fork, no git
└── plugin/                              ← THIS repo
```

`nanoclaw-dashboard/dashboard-next/` is a working copy of
`Command-Center-personal/dashboard-next` at the time of bundling.

## Edits applied before `npm run build`

### 1. `next.config.ts` — mount under `/dashboard`

```diff
 const nextConfig: NextConfig = {
   output: "export",
   distDir: "out",
+  basePath: "/dashboard",
+  assetPrefix: "/dashboard",
   images: { unoptimized: true },
   trailingSlash: true,
 };
```

`basePath` rewrites client-side router URLs; `assetPrefix` rewrites
`<link>` / `<script>` build-time hrefs. Without these, the generated
HTML references `/_next/static/...` and breaks when served at
`/dashboard/`.

### 2. `src/lib/api.ts` — point at the plugin's namespace

```diff
-const BASE = "";
+const BASE = "/api/dashboard";
```

Plus two query-param renames to match the plugin's contract
(`group=` → `folder=`):

- `fetchMessages`: `…/api/messages?group=…` → `…/api/messages?folder=…`
- `fetchTasks`: `…/api/tasks?group=…` → `…/api/tasks?folder=…`

### 3. Direct fetches outside `api.ts`

Seven files reach for `/api/*` without going through the `BASE`
constant. Each was rewritten to `/api/dashboard/*`:

| File | Old path → New path |
|---|---|
| `src/lib/use-calendar.ts` | `/api/calendar/events` → `/api/dashboard/calendar/events` |
| `src/lib/use-approvals.ts` (×2) | `/api/approvals*` → `/api/dashboard/approvals*` |
| `src/lib/use-messages.ts` | `EventSource("/api/events")` → `EventSource("/api/dashboard/events")` |
| `src/lib/use-agents.tsx` | `EventSource("/api/events")` → `EventSource("/api/dashboard/events")` |
| `src/lib/use-activity.ts` | `EventSource("/api/activity/stream")` → `EventSource("/api/dashboard/events")` (also accept `type: "activity"` / `"init"` envelopes from the unified stream) |
| `src/components/layout/chat-panel.tsx` | `DELETE /api/messages?group=…` → `DELETE /api/dashboard/messages?folder=…` |
| `src/components/layout/settings-sidebar.tsx` (×2) | `/api/agents/:folder/settings` → `/api/dashboard/agents/:folder/settings` |

### 4. `src/lib/use-integrations.ts` — drop Google OAuth providers

The `PROVIDERS` array of `gmail` / `google-calendar` / `google-drive` /
`google-sheets` entries is emptied. The OpenClaw gateway owns the
integration surface (gog CLI inside the agent sandbox), so the dashboard
does not need its own `/api/auth/google-*` flows.

```diff
-const PROVIDERS = [
-  { name: "google-calendar", … },
-  { name: "gmail", … },
-  { name: "google-drive", … },
-  { name: "google-sheets", … },
-] as const;
+const PROVIDERS: ReadonlyArray<{ name; displayName; authPath; postMessageId; featured }> = [];
```

## Rebuild procedure

From `openclaw-dashboard-plugin/`:

```sh
cd nanoclaw-dashboard/dashboard-next
npm install                       # ~2-3 min for Next 16 / React 19
rm -rf out
npm run build                     # ~10 s

cd ../../plugin
rm -rf ui/*
cp -r ../nanoclaw-dashboard/dashboard-next/out/. ui/

npm run pack:tarball              # clean + tsc + npm pack
ls -la openclaw-dashboard-0.1.0.tgz
```

The resulting tarball is ~910 KB / ~100 files.

## Verifying the bundle

After `openclaw plugins install …tgz` and a gateway restart, the
following must all succeed:

```sh
# HTML index served, basePath wired
curl -I /dashboard/                     # 200 text/html, ~18 KB
curl   /dashboard/ | head -c 500        # references /dashboard/_next/static/...

# Chunks resolve
curl -I /dashboard/_next/static/chunks/*.js   # 200 application/javascript

# Plugin API surface still answers (verified earlier in vertical slice)
curl   /api/dashboard/health
curl   /api/dashboard/agents
```

## Open follow-ups

- `/api/dashboard/calendar/events` and `/api/dashboard/activity/stream`
  are not implemented in the plugin yet. Calendar widget and activity
  feed render their empty / error state gracefully.
- Real `online` / `currentTask` fields, real `systemEvent.enqueue`,
  real cron-CRUD, real approvals via gateway RPC — all tracked as
  `TODO(OPC-…-fu)` in the handler sources.
