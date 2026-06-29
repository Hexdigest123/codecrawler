import { api } from "$lib/api";
import type { MeResponse } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch }) => {
  const me = await api<MeResponse>("/api/me", undefined, fetch);
  return { me };
};
