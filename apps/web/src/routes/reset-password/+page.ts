import { redirectIfAuthenticated } from "$lib/session";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ url }) => {
  await redirectIfAuthenticated();
  return {
    token: url.searchParams.get("token") ?? "",
    error: url.searchParams.get("error") ?? "",
  };
};
