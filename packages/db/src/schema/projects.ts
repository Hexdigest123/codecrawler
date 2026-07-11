import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
  // When true, the worker's poller periodically lists open PRs for this
  // project via the team's stored VCS PAT and enqueues reviews for any PR
  // whose head SHA hasn't been reviewed yet. An alternative to webhooks for
  // environments where inbound webhooks aren't possible.
  pollingEnabled: boolean("polling_enabled").notNull().default(false),
  defaultProfileId: uuid("default_profile_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
