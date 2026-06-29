import { boolean, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { planEnum } from "./enums";

export const modelWeights = pgTable("model_weights", {
  openrouterModelId: text("openrouter_model_id").primaryKey(),
  displayName: text("display_name"),
  weight: numeric("weight").notNull().default("1"),
  category: text("category"),
  enabled: boolean("enabled").default(true),
  minPlan: planEnum("min_plan").default("free"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
