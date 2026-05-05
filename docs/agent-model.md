# Agent ↔ Session-Scope Translation

> **OPC-152.** Command Center models an "agent" as `{ jid, name, folder, online, lastActivity, currentTask, containerName, pendingMessages, pendingTaskCount }` backed by NanoClaw's SQLite + filesystem. OpenClaw has no first-class "agent" concept. This doc records the translation onto OpenClaw primitives (session scope keys + workspace skill folders).

**Status:** _draft, in progress._

## Decisions

_(To be filled.)_

## Endpoint-by-endpoint mapping

_(To be filled — covers `/api/agents` GET/POST, `/api/agents/:folder` DELETE, `/api/agents/:folder/prompt` GET/PUT, `/api/agents/:folder/settings` GET/PUT.)_
