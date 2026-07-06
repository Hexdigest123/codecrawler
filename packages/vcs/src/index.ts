import { createHmac, timingSafeEqual } from "node:crypto";
import { Gitlab } from "@gitbeaker/rest";
import { Octokit } from "@octokit/rest";
import { Webhooks } from "@octokit/webhooks";

export interface VcsAuth {
  provider: "github" | "gitlab" | "gitea";
  token: string;
  refreshToken?: string;
  /**
   * Self-hosted base URL for Gitea or GitLab (empty/undefined for github.com
   * and gitlab.com). GitHub always targets the public api.github.com.
   */
  baseUrl?: string;
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

/**
 * Retries a GitHub write on secondary-rate-limit (403/429) responses, honoring
 * the Retry-After header (capped) with exponential backoff as a fallback. The
 * postReview flow can issue two POSTs to /pulls/{n}/reviews in quick
 * succession (full review -> body-only fallback), which regularly trips this
 * limit; without retrying, the walkthrough never reaches the PR.
 */
async function withGitHubRateLimitRetry<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const e = err as { status?: number; message?: string };
      const status = e?.status;
      const isRateLimit =
        status === 429 || (status === 403 && /secondary rate limit/i.test(e?.message ?? ""));
      if (!isRateLimit) throw err;
      const headers = (err as { response?: { headers?: Record<string, string> } })?.response
        ?.headers;
      const retryAfterRaw =
        headers?.["retry-after"] ?? headers?.["Retry-After"] ?? headers?.["x-ratelimit-reset"];
      const retryAfter = Number(retryAfterRaw);
      const waitSec =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(60, retryAfter)
          : Math.min(30, 2 ** attempt);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
    }
  }
  throw lastErr;
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
    const comments = review.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side ?? "RIGHT",
      body: c.body,
    }));
    // GitHub's createReview submits the body and all inline comments in a
    // single request — if any comment targets a line outside the diff hunks
    // (which reviewer agents regularly produce), the whole call 422s and the
    // walkthrough never reaches the PR. Mirror the GitLab/Gitea adapters by
    // attempting the full review first, then falling back to a body-only
    // review so the summary always lands.
    if (comments.length > 0) {
      try {
        await withGitHubRateLimitRetry(() =>
          this.octokit.pulls.createReview({
            owner,
            repo,
            pull_number: n,
            event,
            body: review.summary,
            comments,
          }),
        );
        return;
      } catch {
        // Inline comments rejected (422) — retry below as a body-only review.
        // Space out the second POST; issuing two content-creating requests to
        // /pulls/{n}/reviews within ~1s trips GitHub's secondary rate limit.
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    await withGitHubRateLimitRetry(() =>
      this.octokit.pulls.createReview({
        owner,
        repo,
        pull_number: n,
        event,
        body: review.summary,
      }),
    );
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
  switch (auth.provider) {
    case "github":
      return new GitHubProvider(auth);
    case "gitlab":
      return new GitlabProvider(auth);
    case "gitea":
      return new GiteaProvider(auth);
    default:
      throw new Error(`unsupported vcs provider: ${auth.provider as string}`);
  }
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
    // GitLab can be self-hosted (GitLab CE/EE on a custom domain). When a
    // baseUrl is provided, route the gitbeaker client at that instance;
    // otherwise it defaults to https://gitlab.com.
    const raw = (auth.baseUrl ?? "").trim();
    const host = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    this.gitlab = new Gitlab(host ? { host, token: auth.token } : { token: auth.token });
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
