import { api } from "$lib/api";
import type { TeamDetail } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, fetch }) => {
  const team = await api<TeamDetail>(`/api/teams/${params.id}`, undefined, fetch);
  return { teamId: params.id, teamPlan: team.plan } as const;
};
