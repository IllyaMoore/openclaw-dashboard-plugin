import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Dashboard secrets store.
 *
 * Storage model:
 *   - Values live in `~/.openclaw/.env` as plain KEY=value lines (mode 0600).
 *     This is the same file plugins already read at startup, so the dashboard
 *     UI doesn't need to invent a new storage format — it edits what's
 *     already there.
 *   - Metadata lives in `~/.openclaw/dashboard-secrets-meta.json`. One entry
 *     per "managed" key with label/type/format/how_to_get/scope/timestamps.
 *
 * Why split? `.env` has no place for metadata (it's just KEY=value lines),
 * and we don't want to invent a custom comment convention that breaks every
 * other dotenv reader. Keep the data and the UI hints in separate files.
 *
 * "Managed" vs "unmanaged" keys: this module only touches keys listed in
 * the metadata file. Anything else in `.env` (e.g. legacy keys, keys set
 * by other tools, OS environment overrides) is preserved verbatim on every
 * write. Operators can `cat .env` and trust that comments and unrelated
 * variables are intact after the dashboard touches a single managed key.
 *
 * Security:
 *   - Atomic writes via tmp + rename. Mode 0600 enforced on every write.
 *   - Secret VALUES never appear in audit log; only NAMES and ACTIONS.
 *   - Mask format for list views: first 4 + ellipsis + last 4 chars.
 */

export const ENV_PATH_ENV = "OPENCLAW_DASHBOARD_SECRETS_ENV";
export const META_PATH_ENV = "OPENCLAW_DASHBOARD_SECRETS_META";
export const AUDIT_PATH_ENV = "OPENCLAW_DASHBOARD_SECRETS_AUDIT";

export type SecretType =
  | "anthropic_routine_bearer"
  | "github_pat_fine_grained"
  | "github_pat_classic"
  | "api_key"
  | "generic";

export interface SecretMeta {
  label: string;
  type: SecretType;
  format: string;
  how_to_get: string;
  scope?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
}

export interface SecretListEntry {
  name: string;
  masked_value: string;
  has_value: boolean;
  meta: SecretMeta;
}

export interface SecretRevealEntry {
  name: string;
  value: string;
  meta: SecretMeta;
}

export interface PersistedMeta {
  version: 1;
  secrets: Record<string, SecretMeta>;
}

export interface SecretsStoreOptions {
  envPath?: string;
  metaPath?: string;
  auditPath?: string;
  now?: () => Date;
}

export function resolveEnvPath(): string {
  return (
    process.env[ENV_PATH_ENV]?.trim() ||
    path.join(os.homedir(), ".openclaw", ".env")
  );
}

export function resolveMetaPath(): string {
  return (
    process.env[META_PATH_ENV]?.trim() ||
    path.join(os.homedir(), ".openclaw", "dashboard-secrets-meta.json")
  );
}

export function resolveAuditPath(): string {
  return (
    process.env[AUDIT_PATH_ENV]?.trim() ||
    path.join(os.homedir(), ".openclaw", "dashboard-secrets-audit.jsonl")
  );
}

/**
 * First 4 + ellipsis + last 4 chars. Short strings (<= 8 chars) become
 * all-asterisks so we don't accidentally reveal the whole secret.
 */
export function maskValue(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

interface ParsedEnv {
  /** Original lines (comments + blanks + KEY=value), in order. */
  lines: string[];
  /** Map of KEY → 0-based line index in `lines`. Last occurrence wins. */
  index: Map<string, number>;
}

/**
 * Minimal `.env` parser. Recognises `KEY=value`, `KEY="value"`, `KEY='value'`.
 * Comments (`#`) and blanks are preserved on write but not parsed. Multi-line
 * values are NOT supported — the dashboard doesn't write any, and reading
 * them as single lines is fine since we don't introspect the value beyond
 * "exists or not".
 */
export function parseEnv(raw: string): ParsedEnv {
  const lines = raw.split(/\r?\n/);
  // Drop a trailing empty string from a trailing newline so re-serialising
  // doesn't add a blank line each time.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const index = new Map<string, number>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    index.set(key, i);
  }
  return { lines, index };
}

function serializeEnv(parsed: ParsedEnv): string {
  // Always end with a trailing newline so editors don't complain.
  return parsed.lines.join("\n") + "\n";
}

function setEnvLine(parsed: ParsedEnv, name: string, value: string): void {
  const line = `${name}=${value}`;
  const existing = parsed.index.get(name);
  if (existing !== undefined) {
    parsed.lines[existing] = line;
  } else {
    parsed.lines.push(line);
    parsed.index.set(name, parsed.lines.length - 1);
  }
}

function removeEnvLine(parsed: ParsedEnv, name: string): void {
  const existing = parsed.index.get(name);
  if (existing === undefined) return;
  parsed.lines.splice(existing, 1);
  parsed.index.delete(name);
  // Reindex everything after the removed line.
  for (const [k, idx] of parsed.index) {
    if (idx > existing) parsed.index.set(k, idx - 1);
  }
}

function getEnvValue(parsed: ParsedEnv, name: string): string | null {
  const idx = parsed.index.get(name);
  if (idx === undefined) return null;
  const line = parsed.lines[idx]!;
  const eq = line.indexOf("=");
  if (eq < 0) return null;
  let value = line.slice(eq + 1);
  // Strip surrounding quotes if present (single or double).
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

async function readMeta(metaPath: string): Promise<PersistedMeta> {
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedMeta>;
    if (parsed?.version === 1 && parsed.secrets && typeof parsed.secrets === "object") {
      return { version: 1, secrets: parsed.secrets };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // Corrupt — start fresh rather than block the dashboard.
    }
  }
  return { version: 1, secrets: {} };
}

async function readEnv(envPath: string): Promise<ParsedEnv> {
  try {
    const raw = await fs.readFile(envPath, "utf8");
    return parseEnv(raw);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    return { lines: [], index: new Map() };
  }
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, target);
}

