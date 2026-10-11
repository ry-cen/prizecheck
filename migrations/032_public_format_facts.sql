-- Public format facts (Deck Lists 18). Each Card Printing's public catalog records gain a `catalog:format:<ref>` record
-- (api/app/public_catalog.py): its set and collector number, Card Identity, Reprint Group (its public reference and the
-- public references of the group's printings) and effective card attributes, so anonymous Published Deck format checks
-- never read PostgreSQL. The record shares the Printing's `public_revision` and outbox target with
-- `catalog:printing:<ref>`, so every change to a fact it carries must re-stamp the Printing in the same transaction.
-- These triggers do that for every writer, the way migration 023's triggers stamp Live and marketplace changes: derived
-- attributes, reviewed attribute corrections, a Printing's Card Identity, an identity's key or name, and Reprint Group
-- membership (migration 031).
--
-- A Reprint Group change re-stamps the Printings that moved and every Printing of the groups they left and joined,
-- because each member's record lists the group's printings. The member list is the private format check's
-- (api/app/deck_format_checks.py MEMBERS): the group's printings that the active catalog generation holds and has not
-- withdrawn. Only catalog imports change generations and tombstones, and each runs refresh_reprint_groups in the same
-- transaction, which removes withdrawn and absent printings from their groups; so a membership row change is the only
-- way a member list changes. Maintainer-reviewed merges and splits (ticket 14) that redefine catalog_reprint_group_member
-- must call catalog_stamp_format_facts for the same Printings.
--
-- Lock order: catalog_begin_correction() locks the public clock row until commit. Every writer of these tables takes
-- the clock first (catalog imports, attribute decisions, scripts/derive_card_attributes.py), so the lazy call here
-- never waits for the clock while holding a row another clock holder needs.

CREATE FUNCTION catalog_stamp_format_facts(printing_ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r bigint;
BEGIN
 IF printing_ids IS NULL OR cardinality(printing_ids) = 0 THEN
  RETURN;
 END IF;
 r := catalog_begin_correction();
 -- stamp_printing_metadata leaves this revision alone (the Live tuple is unchanged) and enqueue_metadata_outbox
 -- enqueues the Printing because its public_revision moved. A Printing already stamped in this transaction is
 -- already enqueued at this revision.
 UPDATE catalog_printing_metadata SET public_revision = r
  WHERE printing_id = ANY(printing_ids) AND public_revision <> r;
END $$;

-- Derived attributes and corrections have the same attribute columns. A rules_version-only rewrite changes no fact.
CREATE FUNCTION stamp_format_facts_from_attributes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND (NEW.printing_id, NEW.regulation_mark, NEW.card_kind, NEW.basic_energy, NEW.types, NEW.rule_box,
     NEW.ace_spec, NEW.radiant, NEW.prism_star)
    IS NOT DISTINCT FROM (OLD.printing_id, OLD.regulation_mark, OLD.card_kind, OLD.basic_energy, OLD.types, OLD.rule_box,
     OLD.ace_spec, OLD.radiant, OLD.prism_star) THEN
  RETURN NULL;
 END IF;
 IF TG_OP IN ('UPDATE', 'DELETE') THEN
  PERFORM catalog_stamp_format_facts(ARRAY[OLD.printing_id]);
 END IF;
 IF TG_OP IN ('INSERT', 'UPDATE') THEN
  PERFORM catalog_stamp_format_facts(ARRAY[NEW.printing_id]);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER stamp_format_facts_derived AFTER INSERT OR UPDATE OR DELETE ON catalog_derived_attribute
 FOR EACH ROW EXECUTE FUNCTION stamp_format_facts_from_attributes();
CREATE TRIGGER stamp_format_facts_correction AFTER INSERT OR UPDATE OR DELETE ON catalog_attribute_correction
 FOR EACH ROW EXECUTE FUNCTION stamp_format_facts_from_attributes();

-- A Printing moved to another Card Identity (a reviewed identity merge, ticket 14).
CREATE FUNCTION stamp_format_facts_from_printing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM catalog_stamp_format_facts(ARRAY[NEW.id]);
 RETURN NULL;
END $$;
CREATE TRIGGER stamp_format_facts_identity_change AFTER UPDATE OF identity_id ON catalog_printing
 FOR EACH ROW WHEN (OLD.identity_id IS DISTINCT FROM NEW.identity_id)
 EXECUTE FUNCTION stamp_format_facts_from_printing();

-- A Card Identity re-keyed or renamed: every Printing of it publishes the new key and name.
CREATE FUNCTION stamp_format_facts_from_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM catalog_stamp_format_facts(ARRAY(SELECT id FROM catalog_printing WHERE identity_id = NEW.id));
 RETURN NULL;
END $$;
CREATE TRIGGER stamp_format_facts_identity AFTER UPDATE ON catalog_identity
 FOR EACH ROW WHEN (OLD.identity_key IS DISTINCT FROM NEW.identity_key OR OLD.display_name IS DISTINCT FROM NEW.display_name)
 EXECUTE FUNCTION stamp_format_facts_from_identity();

-- Reprint Group membership (migration 031). Statement triggers with transition tables: one import or rederivation can
-- write the groups of the whole catalog in one statement, and the Printings of every touched group are stamped once.
-- An UPDATE that keeps the group (a text_key or rules_version rewrite) changes no fact. The members are looked up in the
-- effective membership view by group_id, which is indexed (migration 031).
CREATE FUNCTION stamp_format_facts_from_reprint_groups() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE moved uuid[]; groups uuid[];
BEGIN
 IF TG_OP = 'INSERT' THEN
  SELECT array_agg(printing_id), array_agg(DISTINCT group_id) INTO moved, groups FROM new_rows;
 ELSIF TG_OP = 'DELETE' THEN
  SELECT array_agg(printing_id), array_agg(DISTINCT group_id) INTO moved, groups FROM old_rows;
 ELSE
  SELECT array_agg(DISTINCT n.printing_id), array_agg(DISTINCT g.group_id) INTO moved, groups
   FROM old_rows o JOIN new_rows n ON n.printing_id = o.printing_id
   CROSS JOIN LATERAL (VALUES (o.group_id), (n.group_id)) AS g(group_id)
   WHERE o.group_id IS DISTINCT FROM n.group_id;
 END IF;
 IF moved IS NULL THEN
  RETURN NULL;
 END IF;
 PERFORM catalog_stamp_format_facts(moved || ARRAY(
  SELECT printing_id FROM catalog_reprint_group_member WHERE group_id = ANY(groups)));
 RETURN NULL;
END $$;
CREATE TRIGGER stamp_format_facts_reprint_group_insert AFTER INSERT ON catalog_derived_reprint_group
 REFERENCING NEW TABLE AS new_rows
 FOR EACH STATEMENT EXECUTE FUNCTION stamp_format_facts_from_reprint_groups();
CREATE TRIGGER stamp_format_facts_reprint_group_update AFTER UPDATE ON catalog_derived_reprint_group
 REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
 FOR EACH STATEMENT EXECUTE FUNCTION stamp_format_facts_from_reprint_groups();
CREATE TRIGGER stamp_format_facts_reprint_group_delete AFTER DELETE ON catalog_derived_reprint_group
 REFERENCING OLD TABLE AS old_rows
 FOR EACH STATEMENT EXECUTE FUNCTION stamp_format_facts_from_reprint_groups();
