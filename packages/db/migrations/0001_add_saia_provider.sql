-- Add SAIA as a BYOK provider (GWDG academic cloud, OpenAI-compatible gateway).
-- SAIA is team-BYOK only (unlimited); models are addressed via the "saia/" gateway prefix.
ALTER TYPE "provider" ADD VALUE IF NOT EXISTS 'saia';
