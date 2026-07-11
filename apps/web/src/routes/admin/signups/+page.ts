import { api } from "$lib/api";
import type { SignupConfig, SignupRequestRow } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch }) => {
  const [config, requests] = await Promise.all([
    api<SignupConfig>("/api/admin/settings", undefined, fetch),
    api<{ items: SignupRequestRow[] }>(
      "/api/admin/signup-requests?status=pending",
      undefined,
      fetch,
    ),
  ]);
  return { config, requests: requests.items };
};
