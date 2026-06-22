import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Readable } from "node:stream";
import { handleSecrets } from "../src/api/secrets.js";
import {
  ENV_PATH_ENV,
  META_PATH_ENV,
  AUDIT_PATH_ENV,
  _resetForTest,
} from "../src/secrets/store.js";

const ANTHROPIC_TOKEN = "sk-ant-oat01-FAKE-TOKEN-FOR-ROUTES-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface CapturedResponse {
  status: number | null;
  body: string;
  bodyJson: () => unknown;
}

interface MockReq {
  method: string;
  url: string;
  body?: string;
  headers?: Record<string, string>;
}

function makeReq(opts: MockReq): import("node:http").IncomingMessage {
  const stream = Readable.from(opts.body ? [Buffer.from(opts.body)] : []);
  Object.assign(stream, {
    method: opts.method,
    url: opts.url,
    headers: opts.headers ?? {},
  });
  return stream as unknown as import("node:http").IncomingMessage;
}

function makeRes(): {
  res: import("node:http").ServerResponse;
  captured: CapturedResponse;
} {
  const captured: CapturedResponse = {
    status: null,
    body: "",
    bodyJson: () => JSON.parse(captured.body),
  };
  const res = {
    writeHead(status: number): void {
      captured.status = status;
    },
    end(payload?: string | Buffer): void {
      if (payload) captured.body = payload.toString();
    },
  };
  return { res: res as unknown as import("node:http").ServerResponse, captured };
}

let tmpDir = "";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-routes-"));
  process.env[ENV_PATH_ENV] = path.join(tmpDir, ".env");
  process.env[META_PATH_ENV] = path.join(tmpDir, "secrets-meta.json");
  process.env[AUDIT_PATH_ENV] = path.join(tmpDir, "audit.jsonl");
  _resetForTest();
});

afterEach(async () => {
  delete process.env[ENV_PATH_ENV];
  delete process.env[META_PATH_ENV];
  delete process.env[AUDIT_PATH_ENV];
  _resetForTest();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("GET /api/dashboard/secrets — list", () => {
  it("returns empty list when nothing managed", async () => {
    const { res, captured } = makeRes();
    await handleSecrets(
      makeReq({ method: "GET", url: "/api/dashboard/secrets" }),
      res,
    );
    expect(captured.status).toBe(200);
    const body = captured.bodyJson() as { ok: boolean; secrets: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.secrets).toEqual([]);
  });

  it("returns 405 on non-GET", async () => {
    const { res, captured } = makeRes();
    await handleSecrets(
      makeReq({ method: "POST", url: "/api/dashboard/secrets" }),
      res,
    );
    expect(captured.status).toBe(405);
  });

  it("never leaks full value in masked list response", async () => {
    // Seed via PUT first
    const setupRes = makeRes();
    await handleSecrets(
      makeReq({
        method: "PUT",
        url: "/api/dashboard/secrets/DISPATCH_TOKEN_TEST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: ANTHROPIC_TOKEN,
          label: "Test",
          type: "anthropic_routine_bearer",
          format: "sk-ant-oat01-...",
          how_to_get: "...",
        }),
      }),
      setupRes.res,
    );
    expect(setupRes.captured.status).toBe(200);
    // Now list
    const { res, captured } = makeRes();
    await handleSecrets(
      makeReq({ method: "GET", url: "/api/dashboard/secrets" }),
      res,
    );
    expect(captured.body).not.toContain(ANTHROPIC_TOKEN);
    expect(captured.body).toContain("sk-a"); // mask shows first 4
  });
});

