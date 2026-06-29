import { loadFixture } from "./fixture";

export type SecurityFindingKind = "sast" | "dep" | "secret" | "ai";

export type Severity = "critical" | "high" | "medium" | "low" | "nitpick";

export interface RawSecurityFinding {
  kind: SecurityFindingKind;
  severity: Severity;
  file?: string;
  line?: number;
  package?: string;
  vulnVersion?: string;
  fixedVersion?: string;
  message: string;
  rule?: string;
}

export interface SnykResult {
  ok: boolean;
  depFindings: RawSecurityFinding[];
  sastFindings: RawSecurityFinding[];
  rawDep?: unknown;
  rawSast?: unknown;
  source: "snyk-cli" | "fixture";
  error?: string;
}

export { loadFixture };

const SNYK_TIMEOUT_MS = 90_000;
const SECRET_MAX_FINDINGS = 200;
const SECRET_MAX_FILE_BYTES = 1_000_000;
const AUTH_HINT_RE =
  /snyk auth|use `snyk auth`|not authenticated|unauthori[sz]ed|\b401\b|api token|invalid token|forbidden/i;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".svelte-kit",
  ".next",
  "coverage",
  ".cache",
  ".turbo",
]);

const BINARY_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".icns",
  ".tiff",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".tar",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".webm",
  ".mov",
  ".avi",
  ".mkv",
  ".wav",
  ".flac",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".dat",
  ".class",
  ".jar",
  ".wasm",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".lock",
  ".lockb",
  ".snapshot",
  ".min",
  ".map",
]);

interface SecretPattern {
  id: string;
  regex: RegExp;
  severity: Severity;
  label: string;
  secretGroup?: number;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    id: "aws-access-key-id",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    severity: "high",
    label: "AWS Access Key ID",
    secretGroup: 0,
  },
  {
    id: "aws-secret-access-key",
    regex: /aws(?:.{0,20})?(?:secret|key).{0,10}["']([A-Za-z0-9+/=]{40})["']/gi,
    severity: "critical",
    label: "AWS Secret Access Key",
    secretGroup: 1,
  },
  {
    id: "github-pat",
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
    severity: "critical",
    label: "GitHub Personal Access Token",
    secretGroup: 0,
  },
  {
    id: "gitlab-token",
    regex: /\bglpat-[A-Za-z0-9_-]{20}\b/g,
    severity: "critical",
    label: "GitLab Personal Access Token",
    secretGroup: 0,
  },
  {
    id: "mollie-key",
    regex: /\b(?:live|test)_[A-Za-z0-9]{20,}\b/g,
    severity: "critical",
    label: "Mollie API key",
    secretGroup: 0,
  },
  {
    id: "private-key-block",
    regex: /-----BEGIN (?:RSA|EC|DSA|OPENSSH|ENCRYPTED|PRIVATE)(?: PRIVATE)? KEY/g,
    severity: "critical",
    label: "Private key block",
  },
  {
    id: "generic-credential-assignment",
    regex: /(password|api[_-]?key|secret|token|bearer)\s*[:=]\s*["']([A-Za-z0-9+/=_-]{24,})["']/gi,
    severity: "critical",
    label: "Hardcoded credential assignment",
    secretGroup: 2,
  },
];

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  missing: boolean;
}

interface PartResult {
  findings: RawSecurityFinding[];
  raw?: unknown;
  fallback: boolean;
  error?: string;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : "unknown error";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined;
}

function normalizeSeverity(raw: unknown): Severity {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if (s === "critical") return "critical";
  if (s === "high" || s === "error") return "high";
  if (s === "medium" || s === "moderate" || s === "warning") return "medium";
  if (s === "low" || s === "note" || s === "info" || s === "none") return "low";
  return "low";
}

