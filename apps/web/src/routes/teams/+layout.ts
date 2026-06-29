import { requireSession } from "$lib/session";
import type { LayoutLoad } from "./$types";

export const load: LayoutLoad = async () => {
  await requireSession();
  return {};
};
