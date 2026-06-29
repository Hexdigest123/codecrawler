import { api } from "$lib/api";
import type { ApiKeyRow } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, fetch }) => {
  const keys = await api<ApiKeyRow[]>(`/api/teams/${params.id}/api-keys`, undefined, fetch);
  return { keys, teamId: params.id };
};
