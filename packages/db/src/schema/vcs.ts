import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { vcsKindEnum, vcsProviderEnum } from "./enums";

export const vcsConnections = pgTable(
  "vcs_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id),
    provider: vcsProviderEnum("provider").notNull(),
    kind: vcsKindEnum("kind").notNull().default("oauth"),
    externalId: text("external_id"),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    scopes: text("scopes").array(),
    // Self-hosted Gitea / GitLab enterprise base URL (empty for github.com / gitlab.com).
    baseUrl: text("base_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("vcs_connections_orgId_idx").on(table.orgId)],
);
