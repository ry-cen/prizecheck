-- Multi-source Move, Removal and Undo (collector workspace spec, ADR 0005).
-- Expand-only: the previous application keeps working against this schema,
-- because the release gate runs its CI here and rollback runs it here too.
-- Wait for in-flight staging so no item is missed by the copy below.
LOCK TABLE move_manifest, move_manifest_item IN SHARE ROW EXCLUSIVE MODE;

-- A manifest may start without a default source.
ALTER TABLE move_manifest ALTER COLUMN source_id DROP NOT NULL;

-- Staged items carry their own source Storage Leaf. move_manifest_item stays for
-- the previous application, whose staging names ON CONFLICT (owner_id,edition_id).
-- source_id has no foreign key on purpose: a deleted source must fail the commit
-- with LOCATION_NOT_FOUND, never silently drop its staged items.
CREATE TABLE move_manifest_entry (
  owner_id text NOT NULL REFERENCES move_manifest(owner_id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  edition_id uuid NOT NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  expected_version bigint NOT NULL CHECK (expected_version > 0),
  PRIMARY KEY (owner_id, source_id, edition_id)
);

-- Live single-source manifests keep working: their items take the manifest's source.
INSERT INTO move_manifest_entry(owner_id,source_id,edition_id,quantity,expected_version)
  SELECT i.owner_id,m.source_id,i.edition_id,i.quantity,i.expected_version
  FROM move_manifest_item i JOIN move_manifest m ON m.owner_id=i.owner_id
  WHERE m.source_id IS NOT NULL;

-- Items the previous application stages after this migration (before activation,
-- or during process overlap) reach the new table too.
CREATE FUNCTION mirror_move_manifest_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO move_manifest_entry(owner_id,source_id,edition_id,quantity,expected_version)
    SELECT n.owner_id,m.source_id,n.edition_id,n.quantity,n.expected_version
    FROM staged n JOIN move_manifest m ON m.owner_id=n.owner_id
    WHERE m.source_id IS NOT NULL
    ON CONFLICT (owner_id,source_id,edition_id) DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER move_manifest_item_mirror AFTER INSERT ON move_manifest_item
  REFERENCING NEW TABLE AS staged FOR EACH STATEMENT EXECUTE FUNCTION mirror_move_manifest_item();

-- Replay keeps the new result fields. The defaults are exact for every earlier
-- writer (single-source Moves, Removals, Undo and Edition reassignment).
ALTER TABLE move_response
  ADD COLUMN source_count integer NOT NULL DEFAULT 1 CHECK (source_count > 0),
  ADD COLUMN already_at_destination_count numeric(30,0) NOT NULL DEFAULT 0
    CHECK (already_at_destination_count >= 0);

-- Undo payload items are {edition_id, quantity} (source is the record's source_id)
-- or {source_id, edition_id, quantity}. source_id on the record is set only when
-- one source was involved, so the previous application treats a multi-source
-- record as incompatible instead of misapplying it.
ALTER TABLE inventory_undo
  ALTER COLUMN source_id DROP NOT NULL,
  ADD COLUMN source_count integer NOT NULL DEFAULT 1 CHECK (source_count > 0),
  ADD CONSTRAINT inventory_undo_source_present CHECK (source_id IS NOT NULL OR source_count > 1);
