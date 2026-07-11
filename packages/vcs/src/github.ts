import { Octokit } from "@octokit/rest";
import { Webhooks } from "@octokit/webhooks";
import type {
  Diff,
  DiffFileStatus,
  PostReviewInput,
  PR,
  PullRequestListItem,
  VCSProvider,
  VcsAuth,
  VerifiedWebhook,
} from "./types";

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
