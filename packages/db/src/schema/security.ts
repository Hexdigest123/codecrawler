import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agentProfiles } from "./agent_profiles";
import { billingModeEnum, reviewStatusEnum, securityFindingKindEnum, severityEnum } from "./enums";
import { projects } from "./projects";

export const securityReports = pgTable(
  "security_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id").references(() => agentProfiles.id),
    status: reviewStatusEnum("status").notNull().default("pending"),
    summary: text("summary"),
    billingMode: billingModeEnum("billing_mode"),
    creditsCost: numeric("credits_cost").notNull().default("0"),
    tokenSpendUsd: numeric("token_spend_usd").notNull().default("0"),
    snykRaw: jsonb("snyk_raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("security_reports_projectId_idx").on(table.projectId)],
);

export const securityFindings = pgTable(
  "security_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => securityReports.id, { onDelete: "cascade" }),
    kind: securityFindingKindEnum("kind").notNull(),
    severity: severityEnum("severity"),
    file: text("file"),
    line: integer("line"),
    packageName: text("package"),
    vulnVersion: text("vuln_version"),
    fixedVersion: text("fixed_version"),
    message: text("message"),
  },
  (table) => [index("security_findings_reportId_idx").on(table.reportId)],
);
