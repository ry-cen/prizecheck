-- Borrowed Copies: the copies a borrower confirmed receiving, in their own Locations (social network #253, spec
-- "Borrower-side data: a separate table"). Never in holding, so the borrower's Collection, totals, Removal and Undo
-- never see them. Social network migrations use the reserved block 100-139 (docs/planning/social-network/migrations.md).
-- Re-runnable.

-- One row per Loan, Location and Card Edition. The composite foreign key keeps every row in one of the borrower's own
-- Locations; a Location that holds Borrowed Copies can't be deleted (Deck deletion moves them to Unsorted first, leaf
-- conversion to the new child). Deck List growth from Borrowed Copies (the shared Deck List function) is #254's.
CREATE TABLE IF NOT EXISTS borrowed_holding (
  id bigserial PRIMARY KEY,
  loan_id uuid NOT NULL REFERENCES loan(id),
  borrower_id text NOT NULL REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  edition_id uuid NOT NULL REFERENCES catalog_edition(id),
  quantity bigint NOT NULL CHECK (quantity > 0),
  CONSTRAINT borrowed_holding_location FOREIGN KEY (borrower_id, location_id) REFERENCES location(owner_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT borrowed_holding_once UNIQUE (loan_id, location_id, edition_id)
);
CREATE INDEX IF NOT EXISTS borrowed_holding_place ON borrowed_holding(borrower_id, location_id);
CREATE INDEX IF NOT EXISTS borrowed_holding_location_index ON borrowed_holding(location_id);

-- A Borrowed Copy sits in a Storage Leaf or a Deck, as a Holding does (migration 006's holding_leaf_guard).
CREATE OR REPLACE FUNCTION borrowed_holding_leaf_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM location l
    WHERE l.owner_id = NEW.borrower_id AND l.id = NEW.location_id
      AND l.kind IN ('storage_leaf', 'deck')
      AND NOT EXISTS (SELECT 1 FROM location child WHERE child.parent_id = l.id)
  ) THEN
    RAISE EXCEPTION 'A Borrowed Copy requires one of the borrower''s Storage Leaves' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS borrowed_holding_leaf_guard_trigger ON borrowed_holding;
CREATE CONSTRAINT TRIGGER borrowed_holding_leaf_guard_trigger
  AFTER INSERT OR UPDATE ON borrowed_holding DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION borrowed_holding_leaf_guard();
