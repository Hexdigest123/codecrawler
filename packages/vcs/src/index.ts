import { createHmac, timingSafeEqual } from "node:crypto";
import { Gitlab } from "@gitbeaker/rest";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { Webhooks } from "@octokit/webhooks";

export interface VcsAuth {
  provider: "github" | "gitlab" | "gitea";
  token: string;
  refreshToken?: string;
  kind?: "oauth" | "github_app";
  baseUrl?: string;
  /**
   * For GitHub App auth: the installation id used to mint the token. When
   * present, `getVcsProvider` refreshes the token before constructing the
   * provider so a stale (1h-TTL) token carried through the queue doesn't 401.
   */
  installationId?: number;
}

export interface GhUser {
  login: string;
}

export interface PR {
  number: number;
  title: string;
  author: string;
  body: string | null;
  baseSha: string;
  headSha: string;
  state: "open" | "closed";
  files: string[];
  htmlUrl: string;
}

export type DiffFileStatus = "added" | "modified" | "removed" | "renamed";

export interface DiffFile {
  path: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  patch: string;
}

export interface Diff {
  files: DiffFile[];
}

export interface ReviewComment {
  path: string;
  line: number;
  side?: "LEFT" | "RIGHT";
  body: string;
}

export interface PostReviewInput {
  status: "approve" | "request_changes" | "comment";
  summary: string;
  comments: ReviewComment[];
}

export interface PullRequestListItem {
  number: number;
  title: string;
  author: string;
  state: "open" | "closed";
  headSha: string;
  baseSha: string;
  htmlUrl: string;
  updatedAt?: string;
}

export interface VCSProvider {
  getPullRequest(owner: string, repo: string, n: number): Promise<PR>;
  getDiff(owner: string, repo: string, n: number, base?: string, head?: string): Promise<Diff>;
  getFile(owner: string, repo: string, path: string, ref: string): Promise<string>;
  postReview(owner: string, repo: string, n: number, review: PostReviewInput): Promise<void>;
  listRepos(): Promise<{ id: number; fullName: string; private: boolean }[]>;
  listPullRequests(
    owner: string,
    repo: string,
    opts?: { state?: "open" | "closed" | "all"; perPage?: number },
  ): Promise<PullRequestListItem[]>;
}

type GhStatus = "added" | "removed" | "modified" | "renamed" | "changed" | "copied" | string;

function mapStatus(status: GhStatus): DiffFileStatus {
  if (status === "added") return "added";
  if (status === "removed") return "removed";
  if (status === "renamed") return "renamed";
  return "modified";
}

export class GitHubProvider implements VCSProvider {
  private readonly octokit: Octokit;

  constructor(auth: VcsAuth) {
    this.octokit = new Octokit({ auth: auth.token });
  }

  async getPullRequest(owner: string, repo: string, n: number): Promise<PR> {
    const { data } = await this.octokit.pulls.get({ owner, repo, pull_number: n });
    const filesRes = await this.octokit.pulls.listFiles({ owner, repo, pull_number: n });
    const files = filesRes.data.map((f) => f.filename);
    return {
      number: data.number,
      title: data.title ?? "",
      author: data.user?.login ?? "",
      body: data.body ?? null,
      baseSha: data.base?.sha ?? "",
      headSha: data.head?.sha ?? "",
      state: data.state === "open" ? "open" : "closed",
      files,
      htmlUrl: data.html_url ?? "",
    };
  }

