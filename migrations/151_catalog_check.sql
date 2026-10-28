-- The scheduled catalog change check (#339, ADR 0018): one row per run of `python -m app.catalog_refresh`.
--
-- A row is inserted when the check starts, with a null outcome and no finished_at, and finished when the check ends, so a
-- check that crashed leaves an unfinished row. outcome: no_change (TCGdex and the catalog agree), pull_started (the check
-- reserved a catalog_run, named by catalog_run_id), pull_running (a pull was already running, so nothing was started),
-- paused (three of the check's own pulls failed in a row; nothing was started) or failed (the check itself could not
-- compare; error_code says why). A pull_started row whose pull failed or was interrupted keeps pull_started, with the
-- pull's error in error_code. new_count and removed_count are the source ids the catalog lacks and the catalog ids the
-- source no longer lists. index_exit_code is the scanner index job's exit status, written by a second call because the
-- host script cannot write the row itself.
--
-- Records only: reading or writing it advances no revision and changes no catalog data.
--
-- Safe to run on existing data and to run again.
CREATE TABLE IF NOT EXISTS catalog_check (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text CHECK (outcome IS NULL OR outcome IN ('no_change','pull_started','pull_running','paused','failed')),
  new_count integer CHECK (new_count IS NULL OR new_count >= 0),
  removed_count integer CHECK (removed_count IS NULL OR removed_count >= 0),
  catalog_run_id uuid REFERENCES catalog_run(id),
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 200),
  index_exit_code integer CHECK (index_exit_code IS NULL OR index_exit_code BETWEEN 0 AND 255)
);
CREATE INDEX IF NOT EXISTS catalog_check_run ON catalog_check (catalog_run_id) WHERE catalog_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS catalog_check_started ON catalog_check (started_at DESC);
