-- Agentic review workflow (CodeRabbit-style tool-calling reviewers).
-- Adds a depth tier to each review ("static"|"quick"|"deep"), plus
-- observability counters for agent ReAct steps and tool calls (zero on the
-- legacy static path). agent_profiles gains a team-default depth used when
-- REVIEW_AGENT_MODE=auto and the trigger did not pin a tier.
CREATE TYPE "review_depth" AS ENUM ('static', 'quick', 'deep');

ALTER TABLE "reviews" ADD COLUMN "depth" "review_depth" NOT NULL DEFAULT 'static';
ALTER TABLE "reviews" ADD COLUMN "agent_steps" integer NOT NULL DEFAULT 0;
ALTER TABLE "reviews" ADD COLUMN "tool_calls" integer NOT NULL DEFAULT 0;

ALTER TABLE "agent_profiles" ADD COLUMN "default_depth" "review_depth" DEFAULT 'quick';
