import { redirect } from "@sveltejs/kit";
import { api } from "$lib/api";
import { requireSession } from "$lib/session";
import type { MeResponse } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch }) => {
  await requireSession();
  const me = await api<MeResponse>("/api/me", undefined, fetch);
  const firstTeam = me.teams[0]?.organization.id;
  if (firstTeam) {
    // The plan flip normally happens in the Mollie webhook. If that webhook
    // can't reach us (e.g. local dev), reconcile on return so the billing page
    // reflects the payment immediately. Best-effort: ignore failures.
    await api(`/api/teams/${firstTeam}/billing/sync`, { method: "POST" }, fetch).catch(
      () => undefined,
    );
    throw redirect(302, `/teams/${firstTeam}/settings/billing`);
  }
  throw redirect(302, "/dashboard");
};
