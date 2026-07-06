import { api } from "$lib/api";
import type { ApiKeyRow, TeamDetail } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, fetch }) => {
  const [team, keys] = await Promise.all([
    api<TeamDetail>(`/api/teams/${params.id}`, undefined, fetch),
    api<ApiKeyRow[]>(`/api/teams/${params.id}/api-keys`, undefined, fetch),
  ]);
  return { keys, teamId: params.id, team };
};
