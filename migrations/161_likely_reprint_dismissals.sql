-- Text-key decisions are owner review only: no group writes, revision advance or public delivery.
CREATE TABLE catalog_likely_reprint_decision (
 sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 id uuid PRIMARY KEY,
 batch_id uuid NOT NULL,
 pair_key text NOT NULL,
 evidence_digest text NOT NULL CHECK(evidence_digest ~ '^[0-9a-f]{64}$'),
 left_key text NOT NULL CHECK(left_key ~ '^[0-9a-f]{64}$'),
 right_key text NOT NULL CHECK(right_key ~ '^[0-9a-f]{64}$'),
 dismissed boolean NOT NULL,
 reviewer_id text NOT NULL REFERENCES inventory_owner(user_id),
 reviewed_at timestamptz NOT NULL DEFAULT now(),
 CHECK(left_key <= right_key)
);
CREATE INDEX catalog_likely_reprint_decision_keys ON catalog_likely_reprint_decision(left_key,right_key,sequence DESC);
CREATE INDEX catalog_likely_reprint_decision_batch ON catalog_likely_reprint_decision(batch_id);
CREATE TRIGGER catalog_likely_reprint_decision_append_only BEFORE UPDATE OR DELETE ON catalog_likely_reprint_decision
 FOR EACH ROW EXECUTE FUNCTION catalog_append_only();
