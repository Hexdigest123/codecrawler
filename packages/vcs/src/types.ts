// Shared types for the VCS provider abstraction.

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

export interface VerifiedWebhook {
  name: string;
  payload: Record<string, unknown>;
}
