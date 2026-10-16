-- Borrowed Copies grow a Deck List as owned copies do (social network #254, spec "Borrower-side data: a separate table"
-- and "Inventory touch-points"). Social network migrations use the reserved block 100-139
-- (docs/planning/social-network/migrations.md). Re-runnable.
--
-- The rule of migrations 031, 039 and 047 moves into one function, deck_list_cover, which both Deck List triggers call:
-- the holding trigger (rewired here, behaviour unchanged) and a new one on borrowed_holding. Copies arriving in a Deck
-- raise its line to cover them, counting the copies already there up to the line. "Already there" is the Deck's
-- physical copies of the Edition before the statement, owned and borrowed together, so a Borrowed Copy that arrives
-- in a Deck whose line its owned copies fill raises the line exactly as an owned copy would. Without Borrowed Copies
-- the figure is the old one: a Holding's quantity before the statement.
--
-- Copies leaving a Deck change no line. 047's transaction-local setting tcg.undo_returns_surplus still switches the
-- holding trigger off around the statement that returns copies as surplus (a Put away's Undo, a lender's take-back
-- or return); it never applies to Borrowed Copies, which nothing returns as surplus.
--
-- No 05x migration on dev or feature/collection-import redefines deck_list_cover_holdings after 047, so the order the
-- two branches apply in leaves this definition.

-- The one Deck List rule. Each arrival is (owner, Deck, Edition, copies added); arrivals outside a Deck with a Deck
-- List, and non-positive ones, cover nothing. Planned on every call (EXECUTE), as 039's trigger statement is.
CREATE OR REPLACE FUNCTION deck_list_cover(owners text[], decks uuid[], editions uuid[], added bigint[])
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE $sql$
  WITH arrived AS (
    SELECT a.owner_id, a.deck_id, a.edition_id, sum(a.added)::bigint AS added
    FROM unnest($1::text[], $2::uuid[], $3::uuid[], $4::bigint[]) AS a(owner_id, deck_id, edition_id, added)
    WHERE a.added > 0
      AND EXISTS (SELECT 1 FROM deck_list d WHERE d.owner_id = a.owner_id AND d.deck_id = a.deck_id)
    GROUP BY a.owner_id, a.deck_id, a.edition_id
  ), held AS (
    SELECT a.owner_id, a.deck_id, a.edition_id, a.added,
      coalesce(h.quantity, 0) + coalesce((SELECT sum(b.quantity) FROM borrowed_holding b
        WHERE b.borrower_id = a.owner_id AND b.location_id = a.deck_id AND b.edition_id = a.edition_id), 0) AS now_held
    FROM arrived a LEFT JOIN holding h
      ON h.owner_id = a.owner_id AND h.location_id = a.deck_id AND h.edition_id = a.edition_id
  ), wanted AS (
    SELECT p.owner_id, p.deck_id, p.edition_id, coalesce(l.quantity, 0) AS listed,
      greatest(coalesce(l.quantity, 0), least(coalesce(l.quantity, 0), p.now_held - p.added) + p.added) AS quantity
    FROM held p LEFT JOIN deck_list_line l
      ON l.owner_id = p.owner_id AND l.deck_id = p.deck_id AND l.edition_id = p.edition_id
  ), covered AS (
    INSERT INTO deck_list_line AS l (owner_id, deck_id, edition_id, quantity)
    SELECT owner_id, deck_id, edition_id, quantity FROM wanted WHERE quantity > listed
    ON CONFLICT (owner_id, deck_id, edition_id) DO UPDATE SET quantity = greatest(l.quantity, EXCLUDED.quantity)
    RETURNING l.owner_id, l.deck_id
  )
  UPDATE deck_list d SET revision = d.revision + 1
  FROM (SELECT DISTINCT owner_id, deck_id FROM covered) c
  WHERE d.owner_id = c.owner_id AND d.deck_id = c.deck_id
  $sql$ USING owners, decks, editions, added;
END $$;

