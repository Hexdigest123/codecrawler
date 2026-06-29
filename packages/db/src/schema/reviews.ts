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
import {
  billingModeEnum,
  reviewCategoryEnum,
  reviewDepthEnum,
  reviewStatusEnum,
  severityEnum,
} from "./enums";
import { projects } from "./projects";

export const pullRequests = pgTable(
  "pull_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    externalNumber: integer("external_number"),
    title: text("title"),
    author: text("author"),
    baseSha: text("base_sha"),
    headSha: text("head_sha"),
    state: text("state"),
    htmlUrl: text("html_url"),
    openedAt: timestamp("opened_at", { withTimezone: true }),
  },
  (table) => [index("pull_requests_projectId_idx").on(table.projectId)],
);

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    prId: uuid("pr_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id),
    profileId: uuid("profile_id").references(() => agentProfiles.id),
    status: reviewStatusEnum("status").notNull().default("pending"),
    walkthrough: text("walkthrough"),
    billingMode: billingModeEnum("billing_mode"),
    // Agentic depth tier this run executed under ("static"|"quick"|"deep").
    depth: reviewDepthEnum("depth").notNull().default("static"),
    // Observability: how many agent ReAct steps ran and how many tool calls
    // were made. Zero for the static path.
    agentSteps: integer("agent_steps").notNull().default(0),
    toolCalls: integer("tool_calls").notNull().default(0),
    creditsCost: numeric("credits_cost").notNull().default("0"),
    tokenSpendUsd: numeric("token_spend_usd").notNull().default("0"),
    modelIds: text("model_ids").array(),
    // Origin of the run: webhook | manual | synthetic | comment. Display-only.
    source: text("source"),
    // Frozen snapshot of the diff files the reviewer actually saw, so the review
    // page can show anchored code context and "what changed" without re-fetching.
    diff: jsonb("diff"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("reviews_prId_idx").on(table.prId),
    index("reviews_projectId_idx").on(table.projectId),
  ],
);

export const reviewFindings = pgTable(
  "review_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    file: text("file"),
    line: integer("line"),
    severity: severityEnum("severity"),
    category: reviewCategoryEnum("category"),
    message: text("message"),
    suggestion: text("suggestion"),
  },
  (table) => [index("review_findings_reviewId_idx").on(table.reviewId)],
);