  async getDiff(
    owner: string,
    repo: string,
    n: number,
    base?: string,
    head?: string,
  ): Promise<Diff> {
    if (base && head) {
      const { data } = await this.octokit.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${base}...${head}`,
      });
      const files = (data.files ?? []).map((f) => ({
        path: f.filename,
        status: mapStatus(f.status as GhStatus),
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        patch: f.patch ?? "",
      }));
      return { files };
    }
    const { data } = await this.octokit.pulls.listFiles({ owner, repo, pull_number: n });
    const files = data.map((f) => ({
      path: f.filename,
      status: mapStatus(f.status as GhStatus),
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      patch: f.patch ?? "",
    }));
    return { files };
  }

  async getFile(owner: string, repo: string, path: string, ref: string): Promise<string> {
    const { data } = await this.octokit.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || !("content" in data)) {
      return "";
    }
    const file = data as { content?: string; encoding?: string };
    if (!file.content) {
      return "";
    }
    return Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
  }

  async postReview(owner: string, repo: string, n: number, review: PostReviewInput): Promise<void> {
    const event =
      review.status === "approve"
        ? "APPROVE"
        : review.status === "request_changes"
          ? "REQUEST_CHANGES"
          : "COMMENT";
    await this.octokit.pulls.createReview({
      owner,
      repo,
      pull_number: n,
      event,
      body: review.summary,
      comments: review.comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: c.side ?? "RIGHT",
        body: c.body,
      })),
    });
  }

  async listRepos(): Promise<{ id: number; fullName: string; private: boolean }[]> {
    const repos = await this.octokit.paginate(this.octokit.repos.listForAuthenticatedUser, {
      per_page: 100,
    });
    return repos.map((r) => ({
      id: r.id,
      fullName: r.full_name ?? "",
      private: r.private ?? false,
    }));
  }

  async listPullRequests(
    owner: string,
    repo: string,
    opts: { state?: "open" | "closed" | "all"; perPage?: number } = {},
  ): Promise<PullRequestListItem[]> {
    const state = opts.state ?? "open";
    const perPage = Math.min(100, Math.max(1, opts.perPage ?? 30));
    const { data } = await this.octokit.pulls.list({
      owner,
      repo,
      state,
      per_page: perPage,
      sort: "updated",
      direction: "desc",
    });
    return data.map((p) => ({
      number: p.number,
      title: p.title ?? "",
      author: p.user?.login ?? "",
      state: p.state === "open" ? "open" : "closed",
      headSha: p.head?.sha ?? "",
      baseSha: p.base?.sha ?? "",
      htmlUrl: p.html_url ?? "",
      updatedAt: p.updated_at ?? undefined,
    }));
  }
}

export async function getVcsProvider(auth: VcsAuth): Promise<VCSProvider> {
  // Refresh GitHub App installation tokens at use-time so a token that aged
  // out in the queue is replaced before the first API call.
  let resolvedAuth = auth;
  if (auth.provider === "github" && auth.kind === "github_app" && auth.installationId) {
    try {
      const token = await getGitHubAppInstallationToken(auth.installationId);
      resolvedAuth = { ...auth, token };
    } catch (err) {
      console.warn(
        `[vcs] github app token refresh failed for installation ${auth.installationId}; falling back to carried token`,
        err,
      );
    }
  }
  switch (resolvedAuth.provider) {
    case "github":
      return new GitHubProvider(resolvedAuth);
    case "gitlab":
      return new GitlabProvider(resolvedAuth);
    case "gitea":
      return new GiteaProvider(resolvedAuth);
    default:
      throw new Error(`unsupported vcs provider: ${resolvedAuth.provider as string}`);
  }
}

// ----------------------------------------------------------------------------
// GitHub App auth
//
// The production path for GitHub reviews uses a GitHub App: a JWT signed with
// `GH_APP_PRIVATE_KEY` is exchanged for a per-installation access token (1h
// TTL), which is then passed to `Octokit` exactly like a PAT. Tokens are
// cached in-process until ~1 minute before expiry so we don't mint a new one
// on every request. `GH_TEST_PAT` remains ONLY as a local-dev escape hatch for
// when the App isn't installed (e.g. trying things out against a personal
// repo before installing the App).
// ----------------------------------------------------------------------------

interface GitHubAppConfig {
  appId?: string;
  privateKey?: string;
  clientId?: string;
  clientSecret?: string;
}

function readGitHubAppConfig(): GitHubAppConfig {
  return {
    appId: process.env.GH_APP_ID,
    privateKey: process.env.GH_APP_PRIVATE_KEY,
    clientId: process.env.GH_APP_CLIENT_ID,
    clientSecret: process.env.GH_APP_CLIENT_SECRET,
  };
}

export function hasGitHubAppConfig(): boolean {
  const c = readGitHubAppConfig();
  return Boolean(c.appId && c.privateKey);
}

/** Reformat a private key that may have been stored with literal `\n`. */
function parsePrivateKey(raw: string): string {
  if (raw.includes("-----BEGIN")) return raw;
  return raw.replace(/\\n/g, "\n");
}

interface CachedInstallationToken {
  token: string;
  expiresAt: number; // epoch ms
}

const installationTokenCache = new Map<number, CachedInstallationToken>();
const INSTALLATION_TOKEN_TTL_MS = 50 * 60 * 1000; // 50 min (tokens last 60)

function buildAppAuth() {
  const cfg = readGitHubAppConfig();
  if (!cfg.appId || !cfg.privateKey) {
    throw new Error(
      "GitHub App credentials not configured (GH_APP_ID / GH_APP_PRIVATE_KEY required)",
    );
  }
  return createAppAuth({
    appId: cfg.appId,
    privateKey: parsePrivateKey(cfg.privateKey),
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
  });
}

export async function getGitHubAppInstallationToken(installationId: number): Promise<string> {
  const cached = installationTokenCache.get(installationId);
  const now = Date.now();
  if (cached && cached.expiresAt - 60_000 > now) {
    return cached.token;
  }
  const auth = buildAppAuth();
  const res = await auth({ type: "installation", installationId });
  if (!res.token) {
    throw new Error(`failed to mint installation token for installation ${installationId}`);
  }
  let ttl = INSTALLATION_TOKEN_TTL_MS;
  if (res.expiresAt) {
    const parsed = Date.parse(res.expiresAt) - now;
    if (Number.isFinite(parsed) && parsed > 60_000) ttl = parsed;
  }
  installationTokenCache.set(installationId, { token: res.token, expiresAt: now + ttl });
  return res.token;
}

/**
 * Resolve the GitHub App installation id that owns a given repo, if any.
 * Uses the App JWT (not an installation token). Returns null when the App is
 * not installed on the repo, or when the App config is missing.
 */
export async function resolveGitHubInstallationForRepo(
  owner: string,
  name: string,
): Promise<number | null> {
  if (!hasGitHubAppConfig()) return null;
  try {
    const auth = buildAppAuth();
    const { token } = await auth({ type: "app" });
    const res = await fetch(`https://api.github.com/repos/${owner}/${name}/installation`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: number };
    return typeof data.id === "number" ? data.id : null;
  } catch (err) {
    console.warn(`[vcs] GitHub App installation lookup failed for ${owner}/${name}`, err);
    return null;
  }
}

export interface ResolveGitHubAuthOpts {
  /** From the webhook payload (`pull_request.installation.id`). */
  installationId?: number;
  /** Used to look the installation up when no id is known (manual UI path). */
  owner?: string;
  name?: string;
  /** PAT fallback from vcs_connections, or GH_TEST_PAT for local dev. */
  fallbackToken?: string;
}

/**
 * High-level GitHub auth resolver. Tries App → fallbackToken → null, in that
 * order. Callers should treat `null` as "no credentials; reject the run with
 * a clear error".
 */
export async function resolveGitHubAuth(opts: ResolveGitHubAuthOpts): Promise<VcsAuth | null> {
  if (opts.installationId !== undefined && hasGitHubAppConfig()) {
    try {
      const token = await getGitHubAppInstallationToken(opts.installationId);
      return { provider: "github", token, kind: "github_app" };
    } catch (err) {
      console.warn(`[vcs] installation token mint failed for ${opts.installationId}`, err);
    }
  }
  if (opts.owner && opts.name && hasGitHubAppConfig()) {
    const installationId = await resolveGitHubInstallationForRepo(opts.owner, opts.name);
    if (installationId) {
      try {
        const token = await getGitHubAppInstallationToken(installationId);
        return { provider: "github", token, kind: "github_app" };
      } catch (err) {
        console.warn(
          `[vcs] installation token mint failed for ${opts.owner}/${opts.name} (installation ${installationId})`,
          err,
        );
      }
    }
  }
  if (opts.fallbackToken) {
    return { provider: "github", token: opts.fallbackToken, kind: "oauth" };
  }
  return null;
}

export interface VerifiedWebhook {
  name: string;
  payload: Record<string, unknown>;
}

export async function verifyGitHubWebhook(
  secret: string,
  headers: Record<string, string>,
  rawBody: string,
): Promise<VerifiedWebhook | null> {
  const id = headers["x-github-delivery"];
  const name = headers["x-github-event"];
  const signature = headers["x-hub-signature-256"];
  if (!secret || !id || !name || !signature) {
    return null;
  }
  const webhooks = new Webhooks({ secret });
  try {
    await webhooks.verifyAndReceive({ id, name, signature, payload: rawBody });
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    return { name, payload };
  } catch {
    return null;
  }
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function findHeader(
  headers: Record<string, string>,
  match: (lowerKey: string) => boolean,
): string | undefined {
  for (const key of Object.keys(headers)) {
    if (match(key.toLowerCase())) return headers[key];
  }
  return undefined;
}

interface GitlabDiffRefs {
  base_sha?: string;
  start_sha?: string;
  head_sha?: string;
  base_commit_sha?: string;
  start_commit_sha?: string;
  head_commit_sha?: string;
}

interface GitlabUser {
  username?: string;
  name?: string;
}

interface GitlabMergeRequest {
  iid?: number;
  title?: string;
  description?: string | null;
  state?: string;
  author?: GitlabUser;
  diff_refs?: GitlabDiffRefs;
  web_url?: string;
  updated_at?: string;
  sha?: string;
}

interface GitlabChange {
  old_path?: string;
  new_path?: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
  diff?: string;
}

interface GitlabRepositoryFile {
  content?: string;
  encoding?: string;
}

interface GitlabProject {
  id: number;
  path_with_namespace?: string;
  visibility?: string;
}

function countDiffLines(diff: string | undefined, marker: "+" | "-"): number {
  if (!diff) return 0;
  let count = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith(marker) && !line.startsWith(`${marker}${marker}`)) count++;
  }
  return count;
}

