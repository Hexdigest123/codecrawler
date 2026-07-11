-- Replace the placeholder `sso` table with the `sso_provider` table that
-- Better Auth's SSO plugin (`@better-auth/sso`) reads/writes. The old table
-- only held a generic `config` jsonb blob; the plugin needs dedicated
-- `issuer` / `oidc_config` / `saml_config` / `user_id` columns to drive the
-- SAML 2.0 and OIDC handshakes. The previous table never held real data (the
-- plugin wasn't registered), so it's dropped without a data migration.
DROP INDEX IF EXISTS "sso_organizationId_idx";
DROP TABLE IF EXISTS "sso";

CREATE TABLE "sso_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"oidc_config" jsonb,
	"saml_config" jsonb,
	"user_id" text,
	"provider_id" text NOT NULL,
	"organization_id" text,
	"domain" text NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "sso_provider_provider_id_unique" UNIQUE("provider_id"),
	CONSTRAINT "sso_provider_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "sso_provider_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action
);

CREATE INDEX "sso_provider_organizationId_idx" ON "sso_provider" ("organization_id");
