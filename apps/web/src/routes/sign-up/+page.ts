import { api } from "$lib/api";
import { redirectIfAuthenticated } from "$lib/session";
import type { SignupConfig } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch }) => {
  await redirectIfAuthenticated();
  let config: SignupConfig | null = null;
  try {
    config = await api<SignupConfig>("/api/signup-config", undefined, fetch);
  } catch {
    config = null;
  }
  return { config };
};
