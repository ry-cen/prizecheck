-- Saved format results (Deck Lists 17, ADR 0010). One row per Deck and format holds the last result computed for it and
-- the key it was computed under (api/app/deck_format_checks.py): the Deck List revision, the rules file and evaluator
-- code digests, the card attribute and Reprint Group revision, the catalog revision, and the next rule date after the
-- evaluation date (NULL when none follows). A read whose key matches reuses the row; any other read or Deck List command
-- recomputes and replaces it. Nothing re-evaluates in bulk, so a stale row simply waits for its Deck's next read.
--
-- ``result`` holds the status, issues and rules version, never the evaluation date: a result holds for every date up to
-- ``valid_until``. Rows go with their Deck List when a Deck is deleted. An older application still serving during a
-- release or after a rollback never reads or writes this table; its Deck List edits advance the revision, so its rows
-- go stale rather than wrong.
CREATE TABLE deck_format_result (
  owner_id text NOT NULL,
  deck_id uuid NOT NULL,
  format text NOT NULL CHECK (format ~ '^[a-z][a-z_]{0,39}$'),
  deck_list_revision bigint NOT NULL CHECK (deck_list_revision > 0),
  rules_sha256 text NOT NULL CHECK (rules_sha256 ~ '^[0-9a-f]{64}$'),
  code_sha256 text NOT NULL CHECK (code_sha256 ~ '^[0-9a-f]{64}$'),
  attribute_revision bigint NOT NULL CHECK (attribute_revision > 0),
  catalog_revision bigint NOT NULL CHECK (catalog_revision >= 0),
  valid_until date,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, deck_id, format),
  FOREIGN KEY (owner_id, deck_id) REFERENCES deck_list(owner_id, deck_id) ON DELETE CASCADE
);
