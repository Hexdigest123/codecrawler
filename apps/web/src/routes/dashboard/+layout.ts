import { authClient } from "@codecrawler/auth/client";
import { redirect } from "@sveltejs/kit";
import type { LayoutLoad } from "./$types";

export const load: LayoutLoad = async () => {
  const { data: session } = await authClient.getSession();
  if (!session) {
    throw redirect(302, "/sign-in");
  }
  return { session };
};
