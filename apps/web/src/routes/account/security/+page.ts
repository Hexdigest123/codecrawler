import { api } from "$lib/api";
import { requireSession } from "$lib/session";
import type { PasskeyRow } from "$lib/types";
import type { PageLoad } from "./$types";

export interface SecurityPageData {
  twoFactorEnabled: boolean;
  passkeys: PasskeyRow[];
}

export const load: PageLoad = async ({ fetch }) => {
  await requireSession();
  const [twoFactor, passkeys] = await Promise.all([
    api<{ enabled: boolean }>("/api/me/2fa", undefined, fetch),
    api<{ passkeys: PasskeyRow[] }>("/api/me/passkeys", undefined, fetch),
  ]);
  return {
    twoFactorEnabled: twoFactor.enabled,
    passkeys: passkeys.passkeys,
  };
};
