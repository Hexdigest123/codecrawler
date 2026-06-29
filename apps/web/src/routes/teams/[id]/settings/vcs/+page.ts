import { api } from "$lib/api";
import type { TeamDetail } from "$lib/types";
import type { PageLoad } from "./$types";

export interface VcsConnection {
  id: string;
  provider: string;
  kind?: string | null;
  createdAt?: string | null;
}

export const load: PageLoad = async ({ params, fetch }) => {
  const [team, connections] = await Promise.all([
    api<TeamDetail>(`/api/teams/${params.id}`, undefined, fetch),
    api<VcsConnection[]>(`/api/teams/${params.id}/vcs-connections`, undefined, fetch),
  ]);
  return { teamId: params.id, team, connections };
};
