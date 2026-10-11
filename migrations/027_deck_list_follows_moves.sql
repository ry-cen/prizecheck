-- Copies moved into a Deck join its Deck List (ADR 0009): every statement that raises a Holding in a Deck adds or
-- raises that Edition's line so the copies it added are covered. Moves out of a Deck, Inventory Removals and undoing a
-- Move into a Deck only lower Holdings and never change a line.
--
-- This is a trigger rather than application code for the same reason as 025's Deck List trigger: an older application
-- still serving during a release, or after a rollback, writes Holdings into Decks without knowing about Deck Lists.
-- It also covers every current writer (Add, Move commit, undo, Edition reassignment) and any later one in one place.
--
-- With ``before`` copies held, ``added`` copies arriving and a line of ``listed`` copies (0 without a line), the line
-- becomes greatest(listed, least(listed, before) + added). A line that already covers the new copies, such as one a
-- Pick List is filling, is left alone; copies the collector cut from the list stay surplus. The result never exceeds
-- the Holding's new quantity, so it cannot overflow. A Deck whose lines changed advances its Deck List revision; a
-- statement that changes no line leaves it alone.
CREATE FUNCTION deck_list_cover_holdings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
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
    WHERE d.owner_id = c.owner_id AND d.deck_id = c.deck_id;
  ELSE
    -- Old and new rows are paired by key: an updated Holding keeps its key except when a whole Storage Leaf's
    -- Holdings are relocated, and a Holding with no old row under the same key arrived whole. Pairing by aggregation
    -- rather than a join keeps the cost linear whatever row counts the planner assumes for the transition tables.
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
    WHERE d.owner_id = c.owner_id AND d.deck_id = c.deck_id;
  END IF;
  RETURN NULL;
END $$;

-- PostgreSQL allows transition tables only on single-event triggers, so inserts and updates each get one.
-- INSERT ... ON CONFLICT DO UPDATE fires both: inserted rows reach the first, updated rows the second.
CREATE TRIGGER holding_deck_list_insert AFTER INSERT ON holding
  REFERENCING NEW TABLE AS new_holding
  FOR EACH STATEMENT EXECUTE FUNCTION deck_list_cover_holdings();
CREATE TRIGGER holding_deck_list_update AFTER UPDATE ON holding
  REFERENCING OLD TABLE AS old_holding NEW TABLE AS new_holding
  FOR EACH STATEMENT EXECUTE FUNCTION deck_list_cover_holdings();
