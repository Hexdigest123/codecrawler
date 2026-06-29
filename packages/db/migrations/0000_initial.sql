-- NOTE: This migration was hand-authored to match the Drizzle schema exactly.
-- Run `bun run db:generate` to reconcile migrations/meta snapshots for future diffs.

CREATE TYPE "plan" AS ENUM('free', 'plus', 'pro');
--> statement-breakpoint
CREATE TYPE "provider" AS ENUM('openrouter', 'openai', 'anthropic', 'google', 'xai', 'zai', 'kimi', 'mistral', 'nvidia', 'minimax', 'qwen', 'deepseek');
--> statement-breakpoint
CREATE TYPE "graph_type" AS ENUM('pr_review', 'security');
--> statement-breakpoint
CREATE TYPE "coverage_strategy" AS ENUM('by_commit', 'by_filegroup', 'full');
--> statement-breakpoint
CREATE TYPE "billing_mode" AS ENUM('hosted', 'byok', 'mixed');
--> statement-breakpoint
CREATE TYPE "review_status" AS ENUM('pending', 'queued', 'running', 'completed', 'failed', 'cancelled');
--> statement-breakpoint
CREATE TYPE "review_category" AS ENUM('possible_issue', 'security', 'performance', 'nitpick', 'praise');
--> statement-breakpoint
CREATE TYPE "security_finding_kind" AS ENUM('sast', 'dep', 'secret', 'ai');
--> statement-breakpoint
CREATE TYPE "severity" AS ENUM('critical', 'high', 'medium', 'low', 'nitpick');
--> statement-breakpoint
CREATE TYPE "api_key_status" AS ENUM('valid', 'invalid', 'unverified');
--> statement-breakpoint
CREATE TYPE "vcs_provider" AS ENUM('github', 'gitlab', 'gitea');
--> statement-breakpoint
CREATE TYPE "vcs_kind" AS ENUM('oauth', 'github_app');
--> statement-breakpoint

CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"logo" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone,
	"inviter_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"domain" text,
	"provider_id" text,
	"config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_subscriptions" (
	"org_id" text PRIMARY KEY NOT NULL,
	"plan" "plan" DEFAULT 'free' NOT NULL,
	"status" text,
	"mollie_customer_id" text,
	"mollie_subscription_id" text,
	"current_period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text,
	"repo_external_id" text,
	"repo_full_name" text,
	"webhook_secret" text,
	"default_profile_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vcs_connections" (
	"id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" "vcs_provider" NOT NULL,
	"kind" "vcs_kind" DEFAULT 'oauth' NOT NULL,
	"external_id" text,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" timestamp with time zone,
	"scopes" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_profiles" (
	"id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
	"org_id" text,
	"project_id" uuid,
	"graph_type" "graph_type" NOT NULL,
	"node_models" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"coverage_strategy" "coverage_strategy" DEFAULT 'by_filegroup',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"external_number" integer,
	"title" text,
	"author" text,
	"base_sha" text,
	"head_sha" text,
	"state" text,
	"opened_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
	"pr_id" uuid NOT NULL,
	"project_id" uuid,
	"profile_id" uuid,
	"status" "review_status" DEFAULT 'pending' NOT NULL,
	"walkthrough" text,
	"billing_mode" "billing_mode",
	"credits_cost" numeric DEFAULT '0' NOT NULL,
	"token_spend_usd" numeric DEFAULT '0' NOT NULL,
	"model_ids" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "review_findings" (
	"id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
	"review_id" uuid NOT NULL,
	"file" text,
	"line" integer,
	"severity" "severity",
	"category" "review_category",
	"message" text,
	"suggestion" text
);
--> statement-breakpoint
CREATE TABLE "security_reports" (
	"id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"profile_id" uuid,
	"status" "review_status" DEFAULT 'pending' NOT NULL,
	"summary" text,
	"billing_mode" "billing_mode",
	"credits_cost" numeric DEFAULT '0' NOT NULL,
	"token_spend_usd" numeric DEFAULT '0' NOT NULL,
	"snyk_raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_findings" (
	"id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
	"report_id" uuid NOT NULL,
	"kind" "security_finding_kind" NOT NULL,
	"severity" "severity",
	"file" text,
	"line" integer,
	"package" text,
	"vuln_version" text,
	"fixed_version" text,
	"message" text
);
--> statement-breakpoint
CREATE TABLE "usage" (
	"id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"period_key" text NOT NULL,
	"credits" numeric DEFAULT '0' NOT NULL,
	"date" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" "provider" NOT NULL,
	"label" text,
	"encrypted_key" text NOT NULL,
	"status" "api_key_status" DEFAULT 'unverified',
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_weights" (
	"openrouter_model_id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"weight" numeric DEFAULT '1' NOT NULL,
	"category" text,
	"enabled" boolean DEFAULT true,
	"min_plan" "plan" DEFAULT 'free',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
	"org_id" text,
	"actor_user_id" text,
	"action" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sso" ADD CONSTRAINT "sso_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_subscriptions" ADD CONSTRAINT "team_subscriptions_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vcs_connections" ADD CONSTRAINT "vcs_connections_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "pull_requests"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_profile_id_agent_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "agent_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "security_reports" ADD CONSTRAINT "security_reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "security_reports" ADD CONSTRAINT "security_reports_profile_id_agent_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "agent_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_report_id_security_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "security_reports"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX "user_email_unique" ON "user" ("email");
--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_unique" ON "session" ("token");
--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_unique" ON "organization" ("slug");
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_orgId_kind_periodKey_unique" ON "usage" ("org_id", "kind", "period_key");
--> statement-breakpoint

CREATE INDEX "session_userId_idx" ON "session" ("user_id");
--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" ("user_id");
--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");
--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" ("organization_id");
--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" ("user_id");
--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" ("organization_id");
--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" ("email");
--> statement-breakpoint
CREATE INDEX "sso_organizationId_idx" ON "sso" ("organization_id");
--> statement-breakpoint
CREATE INDEX "vcs_connections_orgId_idx" ON "vcs_connections" ("org_id");
--> statement-breakpoint
CREATE INDEX "agent_profiles_orgId_idx" ON "agent_profiles" ("org_id");
--> statement-breakpoint
CREATE INDEX "agent_profiles_projectId_idx" ON "agent_profiles" ("project_id");
--> statement-breakpoint
CREATE INDEX "pull_requests_projectId_idx" ON "pull_requests" ("project_id");
--> statement-breakpoint
CREATE INDEX "reviews_prId_idx" ON "reviews" ("pr_id");
--> statement-breakpoint
CREATE INDEX "reviews_projectId_idx" ON "reviews" ("project_id");
--> statement-breakpoint
CREATE INDEX "review_findings_reviewId_idx" ON "review_findings" ("review_id");
--> statement-breakpoint
CREATE INDEX "security_reports_projectId_idx" ON "security_reports" ("project_id");
--> statement-breakpoint
CREATE INDEX "security_findings_reportId_idx" ON "security_findings" ("report_id");
--> statement-breakpoint
CREATE INDEX "usage_orgId_idx" ON "usage" ("org_id");
--> statement-breakpoint
CREATE INDEX "api_keys_orgId_idx" ON "api_keys" ("org_id");
--> statement-breakpoint
CREATE INDEX "audit_log_orgId_idx" ON "audit_log" ("org_id");
--> statement-breakpoint
CREATE INDEX "audit_log_actorUserId_idx" ON "audit_log" ("actor_user_id");
