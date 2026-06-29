import { api } from "$lib/api";
import type { AdminStats } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch }) => {
  const stats = await api<AdminStats>("/api/admin/stats", undefined, fetch);
  return { stats };
};
