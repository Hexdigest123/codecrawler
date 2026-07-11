import { api } from "$lib/api";
import { requireSession } from "$lib/session";
import type { NotificationSettingsResponse } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch }) => {
  const [notifications, session] = await Promise.all([
    api<NotificationSettingsResponse>("/api/me/notifications", undefined, fetch),
    requireSession(),
  ]);
  return { settings: notifications.settings, currentEmail: session.email };
};