function mapGitlabFile(change: GitlabChange): DiffFile {
  let status: DiffFileStatus = "modified";
  if (change.new_file) status = "added";
  else if (change.deleted_file) status = "removed";
  else if (change.renamed_file) status = "renamed";
  return {
    path: change.new_path ?? change.old_path ?? "",
    status,
    additions: countDiffLines(change.diff, "+"),
    deletions: countDiffLines(change.diff, "-"),
    patch: change.diff ?? "",
  };
}

export class GitlabProvider implements VCSProvider {
  private readonly gitlab: Gitlab;

  constructor(auth: VcsAuth) {
    this.gitlab = new Gitlab({ token: auth.token });
  }

  async getPullRequest(owner: string, repo: string, n: number): Promise<PR> {
    const projectId = `${owner}/${repo}`;
    const mr = (await this.gitlab.MergeRequests.show(
      projectId,
      n,
    )) as unknown as GitlabMergeRequest;
    const refs = mr.diff_refs;
    return {
      number: mr.iid ?? n,
      title: mr.title ?? "",
      author: mr.author?.username ?? mr.author?.name ?? "",
      body: mr.description ?? null,
      baseSha: refs?.base_sha ?? refs?.base_commit_sha ?? "",
      headSha: refs?.head_sha ?? refs?.head_commit_sha ?? "",
      state: mr.state === "opened" ? "open" : "closed",
      files: [],
      htmlUrl: mr.web_url ?? "",
    };
  }

