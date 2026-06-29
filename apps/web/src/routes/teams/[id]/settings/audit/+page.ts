import { ApiError, api } from "$lib/api";
import type { AuditEntry, TeamDetail } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, fetch }) => {
  const team = await api<TeamDetail>(`/api/teams/${params.id}`, undefined, fetch);
  let entries: AuditEntry[] = [];
  let forbidden = false;
  try {
    entries = await api<AuditEntry[]>(`/api/teams/${params.id}/audit`, undefined, fetch);
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      forbidden = true;
    } else {
      throw err;
    }
  }
  return { teamId: params.id, team, entries, forbidden };
};
