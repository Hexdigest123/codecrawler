-- Per-user notification preferences. Rows are created lazily on first opt-out,
-- so existing users default to "everything on" without backfilling.
CREATE TABLE "notification_settings" (
  "user_id" text PRIMARY KEY NOT NULL,
  "reviews" boolean NOT NULL DEFAULT true,
  "teams" boolean NOT NULL DEFAULT true,
  "billing" boolean NOT NULL DEFAULT true,
  "integrations" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "notification_settings_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade ON UPDATE no action
);
