import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Standalone secrets-management UI.
 *
 * Single-file HTML page mounted at `/dashboard/secrets`. Inline CSS + JS,
 * no external deps, no build step. The page calls the gated
 * `/api/dashboard/secrets/...` routes with a Bearer token taken from the
 * URL hash (`#token=...`), mirroring the existing pattern used by the
 * main dashboard for token delivery into the browser.
 *
 * This is operator-tool quality — not customer-facing. The goal is
 * "manage secrets without SSH-ing the box," not pretty UX.
 */

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenClaw Secrets</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0e0f12;
    --panel: #16181d;
    --panel-2: #1e2128;
    --line: #2a2d36;
    --fg: #e6e8ee;
    --muted: #8a8f9c;
    --accent: #5ea7ff;
    --warn: #ffb14d;
    --danger: #ff6b6b;
    --ok: #5dd39e;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  header {
    padding: 20px 24px;
    border-bottom: 1px solid var(--line);
    display: flex;
    align-items: center;
    gap: 16px;
  }
  h1 { margin: 0; font-size: 18px; font-weight: 600; }
  .status-pill {
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--panel-2);
    color: var(--muted);
  }
  .status-pill.warn { background: rgba(255,177,77,0.15); color: var(--warn); }
  .status-pill.ok { background: rgba(93,211,158,0.15); color: var(--ok); }
  .toolbar { padding: 16px 24px; display: flex; gap: 8px; align-items: center; }
  main { padding: 0 24px 24px; max-width: 980px; margin: 0 auto; }
  button {
    background: var(--panel-2);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 6px 12px;
    font: inherit;
    cursor: pointer;
  }
  button:hover { background: var(--panel); border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #0a0c10; font-weight: 600; }
  button.primary:hover { filter: brightness(1.1); }
  button.danger { color: var(--danger); border-color: var(--danger); }
  button.danger:hover { background: rgba(255,107,107,0.1); }
  .card {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .card h3 { margin: 0 0 4px; font-size: 15px; }
  .card .name { font-family: ui-monospace, monospace; color: var(--muted); font-size: 12px; }
  .type-pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--panel-2); color: var(--muted); white-space: nowrap; }
  .value-row {
    display: flex; align-items: center; gap: 8px;
    margin-top: 10px;
    font-family: ui-monospace, monospace;
    font-size: 13px;
    background: var(--bg);
    padding: 6px 10px;
    border-radius: 4px;
    border: 1px solid var(--line);
  }
  .value-row .v { flex: 1; overflow-x: auto; }
  .value-row .v.empty { color: var(--muted); font-style: italic; }
  .meta-grid { margin-top: 12px; font-size: 12px; color: var(--muted); }
  .meta-grid div { margin: 4px 0; }
  .meta-grid strong { color: var(--fg); font-weight: 500; }
  .card-actions { display: flex; gap: 6px; margin-top: 12px; }
  .empty-state { padding: 40px; text-align: center; color: var(--muted); }
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: none; align-items: center; justify-content: center;
    z-index: 100;
  }
  .modal-backdrop.show { display: flex; }
  .modal {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    width: 520px;
    max-width: 92vw;
    max-height: 92vh;
    overflow-y: auto;
    padding: 20px;
  }
  .modal h2 { margin: 0 0 16px; font-size: 16px; }
  .field { margin-bottom: 12px; }
  .field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  .field input, .field select, .field textarea {
    width: 100%; padding: 8px; background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 4px; font: inherit;
    font-family: ui-monospace, monospace;
  }
  .field textarea { resize: vertical; min-height: 60px; }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  .restart-banner {
    background: rgba(255,177,77,0.1);
    border: 1px solid var(--warn);
    border-radius: 8px;
    padding: 12px 16px;
    margin: 0 24px 16px;
    display: none;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .restart-banner.show { display: flex; }
  .err {
    color: var(--danger);
    font-size: 12px;
    margin-top: 6px;
  }
  .toast {
    position: fixed; bottom: 24px; right: 24px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 12px 16px;
    z-index: 200;
    display: none;
  }
  .toast.show { display: block; }
  .toast.error { border-color: var(--danger); }
  .toast.success { border-color: var(--ok); }
</style>
</head>
<body>
<header>
  <h1>OpenClaw Secrets</h1>
  <span id="status-pill" class="status-pill">loading…</span>
</header>
<div id="restart-banner" class="restart-banner">
  <span>Gateway restart required so plugins pick up updated values.</span>
  <button class="primary" id="restart-btn">Restart now</button>
</div>
<div class="toolbar">
  <button class="primary" id="add-btn">+ Add secret</button>
  <button id="refresh-btn">Refresh</button>
</div>
<main id="list"><div class="empty-state">Loading…</div></main>

<div class="modal-backdrop" id="modal-backdrop">
  <div class="modal">
    <h2 id="modal-title">Add secret</h2>
    <div class="field">
      <label>Name (env var)</label>
      <input id="f-name" placeholder="DISPATCH_TOKEN_FOO" autocomplete="off" spellcheck="false">
      <div class="err" id="err-name"></div>
    </div>
    <div class="field">
      <label>Label (human-readable)</label>
      <input id="f-label" placeholder="Dispatch foo routine bearer">
    </div>
    <div class="field">
      <label>Type</label>
      <select id="f-type">
        <option value="anthropic_routine_bearer">anthropic_routine_bearer</option>
        <option value="github_pat_fine_grained">github_pat_fine_grained</option>
        <option value="github_pat_classic">github_pat_classic</option>
        <option value="api_key">api_key</option>
        <option value="generic">generic</option>
      </select>
    </div>
    <div class="field">
      <label>Format hint (what the value looks like)</label>
      <input id="f-format" placeholder="sk-ant-oat01-...">
    </div>
    <div class="field">
      <label>How / where to get it</label>
      <textarea id="f-how"></textarea>
    </div>
    <div class="field">
      <label>Scope (optional)</label>
      <input id="f-scope" placeholder="area:foo or repo:owner/name">
    </div>
    <div class="field">
      <label>Notes (optional)</label>
      <textarea id="f-notes"></textarea>
    </div>
    <div class="field">
      <label>Value <span style="color:var(--muted)">(leave blank to update metadata only)</span></label>
      <input id="f-value" type="password" autocomplete="off" spellcheck="false">
    </div>
    <div class="modal-actions">
      <button id="modal-cancel">Cancel</button>
      <button class="primary" id="modal-save">Save</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
(function () {
  const $ = (id) => document.getElementById(id);
  const list = $("list");
  const modal = $("modal-backdrop");
  const restartBanner = $("restart-banner");
  const statusPill = $("status-pill");
  const toast = $("toast");

  // Token from hash, never from URL search params or stored.
  function readToken() {
    const m = location.hash.match(/[#&]token=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }
  let TOKEN = readToken();
  let editingName = null;
  let needsRestart = false;

  function showToast(msg, kind) {
    toast.textContent = msg;
    toast.className = "toast show " + (kind || "");
    setTimeout(() => { toast.className = "toast"; }, 3500);
  }

  function setStatus(text, kind) {
    statusPill.textContent = text;
    statusPill.className = "status-pill " + (kind || "");
  }

  function setRestartNeeded(yes) {
    needsRestart = yes;
    restartBanner.className = "restart-banner" + (yes ? " show" : "");
  }

  async function api(method, path, body) {
    const url = "/api/dashboard/secrets" + path;
    const init = {
      method,
      headers: { "Authorization": "Bearer " + TOKEN },
    };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const resp = await fetch(url, init);
    const text = await resp.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    if (!resp.ok) {
      throw new Error(parsed.message || ("HTTP " + resp.status));
    }
    return parsed;
  }

  function escape(s) {
    return String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function renderCard(secret) {
    const el = document.createElement("div");
    el.className = "card";
    el.dataset.name = secret.name;
    el.innerHTML =
      '<div class="card-head">' +
        '<div>' +
          '<h3>' + escape(secret.meta.label) + '</h3>' +
          '<div class="name">' + escape(secret.name) + '</div>' +
        '</div>' +
        '<span class="type-pill">' + escape(secret.meta.type) + '</span>' +
      '</div>' +
      '<div class="value-row">' +
        '<span class="v ' + (secret.has_value ? "" : "empty") + '">' +
          (secret.has_value ? escape(secret.masked_value) : "(empty — not yet set)") +
        '</span>' +
        (secret.has_value
          ? '<button data-act="reveal">Reveal</button>'
          : '') +
      '</div>' +
      '<div class="meta-grid">' +
        '<div><strong>Format:</strong> ' + escape(secret.meta.format) + '</div>' +
        '<div><strong>How to get:</strong> ' + escape(secret.meta.how_to_get) + '</div>' +
        (secret.meta.scope ? '<div><strong>Scope:</strong> ' + escape(secret.meta.scope) + '</div>' : '') +
        (secret.meta.notes ? '<div><strong>Notes:</strong> ' + escape(secret.meta.notes) + '</div>' : '') +
        '<div><strong>Updated:</strong> ' + escape(secret.meta.updated_at) + '</div>' +
      '</div>' +
      '<div class="card-actions">' +
        '<button data-act="edit">Edit</button>' +
        '<button class="danger" data-act="delete">Delete</button>' +
      '</div>';
    el.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === "reveal") {
        try {
          const result = await api("GET", "/" + secret.name);
          const span = el.querySelector(".value-row .v");
          if (btn.dataset.state === "revealed") {
            span.textContent = secret.masked_value;
            btn.textContent = "Reveal";
            btn.dataset.state = "";
          } else {
            span.textContent = result.value;
            btn.textContent = "Hide";
            btn.dataset.state = "revealed";
          }
        } catch (e) { showToast(e.message, "error"); }
      } else if (act === "edit") {
        openModal(secret);
      } else if (act === "delete") {
        if (!confirm("Delete secret " + secret.name + " ? This removes it from .env.")) return;
        try {
          await api("DELETE", "/" + secret.name);
          setRestartNeeded(true);
          showToast("Deleted " + secret.name, "success");
          await refresh();
        } catch (e) { showToast(e.message, "error"); }
      }
    });
    return el;
  }

  async function refresh() {
    if (!TOKEN) {
      list.innerHTML = '<div class="empty-state">No token in URL. Add <code>#token=&lt;gateway-token&gt;</code> to the URL.</div>';
      setStatus("no token", "warn");
      return;
    }
    try {
      const result = await api("GET", "");
      list.innerHTML = "";
      if (!result.secrets.length) {
        list.innerHTML = '<div class="empty-state">No secrets managed yet. Click "+ Add secret".</div>';
      } else {
        for (const s of result.secrets) list.appendChild(renderCard(s));
      }
      setStatus(result.secrets.length + " secret" + (result.secrets.length === 1 ? "" : "s"), "ok");
    } catch (e) {
      list.innerHTML = '<div class="empty-state">' + escape(e.message) + '</div>';
      setStatus("error", "warn");
    }
  }

  function openModal(secret) {
    editingName = secret ? secret.name : null;
    $("modal-title").textContent = secret ? ("Edit " + secret.name) : "Add secret";
    $("f-name").value = secret ? secret.name : "";
    $("f-name").disabled = !!secret;
    $("f-label").value = secret ? secret.meta.label : "";
    $("f-type").value = secret ? secret.meta.type : "anthropic_routine_bearer";
    $("f-format").value = secret ? secret.meta.format : "";
    $("f-how").value = secret ? secret.meta.how_to_get : "";
    $("f-scope").value = secret && secret.meta.scope ? secret.meta.scope : "";
    $("f-notes").value = secret && secret.meta.notes ? secret.meta.notes : "";
    $("f-value").value = "";
    $("err-name").textContent = "";
    modal.classList.add("show");
  }
  function closeModal() { modal.classList.remove("show"); }

  $("add-btn").addEventListener("click", () => openModal(null));
  $("refresh-btn").addEventListener("click", refresh);
  $("modal-cancel").addEventListener("click", closeModal);
  $("modal-backdrop").addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

  $("modal-save").addEventListener("click", async () => {
    const name = $("f-name").value.trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      $("err-name").textContent = "Must match /^[A-Z][A-Z0-9_]*$/";
      return;
    }
    const body = {
      label: $("f-label").value.trim(),
      type: $("f-type").value,
      format: $("f-format").value.trim(),
      how_to_get: $("f-how").value.trim(),
    };
    const scope = $("f-scope").value.trim();
    const notes = $("f-notes").value.trim();
    const value = $("f-value").value;
    if (scope) body.scope = scope;
    if (notes) body.notes = notes;
    if (value) body.value = value;
    if (!body.label || !body.format || !body.how_to_get) {
      showToast("Label, format, and how-to-get are required", "error");
      return;
    }
    try {
      await api("PUT", "/" + name, body);
      setRestartNeeded(true);
      closeModal();
      showToast("Saved " + name, "success");
      await refresh();
    } catch (e) { showToast(e.message, "error"); }
  });

  $("restart-btn").addEventListener("click", async () => {
    try {
      const result = await api("POST", "/_restart-gateway");
      showToast(result.message || "Restart instruction emitted", "success");
      setRestartNeeded(false);
    } catch (e) { showToast(e.message, "error"); }
  });

  // Drop the token from the URL bar immediately so it doesn't sit in
  // window.location for anyone shoulder-surfing. We keep it in memory only.
  if (TOKEN) {
    history.replaceState(null, "", location.pathname);
  }

  refresh();
})();
</script>
</body>
</html>`;

export const handleSecretsUi: OpenClawPluginHttpRouteHandler = (_req, res) => {
  const body = PAGE;
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body, "utf8"),
    "cache-control": "no-cache",
    "x-frame-options": "SAMEORIGIN",
  });
  res.end(body);
  return true;
};
