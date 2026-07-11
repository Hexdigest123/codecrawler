import type {
  Diff,
  DiffFileStatus,
  PostReviewInput,
  PR,
  PullRequestListItem,
  VCSProvider,
  VcsAuth,
} from "./types";

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
