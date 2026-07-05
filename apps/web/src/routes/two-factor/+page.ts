import type { PageLoad } from "./$types";

// The /two-factor page completes a sign-in that was deferred because the user
// has 2FA enabled. Better Auth's twoFactor plugin keeps the pending challenge
// in a short-lived cookie set during signIn.email, so the page simply collects
// the code and calls verifyTOTP — if no challenge is pending the call fails
// cleanly and the user is sent back to sign-in.
export const load: PageLoad = async ({ url }) => {
  return { email: url.searchParams.get("email") ?? "" };
};
