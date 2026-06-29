import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { planEnum } from "./enums";

export const teamSubscriptions = pgTable("team_subscriptions", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organization.id),
  plan: planEnum("plan").notNull().default("free"),
  status: text("status"),
  mollieCustomerId: text("mollie_customer_id"),
  mollieSubscriptionId: text("mollie_subscription_id"),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
