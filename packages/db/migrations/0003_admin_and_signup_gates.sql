-- Admin section: platform-wide signup gate, payment toggle, and the approval
-- queue. The user table gains a platform role ("admin" | "user") and an account
-- status ("active" | "pending" | "denied"). The first user to sign up is
-- promoted to "admin" by the auth databaseHooks (see packages/auth).

ALTER TABLE "user" ADD COLUMN "role" text NOT NULL DEFAULT 'user';
ALTER TABLE "user" ADD COLUMN "status" text NOT NULL DEFAULT 'active';

CREATE TABLE "app_settings" (
	"id" text PRIMARY KEY DEFAULT 'singleton',
	"signup_mode" text NOT NULL DEFAULT 'open',
	"allowed_domains" text[] NOT NULL DEFAULT '{}',
	"payments_enabled" boolean NOT NULL DEFAULT true,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

INSERT INTO "app_settings" ("id") VALUES ('singleton');

CREATE TABLE "signup_requests" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"status" text NOT NULL DEFAULT 'pending',
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"denial_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "signup_requests_userId_unique" ON "signup_requests" ("user_id");
CREATE INDEX "signup_requests_status_idx" ON "signup_requests" ("status");
CREATE INDEX "signup_requests_email_idx" ON "signup_requests" ("email");
