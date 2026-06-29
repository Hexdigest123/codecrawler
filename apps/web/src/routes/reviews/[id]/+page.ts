import { api } from "$lib/api";
import type { ReviewResponse } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, fetch }) => {
  const detail = await api<ReviewResponse>(`/api/reviews/${params.id}`, undefined, fetch);
  return { id: params.id, detail };
};
