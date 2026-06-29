import { api } from "$lib/api";
import { requireSession } from "$lib/session";
import type { Invitation } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch }) => {
  await requireSession();
  const invitations = await api<Invitation[]>("/api/me/invitations", undefined, fetch);
  return { invitations };
};
