import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { promisify } from "node:util";
import { env } from "@codecrawler/shared";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export interface ToolStats {
  toolCalls: number;
}

export interface RepoTools {
  tools: DynamicStructuredTool[];
  stats: ToolStats;
}

/**
 * Lexically resolve a repo-relative path and reject anything that escapes the
 * checkout root or touches `.git`. Symlink escapes are caught separately by
 * {@link assertWithinRepo} at use-time via realpath.
 */
function resolveSafePath(repoRoot: string, relPath: string): string {
  const cleaned = (relPath ?? "").replace(/^\.?[\\/]+/, "");
  const resolved = nodePath.resolve(repoRoot, cleaned);
  const rel = nodePath.relative(repoRoot, resolved);
  if (rel === "") return resolved; // the root itself
  if (rel.startsWith("..") || nodePath.isAbsolute(rel)) {
    throw new Error(`path escapes repo root: ${relPath}`);
  }
  if (rel.split(nodePath.sep).includes(".git")) {
    throw new Error("access to .git is denied");
  }
  return resolved;
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

async function assertWithinRepo(repoRootReal: string, absPath: string): Promise<void> {
  const realTarget = await realpathOrNull(absPath);
  if (!realTarget) throw new Error(`path not found: ${absPath}`);
  const rel = nodePath.relative(repoRootReal, realTarget);
  if (rel === "") return;
  if (rel.startsWith("..") || nodePath.isAbsolute(rel)) {
    throw new Error("path escapes repo root");
  }
  if (rel.split(nodePath.sep).includes(".git")) {
    throw new Error("access to .git is denied");
  }
}

function capOutput(text: string, hint: string): string {
  const max = env.REVIEW_AGENT_MAX_TOOL_OUTPUT_BYTES;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated at ${max} bytes — ${hint}]`;
}

/**
 * Build the three read-only exploration tools bound to a checkout path. Every
 * invocation increments `stats.toolCalls` so the review run can persist an
 * accurate observability counter. No tool mutates the filesystem or network.
 */
export function createRepoTools(repoPath: string): RepoTools {
  const stats: ToolStats = { toolCalls: 0 };
  let rootRealCache: Promise<string> | null = null;
  const rootReal = (): Promise<string> => (rootRealCache ??= fs.realpath(repoPath));

  const readFile = new DynamicStructuredTool({
    name: "read_file",
    description:
      "Read a source file from the repository checkout. Returns the file contents with a line-numbered header. Use startLine/endLine to read a slice of large files. Paths are repo-relative.",
    schema: z.object({
      path: z.string().min(1).describe("Repo-relative file path, e.g. src/index.ts"),
      startLine: z.number().int().min(1).optional().describe("1-based first line to read"),
      endLine: z.number().int().min(1).optional().describe("1-based last line to read (inclusive)"),
    }),
    func: async ({ path, startLine, endLine }) => {
      stats.toolCalls += 1;
      const abs = resolveSafePath(repoPath, path);
      await assertWithinRepo(await rootReal(), abs);
      const info = await fs.stat(abs);
      if (!info.isFile()) throw new Error(`not a regular file: ${path}`);
      const maxRead = env.REVIEW_AGENT_MAX_READ_BYTES;
      if (info.size > maxRead && !startLine) {
        return `file: ${path} (${info.size} bytes) — too large to read whole (limit ${maxRead} B). Re-call with startLine/endLine to read a slice.`;
      }
      const raw = await fs.readFile(abs, "utf8");
      const allLines = raw.split("\n");
      const total = allLines.length;
      const s = Math.min(Math.max(1, startLine ?? 1), total);
      const e = Math.min(Math.max(s, endLine ?? total), total);
      const slice = allLines.slice(s - 1, e).join("\n");
      const header = `file: ${path} (showing lines ${s}-${e} of ${total}, ${info.size} bytes)`;
      return capOutput(`${header}\n\n${slice}`, "narrow the line range to see more");
    },
  });

  const searchCode = new DynamicStructuredTool({
    name: "search_code",
    description:
      "Search the repository for a regular-expression pattern with ripgrep. Returns matching file:line:context rows. Use this to find definitions, call sites, or references. Respects .gitignore.",
    schema: z.object({
      query: z
        .string()
        .min(1)
        .describe("ripgrep regex, e.g. 'function computeReviewCost' or 'TODO|FIXME'"),
      glob: z.string().optional().describe("Optional include glob, e.g. '*.ts' or 'src/**'"),
      maxResults: z.number().int().min(1).max(80).optional(),
    }),
    func: async ({ query, glob, maxResults }) => {
      stats.toolCalls += 1;
      const limit = Math.min(maxResults ?? 40, 80);
      const args = [
        "--no-heading",
        "-n",
        "--color=never",
        "--max-count",
        String(limit),
        "-g",
        "!**/.git/**",
      ];
      if (glob) {
        args.push("-g", glob);
      }
      args.push("--", query, ".");
      try {
        const { stdout } = await execFileAsync("rg", args, {
          cwd: repoPath,
          maxBuffer: env.REVIEW_AGENT_MAX_TOOL_OUTPUT_BYTES + 4096,
          timeout: 15_000,
        });
        const rows = stdout
          .split("\n")
          .filter((line) => line.length > 0)
          .slice(0, limit);
        if (rows.length === 0) return `no matches for /${query}/`;
        return capOutput(
          `${rows.length} match(es) for /${query}/\n${rows.join("\n")}`,
          "narrow the query or glob to see more",
        );
      } catch (err) {
        const e = err as { code?: string; status?: number };
        if (e.code === "ENOENT") {
          return "search_code unavailable: ripgrep is not installed in this environment";
        }
        // rg exits 1 for "no matches" or when stopped by --max-count head; treat
        // both as a clean empty result rather than a tool failure.
        if (e.status === 1 || e.code === "1") {
          return `no matches for /${query}/`;
        }
        throw err;
      }
    },
  });

  const listDir = new DynamicStructuredTool({
    name: "list_dir",
    description:
      "List entries in a repository directory. Each row is `<type> <name>` where type is d (dir), f (file), or l (symlink). Use '.' for the repo root.",
    schema: z.object({
      path: z.string().min(1).describe("Repo-relative directory path, or '.' for root"),
    }),
    func: async ({ path: dir }) => {
      stats.toolCalls += 1;
      const abs = resolveSafePath(repoPath, dir === "." ? "." : dir);
      await assertWithinRepo(await rootReal(), abs);
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const rows = entries
        .filter((e) => e.name !== ".git")
        .sort((a, b) => {
          const ad = a.isDirectory() ? 0 : 1;
          const bd = b.isDirectory() ? 0 : 1;
          return ad - bd || a.name.localeCompare(b.name);
        })
        .map((e) => {
          const tag = e.isDirectory() ? "d" : e.isSymbolicLink() ? "l" : "f";
          return `${tag}\t${e.name}`;
        });
      return capOutput(
        `${dir} (${rows.length} entries)\n${rows.join("\n")}`,
        "narrow to a subdirectory",
      );
    },
  });

  return { tools: [readFile, searchCode, listDir], stats };
}

export const REPO_TOOL_NAMES = ["read_file", "search_code", "list_dir"] as const;
export type RepoToolName = (typeof REPO_TOOL_NAMES)[number];
