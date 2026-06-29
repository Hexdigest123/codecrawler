import { api } from "$lib/api";
import type { Project, TeamDetail } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, fetch }) => {
  const [team, projects] = await Promise.all([
    api<TeamDetail>(`/api/teams/${params.id}`, undefined, fetch),
    api<Project[]>(`/api/teams/${params.id}/projects`, undefined, fetch),
  ]);
  return { team, projects };
};
