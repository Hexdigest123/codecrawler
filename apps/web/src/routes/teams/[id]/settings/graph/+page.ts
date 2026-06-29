import { api } from "$lib/api";
import type { AgentProfile, TeamDetail } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, fetch }) => {
  const team = await api<TeamDetail>(`/api/teams/${params.id}`, undefined, fetch);
  const profile = await api<AgentProfile>(
    `/api/teams/${params.id}/agent-profile`,
    undefined,
    fetch,
  ).catch(() => null);
  return { teamId: params.id, teamPlan: team.plan, profile } as const;
};