function safeParseJson(text: string): unknown {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstObj = trimmed.indexOf("{");
    const firstArr = trimmed.indexOf("[");
    let start = -1;
    if (firstObj === -1) start = firstArr;
    else if (firstArr === -1) start = firstObj;
    else start = Math.min(firstObj, firstArr);
    if (start === -1) return undefined;
    const lastObj = trimmed.lastIndexOf("}");
    const lastArr = trimmed.lastIndexOf("]");
    const end = Math.max(lastObj, lastArr);
    if (end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  return env;
}

async function safeAll(a: Promise<string>, b: Promise<string>): Promise<[string, string]> {
  const [x, y] = await Promise.all([a.catch(() => ""), b.catch(() => "")]);
  return [x ?? "", y ?? ""];
}

function trySpawn(cmd: string[], cwd: string) {
  try {
    const proc = Bun.spawn({
      cmd,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv(),
    });
    return { ok: true as const, proc };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}

async function runCommand(
  cmd: string[],
  cwd: string,
  timeoutMs = SNYK_TIMEOUT_MS,
): Promise<CommandResult> {
  const spawned = trySpawn(cmd, cwd);
  if (!spawned.ok) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: spawned.error,
      timedOut: false,
      missing: true,
    };
  }
  const proc = spawned.proc;
  const stdoutP = new Response(proc.stdout).text();
  const stderrP = new Response(proc.stderr).text();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const exitP = proc.exited.then((code) => ({ status: "exited" as const, code }));

  let outcome: { status: "exited"; code: number | undefined } | "timeout";
  try {
    outcome = await Promise.race([exitP, timeoutP]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (outcome === "timeout") {
    try {
      proc.kill();
    } catch {
      /* noop */
    }
    const [stdout, stderr] = await safeAll(stdoutP, stderrP);
    return { exitCode: -1, stdout, stderr, timedOut: true, missing: false };
  }

  const [stdout, stderr] = await safeAll(stdoutP, stderrP);
  return {
    exitCode: outcome.code ?? 0,
    stdout,
    stderr,
    timedOut: false,
    missing: false,
  };
}

function isAuthFailure(result: CommandResult, parsed: unknown): boolean {
  const candidate =
    parsed && typeof parsed === "object" ? (parsed as { error?: unknown }).error : undefined;
  if (typeof candidate === "string" && AUTH_HINT_RE.test(candidate)) return true;
  if (AUTH_HINT_RE.test(result.stderr)) return true;
  return false;
}

function mapDepFindings(parsed: unknown): RawSecurityFinding[] {
  const out: RawSecurityFinding[] = [];
  const projects = Array.isArray(parsed) ? parsed : [parsed];
  for (const proj of projects) {
    if (!proj || typeof proj !== "object") continue;
    const vulns = (proj as { vulnerabilities?: unknown }).vulnerabilities;
    if (!Array.isArray(vulns)) continue;
    for (const v of vulns) {
      if (!v || typeof v !== "object") continue;
      const o = v as Record<string, unknown>;
      const fromArr = Array.isArray(o.from) ? (o.from as unknown[]) : undefined;
      const fromSecond = fromArr?.[1];
      const fromVersion =
        typeof fromSecond === "string" ? (fromSecond.split("@").pop() ?? undefined) : undefined;
      const fixInfo = o.fixInfo as Record<string, unknown> | undefined;
      out.push({
        kind: "dep",
        severity: normalizeSeverity(o.severity),
        package: str(o.packageName) ?? str(o.name),
        vulnVersion: str(o.version),
        fixedVersion: str(fixInfo?.version) ?? str(fromVersion),
        message: str(o.title) ?? str(o.name) ?? "Vulnerable dependency",
        rule: str(o.id),
      });
    }
  }
  return out;
}

function mapSastFindings(parsed: unknown): RawSecurityFinding[] {
  const out: RawSecurityFinding[] = [];
  if (!parsed || typeof parsed !== "object") return out;
  const root = parsed as { runs?: unknown };
  if (!Array.isArray(root.runs)) return out;

  const ruleMap = new Map<string, { title?: string; severity?: string }>();
  for (const run of root.runs) {
    if (!run || typeof run !== "object") continue;
    const driver = (run as { tool?: { driver?: Record<string, unknown> } }).tool?.driver;
    const rules = driver?.rules;
    if (Array.isArray(rules)) {
      for (const r of rules) {
        if (!r || typeof r !== "object") continue;
        const ro = r as Record<string, unknown>;
        const id = str(ro.id);
        if (!id) continue;
        const dc = ro.defaultConfiguration as { level?: unknown } | undefined;
        const props = ro.properties as { severity?: unknown } | undefined;
        ruleMap.set(id, {
          title: str(ro.title) ?? str((ro.shortDescription as { text?: unknown })?.text),
          severity: str(props?.severity) ?? str(dc?.level),
        });
      }
    }

    const results = (run as { results?: unknown }).results;
    if (!Array.isArray(results)) continue;
    for (const res of results) {
      if (!res || typeof res !== "object") continue;
      const r = res as Record<string, unknown>;
      const ruleId = str(r.ruleId);
      const loc = Array.isArray(r.locations) ? (r.locations as unknown[])[0] : undefined;
      const phys = (loc as { physicalLocation?: Record<string, unknown> })?.physicalLocation;
      const artifact = phys?.artifactLocation as { uri?: unknown } | undefined;
      const region = phys?.region as { startLine?: unknown } | undefined;
      const msgText = (r.message as { text?: unknown })?.text;
      const ruleInfo = ruleId ? ruleMap.get(ruleId) : undefined;
      out.push({
        kind: "sast",
        severity: normalizeSeverity(r.severity ?? r.level ?? ruleInfo?.severity),
        file: str(artifact?.uri),
        line: num(region?.startLine),
        rule: ruleId,
        message: str(msgText) ?? str(ruleInfo?.title) ?? "Static analysis finding",
      });
    }
  }
  return out;
}

async function runSnykDeps(repoPath: string): Promise<PartResult> {
  const result = await runCommand(["snyk", "test", "--json"], repoPath);
  if (result.missing) {
    return { findings: [], fallback: true, error: `snyk binary missing: ${result.stderr}` };
  }
  if (result.timedOut) {
    return { findings: [], fallback: true, error: "snyk test timed out" };
  }
  const parsed = safeParseJson(result.stdout);
  if (isAuthFailure(result, parsed)) {
    return { findings: [], fallback: true, error: "snyk auth required" };
  }
  if (parsed === undefined) {
    return {
      findings: [],
      raw: result.stdout,
      fallback: false,
      error: result.stdout ? undefined : `snyk test parse failure (exit ${result.exitCode})`,
    };
  }
  return { findings: mapDepFindings(parsed), raw: parsed, fallback: false };
}

async function runSnykSast(repoPath: string): Promise<PartResult> {
  const result = await runCommand(["snyk", "code", "test", "--json"], repoPath);
  if (result.missing) {
    return { findings: [], fallback: true, error: `snyk binary missing: ${result.stderr}` };
  }
  if (result.timedOut) {
    return { findings: [], fallback: true, error: "snyk code timed out" };
  }
  const parsed = safeParseJson(result.stdout);
  if (isAuthFailure(result, parsed)) {
    return { findings: [], fallback: true, error: "snyk auth required" };
  }
  if (parsed === undefined) {
    return {
      findings: [],
      raw: result.stdout,
      fallback: false,
      error: result.stdout ? undefined : `snyk code parse failure (exit ${result.exitCode})`,
    };
  }
  return { findings: mapSastFindings(parsed), raw: parsed, fallback: false };
}

export async function runSnykScan(repoPath: string): Promise<SnykResult> {
  const [depPart, sastPart] = await Promise.all([runSnykDeps(repoPath), runSnykSast(repoPath)]);

  if (depPart.fallback && sastPart.fallback) {
    return loadFixture();
  }

  const fix = depPart.fallback || sastPart.fallback ? loadFixture() : null;

  return {
    ok: true,
    depFindings: depPart.fallback && fix ? fix.depFindings : depPart.findings,
    sastFindings: sastPart.fallback && fix ? fix.sastFindings : sastPart.findings,
    rawDep: depPart.raw ?? (depPart.fallback && fix ? fix.rawDep : undefined),
    rawSast: sastPart.raw ?? (sastPart.fallback && fix ? fix.rawSast : undefined),
    source: "snyk-cli",
    error: [depPart.error, sastPart.error].filter(Boolean).join("; ") || undefined,
  };
}

function shouldSkipPath(relPath: string): boolean {
  const parts = relPath.split("/");
  for (const p of parts) {
    if (SKIP_DIRS.has(p)) return true;
  }
  const base = parts[parts.length - 1] ?? relPath;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = base.slice(dot).toLowerCase();
  return BINARY_EXTS.has(ext);
}

function isBinaryContent(content: string): boolean {
  const slice = content.slice(0, 8192);
  return slice.includes("\0");
}

function redact(secret: string): string {
  const prefix = secret.slice(0, 4);
  return `${prefix}…<redacted>`;
}

function buildSecretMessage(pattern: SecretPattern, match: RegExpExecArray): string {
  const groupIdx = pattern.secretGroup;
  if (groupIdx !== undefined && match[groupIdx]) {
    return `${pattern.label}: ${redact(match[groupIdx])}`;
  }
  return pattern.label;
}

function scanLine(
  line: string,
  file: string,
  lineNumber: number,
  seen: Set<string>,
): RawSecurityFinding[] {
  const found: RawSecurityFinding[] = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let m = pattern.regex.exec(line);
    while (m !== null) {
      const message = buildSecretMessage(pattern, m);
      const key = `${file}:${lineNumber}:${pattern.id}:${message}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({
          kind: "secret",
          severity: pattern.severity,
          file,
          line: lineNumber,
          message,
          rule: pattern.id,
        });
      }
      if (m.index === pattern.regex.lastIndex) pattern.regex.lastIndex += 1;
      m = pattern.regex.exec(line);
    }
  }
  return found;
}

async function walkFiles(repoPath: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*");
  const out: string[] = [];
  for await (const path of glob.scan({ cwd: repoPath, absolute: false, dot: true })) {
    if (shouldSkipPath(path)) continue;
    out.push(path);
  }
  return out;
}

export async function runSecretScan(repoPath: string): Promise<RawSecurityFinding[]> {
  const findings: RawSecurityFinding[] = [];
  const seen = new Set<string>();
  let paths: string[];
  try {
    paths = await walkFiles(repoPath);
  } catch {
    return [];
  }

  for (const relPath of paths) {
    if (findings.length >= SECRET_MAX_FINDINGS) break;

    let content = "";
    try {
      const f = Bun.file(`${repoPath}/${relPath}`);
      if (f.size > SECRET_MAX_FILE_BYTES) continue;
      content = await f.text();
    } catch {
      continue;
    }
    if (!content) continue;
    if (isBinaryContent(content)) continue;

    const lines = content.split("\n");
    const lineCap = Math.min(lines.length, 100_000);
    for (let i = 0; i < lineCap; i += 1) {
      if (findings.length >= SECRET_MAX_FINDINGS) break;
      const line = lines[i];
      if (!line) continue;
      const lineFindings = scanLine(line, relPath, i + 1, seen);
      for (const f of lineFindings) {
        findings.push(f);
        if (findings.length >= SECRET_MAX_FINDINGS) break;
      }
    }
  }
  return findings;
}
