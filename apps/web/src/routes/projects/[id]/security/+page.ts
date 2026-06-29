import { api } from "$lib/api";
import type { Project, ProjectPullsResponse, PullRequest, SecurityReportSummary } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, fetch }) => {
  const id = params.id;
  const [pullsRes, secRes] = await Promise.all([
    api<unknown>(`/api/projects/${id}/pulls`, undefined, fetch),
    api<unknown>(`/api/projects/${id}/security`, undefined, fetch),
  ]);

  let project: Project | null = null;
  let pulls: PullRequest[] = [];
  if (Array.isArray(pullsRes)) {
    pulls = pullsRes as PullRequest[];
  } else if (pullsRes && typeof pullsRes === "object") {
    const obj = pullsRes as Partial<ProjectPullsResponse> & {
      items?: PullRequest[];
    };
    project = obj.project ?? null;
    pulls = obj.pulls ?? obj.items ?? [];
  }

  let reports: SecurityReportSummary[] = [];
  if (Array.isArray(secRes)) {
    reports = secRes as SecurityReportSummary[];
  } else if (secRes && typeof secRes === "object") {
    const obj = secRes as { reports?: SecurityReportSummary[] };
    reports = obj.reports ?? [];
  }

  return { projectId: id, project, pulls, reports };
};
