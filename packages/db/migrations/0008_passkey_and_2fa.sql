-- Better Auth `twoFactor` (TOTP authenticator app) and `passkey` (WebAuthn)
-- plugin tables. Both store per-user credentials and cascade with the user
-- account. A user is considered 2FA-protected only when a `twoFactor` row with
-- verified=true exists; the row is created (verified=false) on enable and
-- confirmed via POST /api/me/2fa/verify.

CREATE TABLE "twoFactor" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean NOT NULL DEFAULT false,
	"failed_verification_count" integer NOT NULL DEFAULT 0,
	"locked_until" timestamptz,
	CONSTRAINT "twoFactor_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade ON UPDATE no action
);

CREATE INDEX "twoFactor_userId_idx" ON "twoFactor" ("user_id");

CREATE TABLE "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL DEFAULT 0,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL DEFAULT false,
	"transports" text,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"aaguid" text,
	CONSTRAINT "passkey_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade ON UPDATE no action
);

CREATE INDEX "passkey_userId_idx" ON "passkey" ("user_id");
