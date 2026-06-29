import { api } from "$lib/api";
import type { AdminTeam } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch }) => {
  const res = await api<{ items: AdminTeam[] }>("/api/admin/teams", undefined, fetch);
  return { teams: res.items };
};
