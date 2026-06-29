import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { promisify } from "node:util";
import { env } from "@codecrawler/shared";
import { cacheGet, cacheSet } from "./cache";

const execFileAsync = promisify(execFile);

const REPO_MAP_TTL_SECONDS = 24 * 60 * 60;

// Directories we never want in the map — defensive on top of .gitignore, since
// a shallow checkout can still contain generated/vendored trees.
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  "target",
  ".turbo",
  ".svelte-kit",
  "coverage",
  ".cache",
  ".idea",
  ".vscode",
]);

const IGNORED_SUFFIXES = [
  ".lock",
  ".lockb",
  "-lock.json",
  ".min.js",
  ".min.css",
  ".map",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".woff",
  ".woff2",
  ".ttf",
  ".so",
  ".wasm",
];

export interface RepoMapResult {
  text: string;
  fileCount: number;
  totalLines: number;
  cached: boolean;
}

function repoMapKey(sha: string): string {
  return `cc:repo-map:${sha}`;
}

function shouldIgnoreFile(relPath: string): boolean {
  const parts = relPath.split(nodePath.sep);
  if (parts.some((p) => IGNORED_DIRS.has(p))) return true;
  return IGNORED_SUFFIXES.some((s) => relPath.endsWith(s));
}

/**
 * Build a compact, token-cheap map of the repo: a header (file/line totals +
 * top-level dirs) followed by a sorted `<path> | <lines>` listing. Cached in
 * Redis keyed by the PR head SHA for ~24h so repeated reviews of the same
 * commit are free. The map is hard-capped to REVIEW_INDEX_MAX_BYTES so it can
 * never dominate the agent context.
 */
export async function buildRepoMap(repoPath: string, headSha?: string): Promise<RepoMapResult> {
  if (headSha) {
    const cached = await cacheGet(repoMapKey(headSha));
    if (cached) {
      return parseCached(cached, true);
    }
  }
  const entries = await collectEntries(repoPath);
  const text = renderMap(entries);
  const result: RepoMapResult = {
    text,
    fileCount: entries.length,
    totalLines: entries.reduce((sum, e) => sum + e.lines, 0),
    cached: false,
  };
  if (headSha) {
    await cacheSet(repoMapKey(headSha), serialize(result), REPO_MAP_TTL_SECONDS);
  }
  return result;
}

interface MapEntry {
  path: string;
  lines: number;
}

async function collectEntries(repoPath: string): Promise<MapEntry[]> {
  const viaRg = await collectViaRipgrep(repoPath);
  if (viaRg) return viaRg;
  return collectViaWalk(repoPath);
}

// Fast path: `rg --count "^"` matches every line, so the per-file count equals
// the total line count. Respects .gitignore and skips binaries.
async function collectViaRipgrep(repoPath: string): Promise<MapEntry[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "rg",
      ["--count", "--no-heading", "--color=never", "-g", "!**/.git/**", "^", "."],
      { cwd: repoPath, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
    );
    const entries: MapEntry[] = [];
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const sep = line.lastIndexOf(":");
      if (sep <= 0) continue;
      let path = line.slice(0, sep);
      if (path.startsWith("./")) path = path.slice(2);
      const count = Number.parseInt(line.slice(sep + 1), 10);
      if (!path || !Number.isFinite(count)) continue;
      if (shouldIgnoreFile(path)) continue;
      entries.push({ path, lines: count });
    }
    return entries;
  } catch (err) {
    const e = err as { code?: string; status?: number };
    if (e.code === "ENOENT") return null; // ripgrep missing → walk fallback
    // status 1 = no matches (empty repo); anything else falls back too.
    return [];
  }
}

// Fallback that needs no external binary: recursive readdir with size-as-lines
// proxy (size/32). Correct enough for the model to know what files exist.
async function collectViaWalk(repoPath: string): Promise<MapEntry[]> {
  const entries: MapEntry[] = [];
  async function walk(dir: string): Promise<void> {
    let list: Dirent[];
    try {
      list = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of list) {
      if (IGNORED_DIRS.has(ent.name)) continue;
      const full = nodePath.join(dir, ent.name);
      const rel = nodePath.relative(repoPath, full);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile()) {
        if (shouldIgnoreFile(rel)) continue;
        let size = 0;
        try {
          size = (await fs.stat(full)).size;
        } catch {
          continue;
        }
        entries.push({ path: rel, lines: Math.max(1, Math.round(size / 32)) });
      }
    }
  }
  await walk(repoPath);
  return entries;
}

function renderMap(entries: MapEntry[]): string {
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const totalLines = entries.reduce((sum, e) => sum + e.lines, 0);

  const topLevel = new Map<string, { files: number; lines: number }>();
  for (const e of entries) {
    const top = e.path.split(nodePath.sep)[0] ?? e.path;
    const cur = topLevel.get(top) ?? { files: 0, lines: 0 };
    cur.files += 1;
    cur.lines += e.lines;
    topLevel.set(top, cur);
  }
  const topSummary = [...topLevel.entries()]
    .sort((a, b) => b[1].lines - a[1].lines)
    .map(([name, s]) => `  ${name}/ — ${s.files} files, ${s.lines} lines`)
    .join("\n");

  const header = `Repository map (${entries.length} tracked files, ~${totalLines} lines)\nTop-level:\n${topSummary}\n\nFiles (path | lines):`;

  const budget = env.REVIEW_INDEX_MAX_BYTES;
  const lines: string[] = [];
  let used = header.length;
  for (const e of entries) {
    const row = `${e.path} | ${e.lines}`;
    if (used + row.length + 1 > budget) {
      lines.push(`… (${entries.length - lines.length} more files omitted)`);
      break;
    }
    lines.push(row);
    used += row.length + 1;
  }
  return `${header}\n${lines.join("\n")}`;
}

function serialize(r: RepoMapResult): string {
  return JSON.stringify(r);
}

function parseCached(raw: string, cached: boolean): RepoMapResult {
  try {
    const parsed = JSON.parse(raw) as RepoMapResult;
    return { ...parsed, cached };
  } catch {
    return { text: raw, fileCount: 0, totalLines: 0, cached };
  }
}
