import { redirectIfAuthenticated } from "$lib/session";
import type { PageLoad } from "./$types";

export const load: PageLoad = async () => {
  await redirectIfAuthenticated();
};