  async getDiff(owner: string, repo: string, n: number): Promise<Diff> {
    const projectId = `${owner}/${repo}`;
    const changes = (await this.gitlab.MergeRequests.allDiffs(
      projectId,
      n,
    )) as unknown as GitlabChange[];
    return { files: (changes ?? []).map((c) => mapGitlabFile(c)) };
  }

  async getFile(owner: string, repo: string, path: string, ref: string): Promise<string> {
    const projectId = `${owner}/${repo}`;
    const file = (await this.gitlab.RepositoryFiles.show(
      projectId,
      path,
      ref,
    )) as unknown as GitlabRepositoryFile;
    if (!file.content) return "";
    const encoding = (file.encoding ?? "").toLowerCase();
    if (encoding !== "base64") return file.content;
    try {
      return Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
    } catch {
      return "";
    }
  }

  async postReview(owner: string, repo: string, n: number, review: PostReviewInput): Promise<void> {
    const projectId = `${owner}/${repo}`;
    await this.gitlab.MergeRequestNotes.create(projectId, n, review.summary);
    if (review.comments.length === 0) return;
    let refs: GitlabDiffRefs | undefined;
    try {
      const mr = (await this.gitlab.MergeRequests.show(
        projectId,
        n,
      )) as unknown as GitlabMergeRequest;
      refs = mr.diff_refs;
    } catch {
      refs = undefined;
    }
    for (const comment of review.comments) {
      await this.gitlab.MergeRequestDiscussions.create(projectId, n, comment.body, {
        position: {
          positionType: "text",
          baseSha: refs?.base_sha ?? refs?.base_commit_sha ?? "",
          startSha: refs?.start_sha ?? refs?.start_commit_sha ?? "",
          headSha: refs?.head_sha ?? refs?.head_commit_sha ?? "",
          newPath: comment.path,
          newLine: String(comment.line),
        },
      }).catch(() => undefined);
    }
  }

