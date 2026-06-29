import { api } from "$lib/api";
import { requireSession } from "$lib/session";
import type { Member, TeamDetail } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, fetch }) => {
  const [team, members, me] = await Promise.all([
    api<TeamDetail>(`/api/teams/${params.id}`, undefined, fetch),
    api<Member[]>(`/api/teams/${params.id}/members`, undefined, fetch),
    requireSession(),
  ]);
  return { teamId: params.id, team, members, currentUserId: me.id };
};
