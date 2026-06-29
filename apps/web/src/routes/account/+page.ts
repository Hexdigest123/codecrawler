import { api } from "$lib/api";
import { requireSession } from "$lib/session";
import type { MeResponse } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch }) => {
  const [me, session] = await Promise.all([
    api<MeResponse>("/api/me", undefined, fetch),
    requireSession(),
  ]);
  return { me, currentEmail: session.email };
};
