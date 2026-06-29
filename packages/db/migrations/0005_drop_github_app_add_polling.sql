-- Drop the GitHub App implementation.
-- 1. Normalise any legacy vcs_connections rows that used the "github_app" kind
--    down to "oauth" (their access_token is treated as a PAT from here on).
-- 2. Rebuild the vcs_kind enum without the "github_app" value. Postgres can't
--    remove a value from an existing enum directly, so we create a new type,
--    re-cast the column, and swap it in.
-- 3. Add projects.polling_enabled so the worker can poll for new PRs on a
--    schedule instead of (or in addition to) relying on inbound webhooks.

UPDATE "vcs_connections" SET "kind" = 'oauth' WHERE "kind" = 'github_app';

CREATE TYPE "vcs_kind_new" AS ENUM ('oauth');
ALTER TABLE "vcs_connections"
  ALTER COLUMN "kind" DROP DEFAULT,
  ALTER COLUMN "kind" TYPE "vcs_kind_new" USING ("kind"::text)::"vcs_kind_new",
  ALTER COLUMN "kind" SET DEFAULT 'oauth';
DROP TYPE "vcs_kind";
ALTER TYPE "vcs_kind_new" RENAME TO "vcs_kind";

ALTER TABLE "projects" ADD COLUMN "polling_enabled" boolean NOT NULL DEFAULT false;
