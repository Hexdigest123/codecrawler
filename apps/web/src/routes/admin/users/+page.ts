import { api } from "$lib/api";
import type { AdminUser } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch }) => {
  const res = await api<{ items: AdminUser[] }>("/api/admin/users", undefined, fetch);
  return { users: res.items };
};