  async listRepos(): Promise<{ id: number; fullName: string; private: boolean }[]> {
    const projects = (await this.gitlab.Projects.all({
      membership: true,
      perPage: 100,
    })) as unknown as GitlabProject[];
    return projects.map((p) => ({
      id: p.id,
      fullName: p.path_with_namespace ?? "",
      private: p.visibility !== "public",
    }));
  }

  async listPullRequests(
    owner: string,
    repo: string,
    opts: { state?: "open" | "closed" | "all"; perPage?: number } = {},
  ): Promise<PullRequestListItem[]> {
    const projectId = `${owner}/${repo}`;
    const wantState = opts.state ?? "open";
    // GitLab's `state` enum is opened|closed|locked|merged; "all" means omit.
    const stateFilter: { state?: "opened" | "closed" | "locked" | "merged" } =
      wantState === "open"
        ? { state: "opened" }
        : wantState === "closed"
          ? { state: "closed" }
          : {};
    const mrs = (await this.gitlab.MergeRequests.all({
      projectId,
      ...stateFilter,
      orderBy: "updated_at",
      sort: "desc",
      perPage: Math.min(100, Math.max(1, opts.perPage ?? 30)),
      maxPages: 1,
    })) as unknown as GitlabMergeRequest[];
    return mrs.map((mr) => ({
      number: mr.iid ?? 0,
      title: mr.title ?? "",
      author: mr.author?.username ?? mr.author?.name ?? "",
      state: mr.state === "opened" ? "open" : "closed",
      headSha: mr.sha ?? "",
      baseSha: mr.diff_refs?.base_sha ?? mr.diff_refs?.base_commit_sha ?? "",
      htmlUrl: mr.web_url ?? "",
      updatedAt: mr.updated_at,
    }));
  }
}

interface GiteaPullRequest {
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  user?: { login?: string };
  base?: { sha?: string };
  head?: { sha?: string };
  html_url?: string;
  updated_at?: string;
}

interface GiteaPullFile {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

interface GiteaContent {
  content?: string;
  encoding?: string;
}

interface GiteaRepo {
  id?: number;
  full_name?: string;
  private?: boolean;
}

interface GiteaSearchResult {
  data?: GiteaRepo[];
}

function mapGiteaStatus(status: string | undefined): DiffFileStatus {
  const s = (status ?? "").toLowerCase();
  if (s.includes("add")) return "added";
  if (s.includes("delet") || s.includes("remov")) return "removed";
  if (s.includes("renam")) return "renamed";
  return "modified";
}

export class GiteaProvider implements VCSProvider {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(auth: VcsAuth) {
    const raw = (auth.baseUrl ?? "").trim();
    this.baseUrl = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    this.token = auth.token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.baseUrl) throw new Error("gitea provider requires auth.baseUrl");
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `token ${this.token}`,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, init);
    if (!res.ok) throw new Error(`gitea ${method} ${path} -> ${res.status}`);
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  async getPullRequest(owner: string, repo: string, n: number): Promise<PR> {
    const pr = await this.request<GiteaPullRequest>("GET", `/repos/${owner}/${repo}/pulls/${n}`);
    return {
      number: pr.number ?? n,
      title: pr.title ?? "",
      author: pr.user?.login ?? "",
      body: pr.body ?? null,
      baseSha: pr.base?.sha ?? "",
      headSha: pr.head?.sha ?? "",
      state: pr.state === "open" ? "open" : "closed",
      files: [],
      htmlUrl: pr.html_url ?? "",
    };
  }

