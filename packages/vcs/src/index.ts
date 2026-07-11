import { GiteaProvider } from "./gitea";
import { GitHubProvider } from "./github";
import { GitlabProvider } from "./gitlab";
import type { VCSProvider, VcsAuth } from "./types";

export { GiteaProvider } from "./gitea";
export { GitHubProvider, verifyGitHubWebhook } from "./github";
export { GitlabProvider } from "./gitlab";
export type {
  Diff,
  DiffFile,
  DiffFileStatus,
  GhUser,
  PostReviewInput,
  PR,
  PullRequestListItem,
  ReviewComment,
  VCSProvider,
  VcsAuth,
  VerifiedWebhook,
} from "./types";
export { verifyGiteaWebhook, verifyGitlabWebhook } from "./webhooks";

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
