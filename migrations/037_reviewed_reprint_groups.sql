-- Reviewed Reprint Groups and Card Identity merges (Deck Lists 14). The maintainer merges reworded or errata'd
-- printings into a Reprint Group, splits a wrong group, lets a manually approved Printing join a group, and merges Card
-- Identities that the subtitle rule misses (api/app/reprint_group_reviews.py). Each is a reviewed record that only the
-- owner's approval-coded decision writes, as for card attribute corrections (migration 033).
--
-- Reviewed records name Printings, never derived group IDs: a derived ID embeds the Card Identity and the rules text, so
-- a rules-text change or an identity merge renames it, while a Printing keeps its ID.
-- - A link (catalog_reprint_group_link) puts the Printing's current derived group into a reviewed group. Every Printing
--   that derives into that group follows, including a reprint imported later.
-- - An assignment (catalog_reprint_group_assignment) puts the Printing itself into a group, whatever it derives.
--   Splits and manual Printings use assignments. An assignment applies only to a Printing that derives a group (so it
--   is held, not withdrawn, by the catalog generation refresh_reprint_groups last wrote) or to a manual Printing
--   (every import carries it forward, never withdrawn). A withdrawn TCGdex Printing therefore leaves its group like
--   any other, through a membership row change that re-stamps its group-mates (migration 036's rule), and rejoins its
--   assigned group if a later import holds it again. The active generation is not read: refresh_reprint_groups runs
--   inside the import before the generation switch.
-- Effective group of a Printing: its applicable assignment, else the reviewed group its derived group is linked to,
-- else its derived group. A Printing with none of these is in no group.
--
-- Effective membership is kept in catalog_reprint_group_membership, so both reader forms (a join on printing_id and
-- group_id = ANY(...)) stay index lookups. Statement triggers on the three input tables recompute it, so every writer
-- keeps it current, including an older release's catalog import that writes only derived rows. A statement that changed
-- no row skips the recompute; each recompute writes only the rows whose group changed (an anti-join, so an unchanged
-- catalog costs one read and no row locks or WAL), after locking the attribute revision row, so concurrent writers
-- recompute one after another from committed inputs.
-- Public format facts (migration 036) carry each Printing's effective Reprint Group and its members. Every change of a
-- Printing's effective group is a row write on catalog_reprint_group_membership, so 036's group re-stamp triggers move
-- here from the derived table: a reviewed record changes effective membership without writing a derived row. A Card
-- Identity merge is an UPDATE of catalog_printing.identity_id, which 036 already re-stamps.
-- Lock order: every writer of the derived and reviewed tables takes the public clock (catalog_begin_correction()) first,
-- as migration 036 requires, and the recompute takes it too before it writes membership; it then locks the attribute
-- revision row, and the re-stamp reuses the clock.
--
-- This migration leaves effective membership exactly as before (no reviewed records exist yet), so it does not
-- advance the attribute revision.

-- Maintainer decisions are append-only provenance. ``printing_ids`` are the Printings the decision named (for an
-- identity merge, the Printings it moved); ``affected_printing_ids`` are the Printings whose effective group or Card
-- Identity changed.
CREATE TABLE catalog_card_identity_decision (
 id uuid PRIMARY KEY,
 identity_id uuid NOT NULL REFERENCES catalog_identity(id),
 decision text NOT NULL CHECK(decision IN ('merge','split','join','restore','merge_identity')),
 group_id uuid,
 target_group_id uuid,
 into_identity_id uuid REFERENCES catalog_identity(id),
 printing_ids uuid[] NOT NULL CHECK(array_position(printing_ids, NULL) IS NULL),
 affected_printing_ids uuid[] NOT NULL CHECK(array_position(affected_printing_ids, NULL) IS NULL),
 evidence_digest text NOT NULL CHECK(evidence_digest ~ '^[0-9a-f]{64}$'),
 into_evidence_digest text CHECK(into_evidence_digest ~ '^[0-9a-f]{64}$'),
 evidence_url text NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 reviewer_id text NOT NULL REFERENCES inventory_owner(user_id),
 reviewed_at timestamptz NOT NULL DEFAULT now(),
 clock_revision bigint NOT NULL,
 attribute_revision bigint NOT NULL CHECK(attribute_revision>0),
 CHECK((decision='merge_identity')=(into_identity_id IS NOT NULL)),
 CHECK((into_identity_id IS NULL)=(into_evidence_digest IS NULL)),
 CHECK(into_identity_id IS DISTINCT FROM identity_id)
);
CREATE TRIGGER catalog_card_identity_decision_append_only BEFORE UPDATE OR DELETE ON catalog_card_identity_decision
 FOR EACH ROW EXECUTE FUNCTION catalog_append_only();
CREATE INDEX catalog_card_identity_decision_identity ON catalog_card_identity_decision(identity_id,reviewed_at DESC);
CREATE INDEX catalog_card_identity_decision_into ON catalog_card_identity_decision(into_identity_id,reviewed_at DESC)
 WHERE into_identity_id IS NOT NULL;

-- A decision writes its records before its decision row, so the references are checked at commit.
CREATE TABLE catalog_reprint_group_link (
 printing_id uuid PRIMARY KEY REFERENCES catalog_printing(id) ON DELETE CASCADE,
 group_id uuid NOT NULL,
 decision_id uuid NOT NULL REFERENCES catalog_card_identity_decision(id) DEFERRABLE INITIALLY DEFERRED,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX catalog_reprint_group_link_group ON catalog_reprint_group_link(group_id);

CREATE TABLE catalog_reprint_group_assignment (
 printing_id uuid PRIMARY KEY REFERENCES catalog_printing(id) ON DELETE CASCADE,
 group_id uuid NOT NULL,
 decision_id uuid NOT NULL REFERENCES catalog_card_identity_decision(id) DEFERRABLE INITIALLY DEFERRED,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX catalog_reprint_group_assignment_group ON catalog_reprint_group_assignment(group_id);

-- A merged Card Identity keeps its row, so its key stays taken: catalog imports and manual approvals that meet the
-- key use the surviving identity (``coalesce(merged_into, id)``) instead of recreating the merged one. Earlier merges
-- into an identity that is merged later are repointed, so ``merged_into`` is never more than one step.
ALTER TABLE catalog_identity
 ADD COLUMN merged_into uuid REFERENCES catalog_identity(id),
 ADD COLUMN merge_decision_id uuid REFERENCES catalog_card_identity_decision(id) DEFERRABLE INITIALLY DEFERRED,
 ADD CONSTRAINT catalog_identity_merge_recorded CHECK((merged_into IS NULL)=(merge_decision_id IS NULL)),
 ADD CONSTRAINT catalog_identity_not_merged_into_itself CHECK(merged_into IS DISTINCT FROM id);

-- Every writer of a new Printing gets the surviving identity, including an older release whose identity upsert does not
-- read merged_into: a Printing is never created under a merged-away identity.
CREATE FUNCTION catalog_printing_surviving_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.identity_id := coalesce((SELECT merged_into FROM catalog_identity WHERE id = NEW.identity_id), NEW.identity_id);
 RETURN NEW;
END $$;
CREATE TRIGGER catalog_printing_surviving_identity BEFORE INSERT ON catalog_printing
 FOR EACH ROW EXECUTE FUNCTION catalog_printing_surviving_identity();

CREATE TABLE catalog_reprint_group_membership (
 printing_id uuid PRIMARY KEY REFERENCES catalog_printing(id) ON DELETE CASCADE,
 group_id uuid NOT NULL
);
CREATE INDEX catalog_reprint_group_membership_group ON catalog_reprint_group_membership(group_id);

-- Effective membership computed from the inputs. Only the sync function reads it; readers use the stored table.
CREATE VIEW catalog_reprint_group_effective AS
 WITH linked AS (
  SELECT d.group_id AS derived_group_id, (array_agg(l.group_id ORDER BY l.group_id))[1] AS group_id
  FROM catalog_reprint_group_link l JOIN catalog_derived_reprint_group d ON d.printing_id = l.printing_id
  GROUP BY d.group_id),
 assigned AS (
  -- Assignments that apply: to a Printing that derives a group, or to a manual Printing.
  SELECT a.printing_id, a.group_id FROM catalog_reprint_group_assignment a
  WHERE EXISTS (SELECT 1 FROM catalog_derived_reprint_group d WHERE d.printing_id = a.printing_id)
     OR EXISTS (SELECT 1 FROM catalog_printing p WHERE p.id = a.printing_id AND p.source = 'manual'))
 SELECT p.printing_id, coalesce(a.group_id, k.group_id, d.group_id) AS group_id
 FROM (SELECT printing_id FROM catalog_derived_reprint_group UNION SELECT printing_id FROM assigned) p
 LEFT JOIN catalog_derived_reprint_group d ON d.printing_id = p.printing_id
 LEFT JOIN linked k ON k.derived_group_id = d.group_id
 LEFT JOIN assigned a ON a.printing_id = p.printing_id;

CREATE FUNCTION catalog_sync_reprint_group_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- A statement that changed no row (an upsert's empty half, a zero-row UPDATE or DELETE) changes no input.
 IF NOT EXISTS (SELECT 1 FROM changed_rows) THEN
  RETURN NULL;
 END IF;
 -- Effective membership is written only after the commit-ordered public clock (migration 036's lock order; a no-op
 -- when the writer took it first, as every writer does). Then one recompute at a time, each from committed inputs:
 -- the next waits here until the previous transaction commits.
 PERFORM catalog_begin_correction();
 PERFORM 1 FROM catalog_attribute_state WHERE singleton FOR UPDATE;
 -- Same rule as the view: a Printing stays only while it derives a group or is a manual Printing with an assignment.
 DELETE FROM catalog_reprint_group_membership m
  WHERE NOT EXISTS (SELECT 1 FROM catalog_derived_reprint_group d WHERE d.printing_id = m.printing_id)
    AND NOT EXISTS (SELECT 1 FROM catalog_reprint_group_assignment a JOIN catalog_printing p ON p.id = a.printing_id
                    WHERE a.printing_id = m.printing_id AND p.source = 'manual');
 -- Only new or changed rows reach the upsert, so unchanged rows are neither locked nor rewritten.
 INSERT INTO catalog_reprint_group_membership AS m (printing_id, group_id)
  SELECT e.printing_id, e.group_id FROM catalog_reprint_group_effective e
  WHERE NOT EXISTS (SELECT 1 FROM catalog_reprint_group_membership x
                    WHERE x.printing_id = e.printing_id AND x.group_id = e.group_id)
  ON CONFLICT (printing_id) DO UPDATE SET group_id = EXCLUDED.group_id;
 RETURN NULL;
END $$;
-- One trigger per table and event, each naming its changed rows ``changed_rows`` for the empty-statement check.
CREATE TRIGGER catalog_derived_reprint_group_sync_insert AFTER INSERT ON catalog_derived_reprint_group
 REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION catalog_sync_reprint_group_membership();
CREATE TRIGGER catalog_derived_reprint_group_sync_update AFTER UPDATE ON catalog_derived_reprint_group
 REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION catalog_sync_reprint_group_membership();
CREATE TRIGGER catalog_derived_reprint_group_sync_delete AFTER DELETE ON catalog_derived_reprint_group
 REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION catalog_sync_reprint_group_membership();
CREATE TRIGGER catalog_reprint_group_link_sync_insert AFTER INSERT ON catalog_reprint_group_link
 REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION catalog_sync_reprint_group_membership();
CREATE TRIGGER catalog_reprint_group_link_sync_update AFTER UPDATE ON catalog_reprint_group_link
 REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION catalog_sync_reprint_group_membership();
CREATE TRIGGER catalog_reprint_group_link_sync_delete AFTER DELETE ON catalog_reprint_group_link
 REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION catalog_sync_reprint_group_membership();
CREATE TRIGGER catalog_reprint_group_assignment_sync_insert AFTER INSERT ON catalog_reprint_group_assignment
 REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION catalog_sync_reprint_group_membership();
CREATE TRIGGER catalog_reprint_group_assignment_sync_update AFTER UPDATE ON catalog_reprint_group_assignment
 REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION catalog_sync_reprint_group_membership();
CREATE TRIGGER catalog_reprint_group_assignment_sync_delete AFTER DELETE ON catalog_reprint_group_assignment
 REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION catalog_sync_reprint_group_membership();

-- Backfill: no reviewed records exist yet, so effective membership is the derived membership.
INSERT INTO catalog_reprint_group_membership (printing_id, group_id)
 SELECT printing_id, group_id FROM catalog_derived_reprint_group;

-- Re-stamp public format facts from effective membership (migration 036's function, same transition-table shape). The
-- backfill above changed no effective group, so it re-stamps nothing.
DROP TRIGGER stamp_format_facts_reprint_group_insert ON catalog_derived_reprint_group;
DROP TRIGGER stamp_format_facts_reprint_group_update ON catalog_derived_reprint_group;
DROP TRIGGER stamp_format_facts_reprint_group_delete ON catalog_derived_reprint_group;
CREATE TRIGGER stamp_format_facts_reprint_group_insert AFTER INSERT ON catalog_reprint_group_membership
 REFERENCING NEW TABLE AS new_rows
 FOR EACH STATEMENT EXECUTE FUNCTION stamp_format_facts_from_reprint_groups();
CREATE TRIGGER stamp_format_facts_reprint_group_update AFTER UPDATE ON catalog_reprint_group_membership
 REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
 FOR EACH STATEMENT EXECUTE FUNCTION stamp_format_facts_from_reprint_groups();
CREATE TRIGGER stamp_format_facts_reprint_group_delete AFTER DELETE ON catalog_reprint_group_membership
 REFERENCING OLD TABLE AS old_rows
 FOR EACH STATEMENT EXECUTE FUNCTION stamp_format_facts_from_reprint_groups();

-- Readers keep using this view and its two columns (migration 035); it now reads the stored effective membership.
-- api/tests/test_reprint_groups.py guards that both reader forms look rows up by index.
CREATE OR REPLACE VIEW catalog_reprint_group_member AS
  SELECT printing_id, group_id FROM catalog_reprint_group_membership;

-- Approval codes for these decisions name the Card Identity (metadata_target 'card_identity:<id>') with their own
-- actions, so no other code can be spent on them.
DO $$
DECLARE found record; dropped integer := 0;
BEGIN
 FOR found IN SELECT conname FROM pg_constraint
   WHERE conrelid='catalog_approval_code'::regclass AND contype='c'
     AND pg_get_constraintdef(oid) LIKE '%metadata_target%' AND pg_get_constraintdef(oid) LIKE '%rule:%'
 LOOP
  EXECUTE format('ALTER TABLE catalog_approval_code DROP CONSTRAINT %I', found.conname);
  dropped := dropped+1;
 END LOOP;
 IF dropped <> 1 THEN RAISE EXCEPTION 'Expected exactly one metadata_target constraint, found %', dropped; END IF;
END $$;
ALTER TABLE catalog_approval_code ADD CONSTRAINT catalog_approval_code_metadata_target
 CHECK(metadata_target ~ '^(edition|printing|card_identity):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR metadata_target ~ '^rule:(live_derivation|marketplace_matching):[0-9]{1,6}$');
ALTER TABLE catalog_approval_code DROP CONSTRAINT catalog_approval_code_action_check;
ALTER TABLE catalog_approval_code ADD CONSTRAINT catalog_approval_code_action_check
 CHECK(action IN ('approve_printing','approve_edition','confirm_source','resolve_catalog','resolve_metadata','activate_rule',
   'correct_attributes','review_reprint_groups','merge_card_identities'));
