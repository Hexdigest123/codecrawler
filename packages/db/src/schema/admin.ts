import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * Singleton configuration row (id is always "singleton"). Controls platform-wide
 * gates exposed in the Admin dashboard: sign-up mode, allowed email domains, and
 * the global payment availability toggle.
 *
 *   signupMode:
 *     - "open"              anyone can sign up
 *     - "closed"            new sign-ups are blocked entirely
 *     - "domain_restricted" only emails from allowedDomains may sign up
 *     - "approval"          anyone may request access; admins must approve
 */
export const appSettings = pgTable("app_settings", {
  id: text("id").primaryKey().default("singleton"),
  signupMode: text("signup_mode").notNull().default("open"),
  allowedDomains: text("allowed_domains").array().notNull().default([]),
  paymentsEnabled: boolean("payments_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * One row per access request when signupMode = "approval". The corresponding
 * `user` row is created with status="pending" and cannot sign in until this
 * request is approved (status flips the user to "active") or denied.
 */
export const signupRequests = pgTable(
  "signup_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name"),
    status: text("status").notNull().default("pending"),
    decidedBy: text("decided_by").references(() => user.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    denialReason: text("denial_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("signup_requests_userId_unique").on(table.userId),
    index("signup_requests_status_idx").on(table.status),
    index("signup_requests_email_idx").on(table.email),
  ],
);
