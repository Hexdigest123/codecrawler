import { authClient } from "@codecrawler/auth/client";
import { redirect } from "@sveltejs/kit";
import { api } from "$lib/api";
import type { LayoutLoad } from "./$types";

export const load: LayoutLoad = async ({ fetch }) => {
  const { data: session } = await authClient.getSession();
  if (!session) {
    throw redirect(302, "/sign-in");
  }
  const me = await api<{ role?: string }>("/api/me", undefined, fetch);
  if (me.role !== "admin") {
    throw redirect(302, "/dashboard");
  }
  return { session };
};
