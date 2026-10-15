-- Collection Import's daily limit (#233, spec "API": 429 IMPORT_RATE_LIMITED after 20 starts in a day): one row for each
-- import draft a collector started, so the start route can count the last 24 hours even after the drafts themselves are
-- replaced, saved or expired. The start route deletes this collector's rows older than 24 hours as it adds one. A row
-- holds no file content, only who started an import and when.
-- Expand-only: a new table that the previous application never reads.
CREATE TABLE collection_import_start (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collection_import_start_owner ON collection_import_start(owner_id, started_at);
