import { api } from "$lib/api";
import type { BillingDetail, SignupConfig, TeamDetail } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, fetch }) => {
  const [team, billing, config] = await Promise.all([
    api<TeamDetail>(`/api/teams/${params.id}`, undefined, fetch),
    api<BillingDetail>(`/api/teams/${params.id}/billing`, undefined, fetch),
    api<SignupConfig>("/api/signup-config", undefined, fetch),
  ]);
  return { teamId: params.id, team, billing, paymentsEnabled: config.paymentsEnabled };
};