export type AuditAction =
  | "list"
  | "reveal"
  | "set"
  | "delete"
  | "restart-gateway";

export interface AuditEntry {
  ts: string;
  action: AuditAction;
  name?: string;
  actor?: string;
  ok: boolean;
  reason?: string;
}

export class SecretsStore {
  private envPath: string;
  private metaPath: string;
  private auditPath: string;
  private now: () => Date;

  constructor(opts: SecretsStoreOptions = {}) {
    this.envPath = opts.envPath ?? resolveEnvPath();
    this.metaPath = opts.metaPath ?? resolveMetaPath();
    this.auditPath = opts.auditPath ?? resolveAuditPath();
    this.now = opts.now ?? (() => new Date());
  }

  /** List all managed secrets with masked values + metadata. */
  async list(): Promise<SecretListEntry[]> {
    const [env, meta] = await Promise.all([
      readEnv(this.envPath),
      readMeta(this.metaPath),
    ]);
    const entries: SecretListEntry[] = [];
    for (const [name, secretMeta] of Object.entries(meta.secrets)) {
      const value = getEnvValue(env, name);
      entries.push({
        name,
        masked_value: value === null ? "" : maskValue(value),
        has_value: value !== null && value !== "",
        meta: secretMeta,
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  /** Fetch one secret's full value. Caller must be authorised. */
  async reveal(name: string): Promise<SecretRevealEntry | null> {
    const [env, meta] = await Promise.all([
      readEnv(this.envPath),
      readMeta(this.metaPath),
    ]);
    const secretMeta = meta.secrets[name];
    if (!secretMeta) return null;
    const value = getEnvValue(env, name);
    return { name, value: value ?? "", meta: secretMeta };
  }

  /**
   * Create or update a secret. `value` is optional — if undefined, only the
   * metadata is updated (useful for editing labels without re-typing the
   * token). If the secret is new and `value` is undefined, the env entry
   * is left empty so the operator can fill it later.
   */
  async set(
    name: string,
    params: {
      value?: string;
      label: string;
      type: SecretType;
      format: string;
      how_to_get: string;
      scope?: string;
      notes?: string;
    },
  ): Promise<SecretListEntry> {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      throw new Error(
        `invalid secret name "${name}" — must match /^[A-Z][A-Z0-9_]*$/`,
      );
    }
    const [env, meta] = await Promise.all([
      readEnv(this.envPath),
      readMeta(this.metaPath),
    ]);
    const nowIso = this.now().toISOString();
    const existing = meta.secrets[name];
    const nextMeta: SecretMeta = {
      label: params.label,
      type: params.type,
      format: params.format,
      how_to_get: params.how_to_get,
      ...(params.scope !== undefined ? { scope: params.scope } : {}),
      ...(params.notes !== undefined ? { notes: params.notes } : {}),
      created_at: existing?.created_at ?? nowIso,
      updated_at: nowIso,
    };
    meta.secrets[name] = nextMeta;
    await atomicWrite(this.metaPath, JSON.stringify(meta, null, 2));
    if (params.value !== undefined) {
      setEnvLine(env, name, params.value);
      await atomicWrite(this.envPath, serializeEnv(env));
    }
    const currentValue =
      params.value !== undefined ? params.value : getEnvValue(env, name);
    return {
      name,
      masked_value: currentValue ? maskValue(currentValue) : "",
      has_value: !!currentValue,
      meta: nextMeta,
    };
  }

  async delete(name: string): Promise<boolean> {
    const [env, meta] = await Promise.all([
      readEnv(this.envPath),
      readMeta(this.metaPath),
    ]);
    if (!meta.secrets[name] && env.index.get(name) === undefined) return false;
    delete meta.secrets[name];
    removeEnvLine(env, name);
    await Promise.all([
      atomicWrite(this.metaPath, JSON.stringify(meta, null, 2)),
      atomicWrite(this.envPath, serializeEnv(env)),
    ]);
    return true;
  }

  /** Append-only audit entry. Values never logged. */
  async audit(entry: Omit<AuditEntry, "ts">): Promise<void> {
    const line =
      JSON.stringify({ ts: this.now().toISOString(), ...entry }) + "\n";
    try {
      await fs.mkdir(path.dirname(this.auditPath), { recursive: true });
      await fs.appendFile(this.auditPath, line, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // Audit is best-effort. Don't crash the request if disk is full.
    }
  }
}

let singleton: SecretsStore | null = null;
export function getSecretsStore(): SecretsStore {
  if (!singleton) singleton = new SecretsStore();
  return singleton;
}

/** Test helper. */
export function _resetForTest(): void {
  singleton = null;
}
