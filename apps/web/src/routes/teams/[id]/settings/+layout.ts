import type { LayoutLoad } from "./$types";

export const load: LayoutLoad = async ({ params }) => {
  return { teamId: params.id };
};
