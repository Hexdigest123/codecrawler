import { Gitlab } from "@gitbeaker/rest";
import type {
  Diff,
  DiffFile,
  DiffFileStatus,
  PostReviewInput,
  PR,
  PullRequestListItem,
  VCSProvider,
  VcsAuth,
} from "./types";

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