-- The holding trigger (migration 031's triggers call it): 047's arrivals, handed to the shared rule.
CREATE OR REPLACE FUNCTION deck_list_cover_holdings() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owners text[];
  decks uuid[];
  editions uuid[];
  added bigint[];
BEGIN
  -- Set (transaction-local) only around the statement that returns copies to a Deck as surplus.
  IF current_setting('tcg.undo_returns_surplus', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    EXECUTE $sql$
    SELECT array_agg(n.owner_id), array_agg(n.location_id), array_agg(n.edition_id), array_agg(n.quantity::bigint)
    FROM new_holding n
    WHERE EXISTS (SELECT 1 FROM deck_list d WHERE d.owner_id = n.owner_id AND d.deck_id = n.location_id)
    $sql$ INTO owners, decks, editions, added;
  ELSE
    -- Old and new rows are paired by key, as in 047: a Holding with no old row under the same key arrived whole.
    EXECUTE $sql$
    WITH changed AS (
      SELECT n.owner_id, n.location_id, n.edition_id, 0::bigint AS before, n.quantity AS after FROM new_holding n
      WHERE EXISTS (SELECT 1 FROM deck_list d WHERE d.owner_id = n.owner_id AND d.deck_id = n.location_id)
      UNION ALL
      SELECT o.owner_id, o.location_id, o.edition_id, o.quantity, 0::bigint FROM old_holding o
      WHERE EXISTS (SELECT 1 FROM deck_list d WHERE d.owner_id = o.owner_id AND d.deck_id = o.location_id)
    ), arrived AS (
      SELECT owner_id, location_id, edition_id, (sum(after) - sum(before))::bigint AS added
      FROM changed GROUP BY owner_id, location_id, edition_id
      HAVING sum(after) > sum(before)
    )
    SELECT array_agg(owner_id), array_agg(location_id), array_agg(edition_id), array_agg(added) FROM arrived
    $sql$ INTO owners, decks, editions, added;
  END IF;
  IF owners IS NOT NULL THEN
    PERFORM deck_list_cover(owners, decks, editions, added);
  END IF;
  RETURN NULL;
END $$;

-- The borrowed_holding trigger: Borrowed Copies arriving in one of the borrower's Decks, by (borrower, Location,
-- Edition) whatever Loan they belong to.
CREATE OR REPLACE FUNCTION deck_list_cover_borrowed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owners text[];
  decks uuid[];
  editions uuid[];
  added bigint[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    EXECUTE $sql$
    SELECT array_agg(n.borrower_id), array_agg(n.location_id), array_agg(n.edition_id), array_agg(n.quantity::bigint)
    FROM new_borrowed n
    WHERE EXISTS (SELECT 1 FROM deck_list d WHERE d.owner_id = n.borrower_id AND d.deck_id = n.location_id)
    $sql$ INTO owners, decks, editions, added;
  ELSE
    EXECUTE $sql$
    WITH changed AS (
      SELECT n.borrower_id, n.location_id, n.edition_id, 0::bigint AS before, n.quantity AS after FROM new_borrowed n
      WHERE EXISTS (SELECT 1 FROM deck_list d WHERE d.owner_id = n.borrower_id AND d.deck_id = n.location_id)
      UNION ALL
      SELECT o.borrower_id, o.location_id, o.edition_id, o.quantity, 0::bigint FROM old_borrowed o
      WHERE EXISTS (SELECT 1 FROM deck_list d WHERE d.owner_id = o.borrower_id AND d.deck_id = o.location_id)
    ), arrived AS (
      SELECT borrower_id, location_id, edition_id, (sum(after) - sum(before))::bigint AS added
      FROM changed GROUP BY borrower_id, location_id, edition_id
      HAVING sum(after) > sum(before)
    )
    SELECT array_agg(borrower_id), array_agg(location_id), array_agg(edition_id), array_agg(added) FROM arrived
    $sql$ INTO owners, decks, editions, added;
  END IF;
  IF owners IS NOT NULL THEN
    PERFORM deck_list_cover(owners, decks, editions, added);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS borrowed_holding_deck_list_insert ON borrowed_holding;
CREATE TRIGGER borrowed_holding_deck_list_insert AFTER INSERT ON borrowed_holding
  REFERENCING NEW TABLE AS new_borrowed
  FOR EACH STATEMENT EXECUTE FUNCTION deck_list_cover_borrowed();
DROP TRIGGER IF EXISTS borrowed_holding_deck_list_update ON borrowed_holding;
CREATE TRIGGER borrowed_holding_deck_list_update AFTER UPDATE ON borrowed_holding
  REFERENCING OLD TABLE AS old_borrowed NEW TABLE AS new_borrowed
  FOR EACH STATEMENT EXECUTE FUNCTION deck_list_cover_borrowed();
