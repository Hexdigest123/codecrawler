import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id")
    .notNull()
    .references(() => organization.id),
  name: text("name").notNull(),
  provider: text("provider"),
  repoExternalId: text("repo_external_id"),
  repoFullName: text("repo_full_name"),
  webhookSecret: text("webhook_secret"),
  defaultProfileId: uuid("default_profile_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
