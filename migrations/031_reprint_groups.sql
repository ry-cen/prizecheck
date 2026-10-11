-- Reprint Groups: the Card Printings within one Card Identity whose rules text is exactly equal. Format legality and
-- bans apply to a whole group; copy limits still count by Card Identity (CONTEXT.md).
-- The rules in api/app/reprint_groups.py reduce each TCGdex Printing's source record to its rules text. A group's ID is
-- derived from its Card Identity and that text, so it is stable across re-imports and a new reprint joins its existing
-- group. Only app.reprint_groups.refresh_reprint_groups writes derived rows; every catalog import runs it, and so does
-- scripts/derive_card_attributes.py. A migration cannot run the Python rules, so Printings that exist before this
-- migration are in no group until that script or the next catalog import runs.
-- A change to any Printing's group advances catalog_attribute_state.revision through
-- catalog_advance_attribute_revision() (migration 029), once per transaction.

CREATE TABLE catalog_derived_reprint_group (
  printing_id uuid PRIMARY KEY REFERENCES catalog_printing(id) ON DELETE CASCADE,
  group_id uuid NOT NULL,
  -- sha256 of the Printing's normalized rules text.
  text_key text NOT NULL CHECK (text_key ~ '^[0-9a-f]{64}$'),
  rules_version integer NOT NULL CHECK (rules_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX catalog_derived_reprint_group_group ON catalog_derived_reprint_group(group_id);

-- Effective membership: the only relation readers use. Maintainer-reviewed merges and splits will redefine this view,
-- keeping these columns, so no reader changes. Both reader forms, a join on printing_id and group_id = ANY(...), must
-- keep looking rows up by index; api/tests/test_reprint_groups.py guards the plans.
CREATE VIEW catalog_reprint_group_member AS
  SELECT printing_id, group_id FROM catalog_derived_reprint_group;
