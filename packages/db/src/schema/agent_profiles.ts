import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { coverageStrategyEnum, graphTypeEnum } from "./enums";
import { projects } from "./projects";

export const agentProfiles = pgTable(
  "agent_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").references(() => organization.id),
    projectId: uuid("project_id").references(() => projects.id),
    graphType: graphTypeEnum("graph_type").notNull(),
    nodeModels: jsonb("node_models").notNull().default({}),
    coverageStrategy: coverageStrategyEnum("coverage_strategy").default("by_filegroup"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("agent_profiles_orgId_idx").on(table.orgId),
    index("agent_profiles_projectId_idx").on(table.projectId),
  ],
);