  async getDiff(owner: string, repo: string, n: number): Promise<Diff> {
    const files = await this.request<GiteaPullFile[]>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${n}/files`,
    );
    const list = Array.isArray(files) ? files : [];
    return {
      files: list.map((f) => ({
        path: f.filename ?? "",
        status: mapGiteaStatus(f.status),
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        patch: f.patch ?? "",
      })),
    };
  }

  async getFile(owner: string, repo: string, path: string, ref: string): Promise<string> {
    const file = await this.request<GiteaContent>(
      "GET",
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
    );
    if (!file.content) return "";
    const encoding = (file.encoding ?? "").toLowerCase();
    if (encoding !== "base64") return file.content;
    try {
      return Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
    } catch {
      return "";
    }
  }

  async postReview(owner: string, repo: string, n: number, review: PostReviewInput): Promise<void> {
    await this.request("POST", `/repos/${owner}/${repo}/issues/${n}/comments`, {
      body: review.summary,
    });
    if (review.comments.length === 0) return;
    const event =
      review.status === "approve"
        ? "APPROVED"
        : review.status === "request_changes"
          ? "REQUEST_CHANGES"
          : "COMMENT";
    await this.request("POST", `/repos/${owner}/${repo}/pulls/${n}/reviews`, {
      body: review.summary,
      event,
      comments: review.comments.map((c) => ({ path: c.path, line: c.line, body: c.body })),
    }).catch(() => undefined);
  }

  async listRepos(): Promise<{ id: number; fullName: string; private: boolean }[]> {
    const result = await this.request<GiteaSearchResult>(
      "GET",
      "/repos/search?limit=50&exclusive=true",
    );
    const repos = Array.isArray(result?.data) ? result.data : [];
    return repos.map((r) => ({
      id: r.id ?? 0,
      fullName: r.full_name ?? "",
      private: r.private ?? false,
    }));
  }

  async listPullRequests(
    owner: string,
    repo: string,
    opts: { state?: "open" | "closed" | "all"; perPage?: number } = {},
  ): Promise<PullRequestListItem[]> {
    const state = opts.state ?? "open";
    const limit = Math.min(50, Math.max(1, opts.perPage ?? 30));
    const list = await this.request<GiteaPullRequest[]>(
      "GET",
      `/repos/${owner}/${repo}/pulls?state=${state}&sort=updated&limit=${limit}&page=1`,
    );
    const items = Array.isArray(list) ? list : [];
    return items.map((pr) => ({
      number: pr.number ?? 0,
      title: pr.title ?? "",
      author: pr.user?.login ?? "",
      state: pr.state === "open" ? "open" : "closed",
      headSha: pr.head?.sha ?? "",
      baseSha: pr.base?.sha ?? "",
      htmlUrl: pr.html_url ?? "",
      updatedAt: pr.updated_at,
    }));
  }
}

function hmacSha256Hex(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export async function verifyGitlabWebhook(
  token: string,
  headers: Record<string, string>,
  rawBody: string,
): Promise<VerifiedWebhook | null> {
  const provided = getHeader(headers, "x-gitlab-token");
  if (!token || !provided || provided !== token) return null;
  const name = getHeader(headers, "x-gitlab-event") ?? "push";
  try {
    return { name, payload: JSON.parse(rawBody) as Record<string, unknown> };
  } catch {
    return null;
  }
}

export async function verifyGiteaWebhook(
  secret: string,
  headers: Record<string, string>,
  rawBody: string,
): Promise<VerifiedWebhook | null> {
  const signature = findHeader(
    headers,
    (k) => k.includes("gitea-signature") || k.includes("guitea-signature"),
  );
  if (!secret || !signature) return null;
  let expected: string;
  try {
    expected = hmacSha256Hex(secret, rawBody);
  } catch {
    return null;
  }
  if (!safeEqualHex(signature, expected)) return null;
  const name =
    getHeader(headers, "x-gitea-event") ?? getHeader(headers, "x-github-event") ?? "push";
  try {
    return { name, payload: JSON.parse(rawBody) as Record<string, unknown> };
  } catch {
    return null;
  }
}
