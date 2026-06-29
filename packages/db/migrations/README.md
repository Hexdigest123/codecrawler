# Migrations

The initial migration `0000_initial.sql` is hand-authored to match the Drizzle
schema in `src/schema/` exactly.

## Meta snapshot

`meta/_journal.json` is present so that `drizzle-kit migrate` applies
`0000_initial.sql`. The `meta/0000_snapshot.json` is intentionally omitted — it
is only used by `drizzle-kit generate` for computing future diffs.

**Orchestrator**: after `bun install`, run `bun run db:generate` once to
reconcile `meta/0000_snapshot.json` against the already-applied schema. If
drizzle-kit reports a diff, verify it is empty (the hand-written SQL should
match the schema) or apply the generated migration.
