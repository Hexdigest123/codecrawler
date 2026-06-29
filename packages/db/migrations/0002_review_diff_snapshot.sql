-- Store the frozen diff snapshot the reviewer saw, plus the run source for
-- display ("webhook" | "manual" | "synthetic" | "comment"). html_url on
-- pull_requests lets the review page link out to the host PR/MR.
ALTER TABLE "reviews" ADD COLUMN "diff" jsonb;
ALTER TABLE "reviews" ADD COLUMN "source" text;

ALTER TABLE "pull_requests" ADD COLUMN "html_url" text;

-- Self-hosted Gitea / GitLab enterprise base URL (null for github.com / gitlab.com).
-- Required so the worker can build API URLs when reviews are triggered for
-- self-hosted Gitea repos connected via a stored VCS connection.
ALTER TABLE "vcs_connections" ADD COLUMN "base_url" text;
