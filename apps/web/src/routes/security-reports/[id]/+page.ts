import { api } from "$lib/api";
import { requireSession } from "$lib/session";
import type { SecurityReportDetail } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, fetch }) => {
  await requireSession();
  const report = await api<SecurityReportDetail>(
    `/api/security-reports/${params.id}`,
    undefined,
    fetch,
  );
  return { id: params.id, report };
};
