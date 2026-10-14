-- Undoing a Put away returns its copies to the Deck as surplus (app redesign #180, owner decision 2026-10-14). Put away
-- moves copies cut from a Deck's Deck List out to a Location; its Undo used to bring them back listed, because
-- migration 031's trigger covers every copy arriving in a Deck. Deck List Undo and inventory Undo never undo each
-- other (app redesign spec, "Edits and Undo"), so an inventory Undo of a Put away now leaves the Deck List as it is.
--
-- The deck builder marks its Put away Move (`put_away` on the commit command, accepted only for a Move out of one
-- Deck) and the Move's Inventory Undo record keeps the mark in the new column. Undoing a marked record sets the
-- transaction-local setting tcg.undo_returns_surplus to 'on' for the one statement that returns the copies, and the
-- trigger below covers nothing while it is on. Every other writer (Add, batch add, Move, Pick List confirmation,
-- Edition reassignment, the Undo of any unmarked record, and an older application) never sets it, so they keep
-- migration 031's rule. set_config(..., true) ends with the transaction, so a pooled connection never carries it on.
--
-- Expand-only, as 046: the previous application never writes the column (its records default to false) and never sets
-- the setting, so during an activation overlap or after a rollback it behaves as before this migration, including
-- re-listing the copies when it undoes a Put away recorded by this release.
--
-- The function body is 039's (EXECUTE, planned on every firing), with the early return added.
ALTER TABLE inventory_undo ADD COLUMN returns_as_surplus boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION deck_list_cover_holdings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Set (transaction-local) only around the statement with which undo_inventory returns a Put away's copies.
  IF current_setting('tcg.undo_returns_surplus', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    EXECUTE $sql$
    WITH arrived AS (
      SELECT n.owner_id, n.location_id AS deck_id, n.edition_id, 0::bigint AS before, n.quantity AS added
      FROM new_holding n JOIN deck_list d ON d.owner_id = n.owner_id AND d.deck_id = n.location_id
    ), wanted AS (
      SELECT a.owner_id, a.deck_id, a.edition_id, coalesce(l.quantity, 0) AS listed,
        greatest(coalesce(l.quantity, 0), least(coalesce(l.quantity, 0), a.before) + a.added) AS quantity
      FROM arrived a LEFT JOIN deck_list_line l
        ON l.owner_id = a.owner_id AND l.deck_id = a.deck_id AND l.edition_id = a.edition_id
    ), covered AS (
      INSERT INTO deck_list_line AS l (owner_id, deck_id, edition_id, quantity)
      SELECT owner_id, deck_id, edition_id, quantity FROM wanted WHERE quantity > listed
      ON CONFLICT (owner_id, deck_id, edition_id) DO UPDATE SET quantity = greatest(l.quantity, EXCLUDED.quantity)
      RETURNING l.owner_id, l.deck_id
    )
    UPDATE deck_list d SET revision = d.revision + 1
    FROM (SELECT DISTINCT owner_id, deck_id FROM covered) c
    WHERE d.owner_id = c.owner_id AND d.deck_id = c.deck_id
    $sql$;
  ELSE
    -- Old and new rows are paired by key: an updated Holding keeps its key except when a whole Storage Leaf's
    -- Holdings are relocated, and a Holding with no old row under the same key arrived whole. Pairing by aggregation
    -- rather than a join keeps the cost linear in the transition tables.
    EXECUTE $sql$
    WITH changed AS (
      SELECT n.owner_id, n.location_id, n.edition_id, 0::bigint AS before, n.quantity AS after FROM new_holding n
      WHERE EXISTS (SELECT 1 FROM deck_list d WHERE d.owner_id = n.owner_id AND d.deck_id = n.location_id)
      UNION ALL
      SELECT o.owner_id, o.location_id, o.edition_id, o.quantity, 0::bigint FROM old_holding o
      WHERE EXISTS (SELECT 1 FROM deck_list d WHERE d.owner_id = o.owner_id AND d.deck_id = o.location_id)
    ), arrived AS (
      SELECT owner_id, location_id AS deck_id, edition_id, sum(before)::bigint AS before,
        (sum(after) - sum(before))::bigint AS added
      FROM changed GROUP BY owner_id, location_id, edition_id
      HAVING sum(after) > sum(before)
    ), wanted AS (
      SELECT a.owner_id, a.deck_id, a.edition_id, coalesce(l.quantity, 0) AS listed,
        greatest(coalesce(l.quantity, 0), least(coalesce(l.quantity, 0), a.before) + a.added) AS quantity
      FROM arrived a LEFT JOIN deck_list_line l
        ON l.owner_id = a.owner_id AND l.deck_id = a.deck_id AND l.edition_id = a.edition_id
    ), covered AS (
      INSERT INTO deck_list_line AS l (owner_id, deck_id, edition_id, quantity)
      SELECT owner_id, deck_id, edition_id, quantity FROM wanted WHERE quantity > listed
      ON CONFLICT (owner_id, deck_id, edition_id) DO UPDATE SET quantity = greatest(l.quantity, EXCLUDED.quantity)
      RETURNING l.owner_id, l.deck_id
    )
    UPDATE deck_list d SET revision = d.revision + 1
    FROM (SELECT DISTINCT owner_id, deck_id FROM covered) c
    WHERE d.owner_id = c.owner_id AND d.deck_id = c.deck_id
    $sql$;
  END IF;
  RETURN NULL;
END $$;
