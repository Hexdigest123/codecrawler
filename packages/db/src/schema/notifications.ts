import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";

// Per-user email notification preferences. A row is created lazily via
// `upsertNotificationSettings`; absent rows are treated as "all enabled" by
// `getNotificationSettings`, so existing users keep receiving every email until
// they opt out from Account → Notifications.
export const notificationSettings = pgTable("notification_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  reviews: boolean("reviews").notNull().default(true),
  teams: boolean("teams").notNull().default(true),
  billing: boolean("billing").notNull().default(true),
  integrations: boolean("integrations").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
