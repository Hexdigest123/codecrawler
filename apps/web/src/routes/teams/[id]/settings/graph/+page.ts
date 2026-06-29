import { api } from "$lib/api";
import type { TeamDetail } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, url, fetch }) => {
  const team = await api<TeamDetail>(`/api/teams/${params.id}`, undefined, fetch);
  const graphType = url.searchParams.get("type") === "security" ? "security" : "pr_review";
  return { teamId: params.id, teamPlan: team.plan, graphType } as const;
};
