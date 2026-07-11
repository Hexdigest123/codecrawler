import { Hono } from "hono";
import { getAppSettings } from "../lib/db-helpers";
import { isMollieConfigured } from "../lib/review";
import type { AppEnv } from "../lib/types";

export const signupRouter = new Hono<AppEnv>();

signupRouter.get("/api/signup-config", async (c) => {
  const settings = await getAppSettings();
  return c.json({
    signupMode: settings.signupMode,
    allowedDomains: settings.allowedDomains ?? [],
    paymentsEnabled: settings.paymentsEnabled && isMollieConfigured(),
  });
});
