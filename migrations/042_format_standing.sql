-- Stored Format Standing (app redesign #172, spec "Stored Format Standing"). Each Card Printing's Format Standing in each
-- Format (legal, not_legal or unknown; CONTEXT.md) is stored, so the Catalog browse route can filter by Format on the
-- server with stable pages. A Card Edition has its Card Printing's standing: readers join through
-- catalog_edition.printing_id. api/app/format_standing.py computes the rows with the format evaluator's per-card checks
-- and is their only writer.
--
-- catalog_format_standing_key holds one row per Format: what its standings were computed from (the rules file's
-- SHA-256, the code's SHA-256, the attribute revision, the catalog revision and active generation, and the next rule
-- date after the day they were computed for). Standings and their key are written in one transaction, so a reader's
-- snapshot sees standings that match the key it sees. A Format without a key row is stale.
--
-- This migration creates both tables empty and advances no revision. Until the first rebuild every Format is stale; the
-- API's startup, the first reader (api/app/format_standing.py ensure_current), the next catalog import or attribute
-- decision, or scripts/format_standing_job.py builds them. Nothing before the Catalog browse route (#173) reads them, and
-- that route builds a stale Format before it reads, so serving before the first build is safe. An older release ignores
-- both tables. Deleting a Card Printing deletes its standings.
--
-- Safe to run again: both tables are created only if missing, with their checks.

CREATE TABLE IF NOT EXISTS catalog_format_standing (
  printing_id uuid NOT NULL REFERENCES catalog_printing(id) ON DELETE CASCADE,
  format text NOT NULL CHECK (format ~ '^[a-z][a-z_]{0,39}$'),
  standing text NOT NULL CHECK (standing IN ('legal', 'not_legal', 'unknown')),
  -- The card-level issues behind the standing, in the evaluator's order: [{code, reason, effect}], empty when legal.
  findings jsonb NOT NULL CHECK (jsonb_typeof(findings) = 'array'),
  PRIMARY KEY (printing_id, format)
);

CREATE TABLE IF NOT EXISTS catalog_format_standing_key (
  format text PRIMARY KEY CHECK (format ~ '^[a-z][a-z_]{0,39}$'),
  rules_sha256 text NOT NULL CHECK (rules_sha256 ~ '^[0-9a-f]{64}$'),
  code_sha256 text NOT NULL CHECK (code_sha256 ~ '^[0-9a-f]{64}$'),
  attribute_revision bigint NOT NULL CHECK (attribute_revision >= 0),
  catalog_revision bigint NOT NULL CHECK (catalog_revision >= 0),
  -- The catalog generation the standings read (NULL before the first import). Every import changes it with the catalog
  -- revision; it also tells apart two catalogs that reached the same revision number.
  active_generation uuid,
  -- The first rule date after built_on (NULL when none follows): the standings hold on every date before it.
  next_rule_date date,
  built_on date NOT NULL,
  built_at timestamptz NOT NULL,
  printings integer NOT NULL CHECK (printings >= 0),
  builds bigint NOT NULL CHECK (builds > 0)
);
