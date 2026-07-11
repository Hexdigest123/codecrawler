import { fetchModelCatalog } from "@codecrawler/ai";
import { Hono } from "hono";
import type { AppEnv } from "../lib/types";

export const modelsRouter = new Hono<AppEnv>();

modelsRouter.get("/api/models", async (c) => {
  const catalog = await fetchModelCatalog();
  return c.json({ models: catalog });
});
