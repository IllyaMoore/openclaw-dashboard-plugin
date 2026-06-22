import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  SecretsStore,
  maskValue,
  parseEnv,
  ENV_PATH_ENV,
  META_PATH_ENV,
  AUDIT_PATH_ENV,
} from "../src/secrets/store.js";

let tmpDir = "";
let envPath = "";
let metaPath = "";
let auditPath = "";

const ANTHROPIC_TOKEN = "sk-ant-oat01-FAKE-TOKEN-FOR-TESTS-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GH_PAT = "github_pat_FAKE_TEST_PAT_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-secrets-"));
  envPath = path.join(tmpDir, ".env");
  metaPath = path.join(tmpDir, "secrets-meta.json");
  auditPath = path.join(tmpDir, "audit.jsonl");
  process.env[ENV_PATH_ENV] = envPath;
  process.env[META_PATH_ENV] = metaPath;
  process.env[AUDIT_PATH_ENV] = auditPath;
});

afterEach(async () => {
  delete process.env[ENV_PATH_ENV];
  delete process.env[META_PATH_ENV];
  delete process.env[AUDIT_PATH_ENV];
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("maskValue", () => {
  it("masks long values as first4…last4", () => {
    expect(maskValue(ANTHROPIC_TOKEN)).toBe("sk-a…aaaa");
  });

  it("returns all-asterisks for short values (<= 8 chars)", () => {
    expect(maskValue("short")).toBe("*****");
    expect(maskValue("12345678")).toBe("********");
  });

  it("returns empty for empty input", () => {
    expect(maskValue("")).toBe("");
  });
});

describe("parseEnv", () => {
  it("indexes simple KEY=value lines", () => {
    const parsed = parseEnv("FOO=bar\nBAZ=qux\n");
    expect(parsed.index.get("FOO")).toBe(0);
    expect(parsed.index.get("BAZ")).toBe(1);
  });

  it("preserves comments and blanks (they have no index entry)", () => {
    const parsed = parseEnv("# comment\n\nFOO=bar\n# another\n");
    expect(parsed.index.size).toBe(1);
    expect(parsed.lines).toEqual(["# comment", "", "FOO=bar", "# another"]);
  });

  it("ignores invalid key shapes", () => {
    const parsed = parseEnv("FOO BAR=x\n1FOO=y\nLEGIT=z\n");
    expect(parsed.index.has("LEGIT")).toBe(true);
    expect(parsed.index.has("FOO BAR")).toBe(false);
    expect(parsed.index.has("1FOO")).toBe(false);
  });
});

describe("SecretsStore — list", () => {
  it("returns empty list with no env/meta files", async () => {
    const store = new SecretsStore();
    expect(await store.list()).toEqual([]);
  });

  it("includes managed entries with masked values and ordered by name", async () => {
    await fs.writeFile(
      envPath,
      `DISPATCH_GH_PAT=${GH_PAT}\nDISPATCH_TOKEN_TEST=${ANTHROPIC_TOKEN}\nUNRELATED=other\n`,
    );
    await fs.writeFile(
      metaPath,
      JSON.stringify({
        version: 1,
        secrets: {
          DISPATCH_TOKEN_TEST: {
            label: "Test routine",
            type: "anthropic_routine_bearer",
            format: "sk-ant-oat01-...",
            how_to_get: "...",
            created_at: "2026-06-01T00:00:00Z",
            updated_at: "2026-06-01T00:00:00Z",
          },
          DISPATCH_GH_PAT: {
            label: "Pipeline writer",
            type: "github_pat_fine_grained",
            format: "github_pat_...",
            how_to_get: "...",
            created_at: "2026-06-01T00:00:00Z",
            updated_at: "2026-06-01T00:00:00Z",
          },
        },
      }),
    );
    const store = new SecretsStore();
    const list = await store.list();
    expect(list.map((s) => s.name)).toEqual([
      "DISPATCH_GH_PAT",
      "DISPATCH_TOKEN_TEST",
    ]);
    expect(list[0]!.masked_value).toBe("gith…xxxx");
    expect(list[1]!.masked_value).toBe("sk-a…aaaa");
    expect(list[0]!.has_value).toBe(true);
  });

  it("reports has_value=false when env entry is missing", async () => {
    await fs.writeFile(
      metaPath,
      JSON.stringify({
        version: 1,
        secrets: {
          DISPATCH_NEW: {
            label: "New",
            type: "generic",
            format: "any",
            how_to_get: "...",
            created_at: "2026-06-01T00:00:00Z",
            updated_at: "2026-06-01T00:00:00Z",
          },
        },
      }),
    );
    const store = new SecretsStore();
    const list = await store.list();
    expect(list[0]!.has_value).toBe(false);
    expect(list[0]!.masked_value).toBe("");
  });
});

describe("SecretsStore — reveal", () => {
  it("returns the full value for a managed secret", async () => {
    await fs.writeFile(envPath, `DISPATCH_TOKEN_TEST=${ANTHROPIC_TOKEN}\n`);
    await fs.writeFile(
      metaPath,
      JSON.stringify({
        version: 1,
        secrets: {
          DISPATCH_TOKEN_TEST: {
            label: "x",
            type: "anthropic_routine_bearer",
            format: "x",
            how_to_get: "x",
            created_at: "2026-06-01T00:00:00Z",
            updated_at: "2026-06-01T00:00:00Z",
          },
        },
      }),
    );
    const store = new SecretsStore();
    const revealed = await store.reveal("DISPATCH_TOKEN_TEST");
    expect(revealed?.value).toBe(ANTHROPIC_TOKEN);
  });

  it("returns null for unknown secret", async () => {
    const store = new SecretsStore();
    expect(await store.reveal("DOES_NOT_EXIST")).toBeNull();
  });
});

describe("SecretsStore — set", () => {
  it("creates a new managed secret with metadata + value", async () => {
    const store = new SecretsStore({ now: () => new Date("2026-06-22T15:00:00Z") });
    const result = await store.set("DISPATCH_NEW", {
      value: "new-value-1234",
      label: "New",
      type: "generic",
      format: "any",
      how_to_get: "ask",
    });
    expect(result.name).toBe("DISPATCH_NEW");
    expect(result.has_value).toBe(true);
    expect(result.meta.created_at).toBe("2026-06-22T15:00:00.000Z");
    expect(result.meta.updated_at).toBe("2026-06-22T15:00:00.000Z");
    const envContent = await fs.readFile(envPath, "utf8");
    expect(envContent).toContain("DISPATCH_NEW=new-value-1234");
  });

  it("preserves existing comments and unmanaged keys on write", async () => {
    await fs.writeFile(
      envPath,
      "# preamble\n\nUNRELATED=stays-untouched\n# section\nLEGACY_TOKEN=keep-me\n",
    );
    const store = new SecretsStore();
    await store.set("DISPATCH_NEW", {
      value: "v",
      label: "L",
      type: "generic",
      format: "f",
      how_to_get: "g",
    });
    const envContent = await fs.readFile(envPath, "utf8");
    expect(envContent).toContain("# preamble");
    expect(envContent).toContain("UNRELATED=stays-untouched");
    expect(envContent).toContain("# section");
    expect(envContent).toContain("LEGACY_TOKEN=keep-me");
    expect(envContent).toContain("DISPATCH_NEW=v");
  });

  it("updates an existing line in place (no duplicate)", async () => {
    const store = new SecretsStore();
    await store.set("FOO", {
      value: "first",
      label: "L",
      type: "generic",
      format: "f",
      how_to_get: "g",
    });
    await store.set("FOO", {
      value: "second",
      label: "L",
      type: "generic",
      format: "f",
      how_to_get: "g",
    });
    const envContent = await fs.readFile(envPath, "utf8");
    const matches = envContent.match(/^FOO=/gm);
    expect(matches?.length).toBe(1);
    expect(envContent).toContain("FOO=second");
  });

  it("preserves created_at when updating an existing secret", async () => {
    let now = new Date("2026-06-01T00:00:00Z");
    const store = new SecretsStore({ now: () => now });
    await store.set("FOO", {
      value: "v1",
      label: "L",
      type: "generic",
      format: "f",
      how_to_get: "g",
    });
    now = new Date("2026-06-22T00:00:00Z");
    const updated = await store.set("FOO", {
      value: "v2",
      label: "L2",
      type: "generic",
      format: "f",
      how_to_get: "g",
    });
    expect(updated.meta.created_at).toBe("2026-06-01T00:00:00.000Z");
    expect(updated.meta.updated_at).toBe("2026-06-22T00:00:00.000Z");
  });

  it("rejects invalid env var names", async () => {
    const store = new SecretsStore();
    await expect(
      store.set("lower_case", {
        value: "v",
        label: "L",
        type: "generic",
        format: "f",
        how_to_get: "g",
      }),
    ).rejects.toThrow(/invalid secret name/);
  });

  it("metadata-only update when value is undefined", async () => {
    await fs.writeFile(envPath, "FOO=keep-this-value\n");
    const store = new SecretsStore();
    await store.set("FOO", {
      label: "first label",
      type: "generic",
      format: "f",
      how_to_get: "g",
    });
    const updated = await store.set("FOO", {
      label: "updated label",
      type: "generic",
      format: "f",
      how_to_get: "g",
    });
    expect(updated.meta.label).toBe("updated label");
    expect(updated.has_value).toBe(true);
    const envContent = await fs.readFile(envPath, "utf8");
    expect(envContent).toContain("FOO=keep-this-value");
  });

  it("writes files with mode 0600", async () => {
    const store = new SecretsStore();
    await store.set("FOO", {
      value: "v",
      label: "L",
      type: "generic",
      format: "f",
      how_to_get: "g",
    });
    if (process.platform !== "win32") {
      const envStat = await fs.stat(envPath);
      const metaStat = await fs.stat(metaPath);
      expect(envStat.mode & 0o777).toBe(0o600);
      expect(metaStat.mode & 0o777).toBe(0o600);
    }
  });
});

describe("SecretsStore — delete", () => {
  it("removes from both env and meta files", async () => {
    const store = new SecretsStore();
    await store.set("FOO", {
      value: "v",
      label: "L",
      type: "generic",
      format: "f",
      how_to_get: "g",
    });
    const removed = await store.delete("FOO");
    expect(removed).toBe(true);
    const envContent = await fs.readFile(envPath, "utf8");
    expect(envContent).not.toContain("FOO=");
    const metaContent = JSON.parse(await fs.readFile(metaPath, "utf8"));
    expect(metaContent.secrets.FOO).toBeUndefined();
  });

  it("returns false when secret doesn't exist", async () => {
    const store = new SecretsStore();
    expect(await store.delete("NEVER_WAS_THERE")).toBe(false);
  });

  it("preserves unrelated env entries after delete", async () => {
    await fs.writeFile(envPath, "KEEP=alive\n");
    const store = new SecretsStore();
    await store.set("FOO", {
      value: "v",
      label: "L",
      type: "generic",
      format: "f",
      how_to_get: "g",
    });
    await store.delete("FOO");
    const envContent = await fs.readFile(envPath, "utf8");
    expect(envContent).toContain("KEEP=alive");
  });
});

describe("SecretsStore — audit", () => {
  it("appends one line per call with no value leak", async () => {
    const store = new SecretsStore();
    await store.audit({ action: "set", name: "FOO", actor: "illia", ok: true });
    await store.audit({
      action: "reveal",
      name: "FOO",
      actor: "illia",
      ok: true,
    });
    const audit = await fs.readFile(auditPath, "utf8");
    const lines = audit.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(audit).not.toContain(ANTHROPIC_TOKEN);
    expect(audit).not.toContain(GH_PAT);
    const first = JSON.parse(lines[0]!);
    expect(first.action).toBe("set");
    expect(first.actor).toBe("illia");
  });
});

describe("SecretsStore — no-leak guarantees", () => {
  it("audit file never contains secret values even after a full write+reveal cycle", async () => {
    const store = new SecretsStore();
    await store.set("DISPATCH_TOKEN_TEST", {
      value: ANTHROPIC_TOKEN,
      label: "x",
      type: "anthropic_routine_bearer",
      format: "x",
      how_to_get: "x",
    });
    await store.audit({
      action: "set",
      name: "DISPATCH_TOKEN_TEST",
      actor: "illia",
      ok: true,
    });
    await store.reveal("DISPATCH_TOKEN_TEST");
    await store.audit({
      action: "reveal",
      name: "DISPATCH_TOKEN_TEST",
      actor: "illia",
      ok: true,
    });
    const audit = await fs.readFile(auditPath, "utf8");
    expect(audit).not.toContain(ANTHROPIC_TOKEN);
    expect(audit).not.toContain("sk-ant-oat01");
  });
});