describe("PUT /api/dashboard/secrets/:name — create/update", () => {
  it("creates a new secret + entry appears in subsequent list", async () => {
    const { res, captured } = makeRes();
    await handleSecrets(
      makeReq({
        method: "PUT",
        url: "/api/dashboard/secrets/DISPATCH_NEW",
        body: JSON.stringify({
          value: "v",
          label: "New",
          type: "generic",
          format: "any",
          how_to_get: "ask",
        }),
      }),
      res,
    );
    expect(captured.status).toBe(200);
    const listRes = makeRes();
    await handleSecrets(
      makeReq({ method: "GET", url: "/api/dashboard/secrets" }),
      listRes.res,
    );
    const list = (listRes.captured.bodyJson() as { secrets: { name: string }[] }).secrets;
    expect(list.map((s) => s.name)).toContain("DISPATCH_NEW");
  });

  it("rejects invalid env var name in path", async () => {
    const { res, captured } = makeRes();
    await handleSecrets(
      makeReq({
        method: "PUT",
        url: "/api/dashboard/secrets/lower_case",
        body: JSON.stringify({
          value: "v",
          label: "L",
          type: "generic",
          format: "f",
          how_to_get: "g",
        }),
      }),
      res,
    );
    expect(captured.status).toBe(400);
    expect((captured.bodyJson() as { message: string }).message).toMatch(
      /invalid secret name/,
    );
  });

  it("rejects missing required metadata fields", async () => {
    const { res, captured } = makeRes();
    await handleSecrets(
      makeReq({
        method: "PUT",
        url: "/api/dashboard/secrets/FOO",
        body: JSON.stringify({ value: "v" }),
      }),
      res,
    );
    expect(captured.status).toBe(400);
    expect((captured.bodyJson() as { message: string }).message).toMatch(
      /missing required fields/,
    );
  });

  it("rejects unknown type", async () => {
    const { res, captured } = makeRes();
    await handleSecrets(
      makeReq({
        method: "PUT",
        url: "/api/dashboard/secrets/FOO",
        body: JSON.stringify({
          value: "v",
          label: "L",
          type: "made_up_type",
          format: "f",
          how_to_get: "g",
        }),
      }),
      res,
    );
    expect(captured.status).toBe(400);
    expect((captured.bodyJson() as { message: string }).message).toMatch(
      /unknown type/,
    );
  });
});

describe("GET /api/dashboard/secrets/:name — reveal", () => {
  it("returns full value for a known secret", async () => {
    const setupRes = makeRes();
    await handleSecrets(
      makeReq({
        method: "PUT",
        url: "/api/dashboard/secrets/FOO",
        body: JSON.stringify({
          value: "the-value",
          label: "L",
          type: "generic",
          format: "f",
          how_to_get: "g",
        }),
      }),
      setupRes.res,
    );
    const { res, captured } = makeRes();
    await handleSecrets(
      makeReq({ method: "GET", url: "/api/dashboard/secrets/FOO" }),
      res,
    );
    expect(captured.status).toBe(200);
    const body = captured.bodyJson() as { value: string };
    expect(body.value).toBe("the-value");
  });

  it("returns 404 for unknown secret", async () => {
    const { res, captured } = makeRes();
    await handleSecrets(
      makeReq({ method: "GET", url: "/api/dashboard/secrets/NEVER_WAS" }),
      res,
    );
    expect(captured.status).toBe(404);
  });

  it("logs an audit line on reveal (without value)", async () => {
    const setupRes = makeRes();
    await handleSecrets(
      makeReq({
        method: "PUT",
        url: "/api/dashboard/secrets/FOO",
        body: JSON.stringify({
          value: ANTHROPIC_TOKEN,
          label: "L",
          type: "anthropic_routine_bearer",
          format: "f",
          how_to_get: "g",
        }),
      }),
      setupRes.res,
    );
    const { res } = makeRes();
    await handleSecrets(
      makeReq({ method: "GET", url: "/api/dashboard/secrets/FOO" }),
      res,
    );
    const audit = await fs.readFile(process.env[AUDIT_PATH_ENV]!, "utf8");
    expect(audit).toMatch(/"action":"reveal"/);
    expect(audit).toMatch(/"name":"FOO"/);
    expect(audit).not.toContain(ANTHROPIC_TOKEN);
  });
});

describe("DELETE /api/dashboard/secrets/:name", () => {
  it("removes the secret + reveal afterward returns 404", async () => {
    const setupRes = makeRes();
    await handleSecrets(
      makeReq({
        method: "PUT",
        url: "/api/dashboard/secrets/FOO",
        body: JSON.stringify({
          value: "v",
          label: "L",
          type: "generic",
          format: "f",
          how_to_get: "g",
        }),
      }),
      setupRes.res,
    );
    const delRes = makeRes();
    await handleSecrets(
      makeReq({ method: "DELETE", url: "/api/dashboard/secrets/FOO" }),
      delRes.res,
    );
    expect(delRes.captured.status).toBe(200);
    const revealRes = makeRes();
    await handleSecrets(
      makeReq({ method: "GET", url: "/api/dashboard/secrets/FOO" }),
      revealRes.res,
    );
    expect(revealRes.captured.status).toBe(404);
  });
});

describe("POST /api/dashboard/secrets/_restart-gateway", () => {
  it("returns restart instruction text", async () => {
    const { res, captured } = makeRes();
    await handleSecrets(
      makeReq({
        method: "POST",
        url: "/api/dashboard/secrets/_restart-gateway",
      }),
      res,
    );
    expect(captured.status).toBe(200);
    const body = captured.bodyJson() as { message: string };
    expect(body.message).toMatch(/systemctl --user restart openclaw-gateway/);
  });
});
