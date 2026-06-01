import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";

/**
 * /api/dashboard/skills
 *
 * Read-only inventory of skill markdown files the OpenClaw agent has access
 * to. Three sources are scanned:
 *
 *   - workspace  /home/<user>/.openclaw/workspace/skills/<name>/SKILL.md
 *                User-authored. Editable. Hot-injected into every session's
 *                skillsSnapshot.
 *
 *   - extension  /home/<user>/.openclaw/npm/node_modules/@openclaw/*\/skills/
 *                Bundled with installed npm plugins (acpx, etc).
 *                System-managed, read-only.
 *
 *   - system     /usr/lib/node_modules/openclaw/skills/<name>/SKILL.md
 *                Shipped with OpenClaw runtime. System-managed, read-only.
 *
 * Phase 1 (this file): listing + read-only content. Edit / delete is a
 * follow-up phase.
 */

type SkillSource = "workspace" | "extension" | "system";

interface SkillSummary {
  id: string;
  source: SkillSource;
  name: string;
  description: string | null;
  sizeBytes: number;
  mtime: string;
  filePath: string;
}

interface SkillContent {
  id: string;
  source: SkillSource;
  name: string;
  description: string | null;
  content: string;
  mtime: string;
  filePath: string;
}

const WORKSPACE_SKILLS_DIR = join(
  homedir(),
  ".openclaw",
  "workspace",
  "skills",
);
const EXTENSION_NPM_DIR = join(
  homedir(),
  ".openclaw",
  "npm",
  "node_modules",
  "@openclaw",
);
const SYSTEM_SKILLS_DIR = "/usr/lib/node_modules/openclaw/skills";

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function sendJson(res: ServerResponse, status: number, body: unknown): boolean {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload, "utf8"),
  });
  res.end(payload);
  return true;
}

interface Frontmatter {
  name: string | null;
  description: string | null;
}

// Minimal YAML frontmatter parser: only top-level `name:` and `description:`.
// Avoids pulling in a YAML lib. Multiline descriptions (folded blocks) are
// not supported in Phase 1 — almost all SKILL.md files use single-line
// description anyway.
function parseFrontmatter(text: string): Frontmatter {
  const out: Frontmatter = { name: null, description: null };
  if (!text.startsWith("---")) return out;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return out;
  const body = text.slice(3, end);
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    const m = /^(name|description)\s*:\s*(.*)$/i.exec(line);
    if (!m || !m[1]) continue;
    const key = m[1].toLowerCase() as "name" | "description";
    let value = (m[2] ?? "").trim();
    // Strip optional surrounding quotes.
    value = value.replace(/^"([^"]*)"$/, "$1").replace(/^'([^']*)'$/, "$1");
    if (key === "name") out.name = value || null;
    else out.description = value || null;
  }
  return out;
}

