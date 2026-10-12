-- Reviewed card attribute corrections (Deck Lists 11). A correction is a Catalog Override of one Card Printing's
-- attributes: collector reports are unapproved input, and only the owner's approval-coded decision creates, replaces
-- or removes a correction (api/app/attribute_corrections.py). Corrections are per attribute: a corrected attribute
-- overrides the derived value until the correction is removed, and an attribute the correction leaves NULL follows
-- derivation. Manually approved Printings have no derived row, so a correction is their only source of attributes.
-- Migration 032 is reserved for another ticket; this one is independent of it.

-- The attribute revision advances at most once per transaction: a later call in the same transaction returns the
-- revision the first call took, like catalog_begin_correction() for the public clock. Card attribute derivation,
-- reviewed corrections and (later) Reprint Groups all advance it through this function.
CREATE FUNCTION catalog_advance_attribute_revision() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE r bigint := nullif(current_setting('tcg.attribute_revision', true), '')::bigint;
BEGIN
 IF r IS NULL THEN
  UPDATE catalog_attribute_state SET revision=revision+1 WHERE singleton RETURNING revision INTO r;
  PERFORM set_config('tcg.attribute_revision', r::text, true);
 END IF;
 RETURN r;
END $$;

-- Maintainer decisions are append-only provenance. ``correction`` is the Printing's whole correction after the
-- decision ('{}' after a removal), ``previous_correction`` the one it replaced, and ``derived``/``rules_version``
-- the derived attributes the maintainer was shown (NULL for a Printing without a derived row).
CREATE TABLE catalog_attribute_decision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 printing_id uuid NOT NULL REFERENCES catalog_printing(id),
 decision text NOT NULL CHECK(decision IN ('correct','remove')),
 correction jsonb NOT NULL CHECK(jsonb_typeof(correction)='object'),
 previous_correction jsonb CHECK(previous_correction IS NULL OR jsonb_typeof(previous_correction)='object'),
 derived jsonb CHECK(derived IS NULL OR jsonb_typeof(derived)='object'),
 rules_version integer CHECK(rules_version>0),
 evidence_digest text NOT NULL CHECK(evidence_digest ~ '^[0-9a-f]{64}$'),
 evidence_url text NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 reviewer_id text NOT NULL REFERENCES inventory_owner(user_id),
 reviewed_at timestamptz NOT NULL DEFAULT now(),
 clock_revision bigint NOT NULL,
 attribute_revision bigint NOT NULL CHECK(attribute_revision>0),
 CHECK((decision='remove')=(correction='{}'::jsonb)),
 CHECK(decision<>'remove' OR previous_correction IS NOT NULL)
);
CREATE TRIGGER catalog_attribute_decision_append_only BEFORE UPDATE OR DELETE ON catalog_attribute_decision
 FOR EACH ROW EXECUTE FUNCTION catalog_append_only();
CREATE INDEX catalog_attribute_decision_printing ON catalog_attribute_decision(printing_id,reviewed_at DESC);

-- The current correction of each Printing: NULL means "not corrected", never "corrected to unknown".
CREATE TABLE catalog_attribute_correction (
 printing_id uuid PRIMARY KEY REFERENCES catalog_printing(id),
 regulation_mark text CHECK (regulation_mark ~ '^[A-Z]$'),
 card_kind text CHECK (card_kind IN ('pokemon', 'trainer', 'energy')),
 basic_energy boolean,
 types text[] CHECK (array_position(types, NULL) IS NULL AND types <@ ARRAY['Grass', 'Fire', 'Water', 'Lightning',
   'Psychic', 'Fighting', 'Darkness', 'Metal', 'Fairy', 'Dragon', 'Colorless']),
 rule_box boolean,
 ace_spec boolean,
 radiant boolean,
 prism_star boolean,
 decision_id uuid NOT NULL REFERENCES catalog_attribute_decision(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(regulation_mark,card_kind,basic_energy,types,rule_box,ace_spec,radiant,prism_star)>0)
);

-- Collector reports are unapproved input: one row each, nothing else.
CREATE TABLE catalog_attribute_report (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 reporter_id text REFERENCES inventory_owner(user_id) ON DELETE SET NULL,
 printing_id uuid NOT NULL REFERENCES catalog_printing(id),
 proposed jsonb NOT NULL CHECK(jsonb_typeof(proposed)='object' AND proposed<>'{}'::jsonb AND pg_column_size(proposed)<=2048),
 evidence_url text CHECK(evidence_url IS NULL OR length(evidence_url)<=2048),
 note text NOT NULL DEFAULT '' CHECK(length(note)<=2000),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','needs_info','rejected','approved')),
 review_reason text,
 reviewer_id text REFERENCES inventory_owner(user_id),
 reviewed_at timestamptz,
 decision_id uuid REFERENCES catalog_attribute_decision(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((status IN ('approved','rejected'))=(reviewer_id IS NOT NULL AND reviewed_at IS NOT NULL)),
 CHECK(status<>'approved' OR decision_id IS NOT NULL)
);
CREATE INDEX catalog_attribute_report_reporter ON catalog_attribute_report(reporter_id,created_at DESC);
CREATE INDEX catalog_attribute_report_open ON catalog_attribute_report(printing_id,created_at)
 WHERE status IN ('pending','needs_info');

-- Approval codes for attribute decisions name the Printing (metadata_target 'printing:<id>') with their own action,
-- so a code issued for a Live metadata decision on the same Printing cannot be spent on an attribute correction.
ALTER TABLE catalog_approval_code DROP CONSTRAINT catalog_approval_code_action_check;
ALTER TABLE catalog_approval_code ADD CONSTRAINT catalog_approval_code_action_check
 CHECK(action IN ('approve_printing','approve_edition','confirm_source','resolve_catalog','resolve_metadata','activate_rule',
   'correct_attributes'));

-- Effective attributes: a corrected attribute wins over the derived one. The columns, their order and their types are
-- unchanged from 030, so no reader changes. A Printing appears when it has a derived row, a correction, or both; a
-- manual Printing has only a correction. The view is driven by catalog_printing so that printing_id is the Printing's
-- primary key: both readers' forms, a join on printing_id (Deck checks, Deck List publication) and a printing_id = ANY
-- predicate (read_card_attributes), become primary-key lookups into all three tables instead of a full scan of the
-- derived table (api/tests/test_attribute_corrections.py guards both plans).
CREATE OR REPLACE VIEW catalog_card_attribute AS
  SELECT p.id AS printing_id,
    coalesce(c.regulation_mark, d.regulation_mark) AS regulation_mark,
    coalesce(c.card_kind, d.card_kind) AS card_kind,
    coalesce(c.basic_energy, d.basic_energy) AS basic_energy,
    coalesce(c.types, d.types) AS types,
    coalesce(c.rule_box, d.rule_box) AS rule_box,
    coalesce(c.ace_spec, d.ace_spec) AS ace_spec,
    coalesce(c.radiant, d.radiant) AS radiant,
    coalesce(c.prism_star, d.prism_star) AS prism_star
  FROM catalog_printing p
  LEFT JOIN catalog_derived_attribute d ON d.printing_id = p.id
  LEFT JOIN catalog_attribute_correction c ON c.printing_id = p.id
  WHERE d.printing_id IS NOT NULL OR c.printing_id IS NOT NULL;
