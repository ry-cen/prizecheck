-- Card scanner catalog data (#309, plumbing decisions D4, D6 and "Fingerprint file PCFP v1").
--
-- catalog_generation_set_count: each set's printed card count, the {official, total} pair of TCGdex's set.cardCount, kept
-- per generation so the scanner reads a number's "of N" without decompressing catalog_generation.raw_gzip. A set whose
-- records carry no integer pair has no row. Filled by import_catalog inside the promotion transaction, and once for the
-- active generation by scripts/backfill_set_counts.py. Not added to catalog_generation_set, whose release_date is NOT NULL.
--
-- scanner_fingerprint, scanner_index and scanner_fingerprint_failure: what scripts/scanner_index_job.py computes and
-- publishes (one vector per printing and model, the assembled index files, and the ledger that backs off a broken image).
--
-- Catalog data only, like migration 044: writing any of it advances no revision, re-stamps no public record and leaves
-- saved format results and stored Format Standing current. Generation rows go with their generation (ON DELETE CASCADE).
--
-- Safe to run on existing data and to run again. Existing generations have no set counts until the backfill runs.
CREATE TABLE IF NOT EXISTS catalog_generation_set_count (
  generation_id uuid NOT NULL REFERENCES catalog_generation(id) ON DELETE CASCADE,
  set_id text NOT NULL CHECK (length(set_id) BETWEEN 1 AND 80),
  official integer NOT NULL CHECK (official >= 0),
  total integer NOT NULL CHECK (total >= 0),
  PRIMARY KEY (generation_id, set_id)
);

CREATE TABLE IF NOT EXISTS scanner_fingerprint (
  printing_id uuid NOT NULL REFERENCES catalog_printing(id),
  model_id text NOT NULL,
  image_url text NOT NULL,
  scale real NOT NULL,
  vector bytea NOT NULL CHECK (length(vector) = 384),
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (printing_id, model_id)
);

CREATE TABLE IF NOT EXISTS scanner_index (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  model_id text NOT NULL,
  catalog_revision bigint NOT NULL,
  inputs_digest text NOT NULL,
  count integer NOT NULL,
  inputs_count integer NOT NULL,
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scanner_index_model_created ON scanner_index (model_id, created_at DESC);

CREATE TABLE IF NOT EXISTS scanner_fingerprint_failure (
  printing_id uuid NOT NULL REFERENCES catalog_printing(id),
  model_id text NOT NULL,
  image_url text NOT NULL,
  failures integer NOT NULL CHECK (failures >= 1),
  last_failed_at timestamptz NOT NULL,
  PRIMARY KEY (printing_id, model_id)
);