async function listDirEntries(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function readSkillSummary(
  source: SkillSource,
  name: string,
  filePath: string,
): Promise<SkillSummary | null> {
  try {
    const [stat, content] = await Promise.all([
      fs.stat(filePath),
      fs.readFile(filePath, "utf8"),
    ]);
    const fm = parseFrontmatter(content);
    return {
      id: `${source}/${name}`,
      source,
      name: fm.name ?? name,
      description: fm.description,
      sizeBytes: stat.size,
      mtime: stat.mtime.toISOString(),
      filePath,
    };
  } catch {
    return null;
  }
}

async function scanWorkspaceSkills(): Promise<SkillSummary[]> {
  const entries = await listDirEntries(WORKSPACE_SKILLS_DIR);
  const out: SkillSummary[] = [];
  for (const entry of entries) {
    if (!SKILL_NAME_RE.test(entry)) continue;
    const filePath = join(WORKSPACE_SKILLS_DIR, entry, "SKILL.md");
    const summary = await readSkillSummary("workspace", entry, filePath);
    if (summary) out.push(summary);
  }
  return out;
}

async function scanSystemSkills(): Promise<SkillSummary[]> {
  const entries = await listDirEntries(SYSTEM_SKILLS_DIR);
  const out: SkillSummary[] = [];
  for (const entry of entries) {
    if (!SKILL_NAME_RE.test(entry)) continue;
    const filePath = join(SYSTEM_SKILLS_DIR, entry, "SKILL.md");
    const summary = await readSkillSummary("system", entry, filePath);
    if (summary) out.push(summary);
  }
  return out;
}

async function scanExtensionSkills(): Promise<SkillSummary[]> {
  // /home/<user>/.openclaw/npm/node_modules/@openclaw/<pkg>/skills/<name>/SKILL.md
  const packages = await listDirEntries(EXTENSION_NPM_DIR);
  const out: SkillSummary[] = [];
  for (const pkg of packages) {
    const pkgSkillsDir = join(EXTENSION_NPM_DIR, pkg, "skills");
    const skills = await listDirEntries(pkgSkillsDir);
    for (const skill of skills) {
      if (!SKILL_NAME_RE.test(skill)) continue;
      const filePath = join(pkgSkillsDir, skill, "SKILL.md");
      const summary = await readSkillSummary("extension", skill, filePath);
      if (summary) out.push(summary);
    }
  }
  return out;
}

async function listAllSkills(): Promise<SkillSummary[]> {
  const [workspace, system, extension] = await Promise.all([
    scanWorkspaceSkills(),
    scanSystemSkills(),
    scanExtensionSkills(),
  ]);
  // Workspace first (user-relevant), then extension, then system.
  return [...workspace, ...extension, ...system].sort((a, b) => {
    const sourceOrder: Record<SkillSource, number> = {
      workspace: 0,
      extension: 1,
      system: 2,
    };
    const so = sourceOrder[a.source] - sourceOrder[b.source];
    if (so !== 0) return so;
    return a.name.localeCompare(b.name);
  });
}

async function resolveSkillFile(
  source: string,
  name: string,
): Promise<string | null> {
  if (!SKILL_NAME_RE.test(name)) return null;
  switch (source) {
    case "workspace":
      return join(WORKSPACE_SKILLS_DIR, name, "SKILL.md");
    case "system":
      return join(SYSTEM_SKILLS_DIR, name, "SKILL.md");
    case "extension": {
      // Search across all @openclaw/* packages for a matching skill name.
      const packages = await listDirEntries(EXTENSION_NPM_DIR);
      for (const pkg of packages) {
        const candidate = join(
          EXTENSION_NPM_DIR,
          pkg,
          "skills",
          name,
          "SKILL.md",
        );
        try {
          await fs.stat(candidate);
          return candidate;
        } catch {
          // try next package
        }
      }
      return null;
    }
    default:
      return null;
  }
}

async function readSkillContent(
  source: SkillSource,
  name: string,
): Promise<SkillContent | null> {
  const filePath = await resolveSkillFile(source, name);
  if (!filePath) return null;
  try {
    const [stat, content] = await Promise.all([
      fs.stat(filePath),
      fs.readFile(filePath, "utf8"),
    ]);
    const fm = parseFrontmatter(content);
    return {
      id: `${source}/${name}`,
      source,
      name: fm.name ?? name,
      description: fm.description,
      content,
      mtime: stat.mtime.toISOString(),
      filePath,
    };
  } catch {
    return null;
  }
}

export const handleSkills: OpenClawPluginHttpRouteHandler = async (
  req,
  res,
) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const segments = url.pathname.split("/").filter(Boolean);
  // Expect: ["api", "dashboard", "skills", ...]
  if (
    segments[0] !== "api" ||
    segments[1] !== "dashboard" ||
    segments[2] !== "skills"
  ) {
    return sendJson(res, 404, { error: "not found" });
  }
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    return sendJson(res, 405, { error: `method ${method} not allowed` });
  }

  try {
    // GET /api/dashboard/skills
    if (segments.length === 3) {
      const skills = await listAllSkills();
      return sendJson(res, 200, { skills });
    }

    // GET /api/dashboard/skills/:source/:name
    if (segments.length === 5) {
      const sourceRaw = segments[3];
      const nameRaw = segments[4];
      if (!sourceRaw || !nameRaw) {
        return sendJson(res, 400, { error: "missing source or name" });
      }
      const source = decodeURIComponent(sourceRaw);
      const name = decodeURIComponent(nameRaw);
      if (
        source !== "workspace" &&
        source !== "extension" &&
        source !== "system"
      ) {
        return sendJson(res, 400, { error: "invalid source" });
      }
      const skill = await readSkillContent(source, name);
      if (!skill) {
        return sendJson(res, 404, { error: `skill "${source}/${name}" not found` });
      }
      return sendJson(res, 200, skill);
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal error";
    return sendJson(res, 500, { error: message });
  }
};
