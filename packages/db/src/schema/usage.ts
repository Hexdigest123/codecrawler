import { index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth";

export const usage = pgTable(
  "usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    periodKey: text("period_key").notNull(),
    credits: numeric("credits").notNull().default("0"),
    date: timestamp("date", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("usage_orgId_idx").on(table.orgId),
    uniqueIndex("usage_orgId_kind_periodKey_unique").on(table.orgId, table.kind, table.periodKey),
  ],
);
