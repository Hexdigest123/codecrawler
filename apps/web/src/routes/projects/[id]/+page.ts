import { api } from "$lib/api";
import type {
  AgentProfile,
  OpenPullRequestsResponse,
  Project,
  ProjectReviewsResponse,
  PullRequest,
} from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, fetch }) => {
  const [pullsRes, openRes, reviewsRes] = await Promise.all([
    api<unknown>(`/api/projects/${params.id}/pulls`, undefined, fetch),
    api<OpenPullRequestsResponse>(
      `/api/projects/${params.id}/pulls/open?state=open`,
      undefined,
      fetch,
    ).catch(() => ({
      items: [],
    })),
    api<ProjectReviewsResponse>(`/api/projects/${params.id}/reviews`, undefined, fetch).catch(
      () => ({
        items: [],
      }),
    ),
  ]);

  let project: Project | null = null;
  let pulls: PullRequest[] = [];
  if (Array.isArray(pullsRes)) {
    pulls = pullsRes as PullRequest[];
  } else if (pullsRes && typeof pullsRes === "object") {
    const obj = pullsRes as { project?: Project; pulls?: PullRequest[] };
    project = obj.project ?? null;
    pulls = obj.pulls ?? [];
  }

  // Pull the team's default review depth so the per-review selector seeds from
  // the team setting: the team default applies unless the user overrides it
  // for a single run. Best-effort — fall back to null (→ "quick" in the UI).
  let defaultDepth: AgentProfile["defaultDepth"] = null;
  if (project?.orgId) {
    defaultDepth = await api<AgentProfile>(
      `/api/teams/${project.orgId}/agent-profile`,
      undefined,
      fetch,
    )
      .then((p) => p.defaultDepth ?? null)
      .catch(() => null);
  }

  return {
    projectId: params.id,
    project,
    pulls,
    openPulls: openRes.items ?? [],
    recentReviews: reviewsRes.items ?? [],
    defaultDepth,
  };
};
