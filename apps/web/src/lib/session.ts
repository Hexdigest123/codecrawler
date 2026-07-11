import { authClient } from "@codecrawler/auth/client";
import { redirect } from "@sveltejs/kit";

export interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
}

export async function requireSession(): Promise<SessionUser> {
  const { data: session } = await authClient.getSession();
  const user = session?.user;
  if (!session || !user?.email) {
    throw redirect(302, "/sign-in");
  }
  return { id: user.id, email: user.email, name: user.name };
}

export async function redirectIfAuthenticated(destination = "/dashboard"): Promise<void> {
  const { data: session } = await authClient.getSession();
  if (session?.user) {
    throw redirect(302, destination);
  }
}
