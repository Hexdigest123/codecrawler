import { ApiError, api } from "$lib/api";
import type { SsoConfig, TeamDetail } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, fetch }) => {
  const team = await api<TeamDetail>(`/api/teams/${params.id}`, undefined, fetch);
  let sso: SsoConfig | null = null;
  let needsUpgrade = false;
  try {
    sso = await api<SsoConfig | null>(`/api/teams/${params.id}/sso`, undefined, fetch);
  } catch (err) {
    if (err instanceof ApiError && err.status === 403 && err.code === "plan_required") {
      needsUpgrade = true;
    } else {
      throw err;
    }
  }
  return { teamId: params.id, team, sso, needsUpgrade };
};
