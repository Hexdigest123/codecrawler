import { authClient } from "@codecrawler/auth/client";
import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const load: PageLoad = async () => {
  const { data: session } = await authClient.getSession();
  if (session) {
    throw redirect(302, "/dashboard");
  }
  return { session };
};
