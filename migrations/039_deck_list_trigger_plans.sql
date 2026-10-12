-- Plans each firing of migration 031's Deck List trigger for the rows it carries. A trigger statement takes no
-- parameters, so PL/pgSQL plans a static statement on its trigger's first firing in a session and keeps that plan until
-- the tables' definitions or statistics change; plan_cache_mode does not apply to a statement without parameters. When
-- the first firing is empty the plan assumes one transition row, and the planner may join deck_list_line with a nested
-- loop over a sequential scan. A later statement that raises 25,000 Holdings in one Deck then scans 25,000 lines 25,000
-- times (34 s on a CI runner). EXECUTE plans its statement on every firing, with the transition tables' real row counts
-- and the tables' current sizes, for a fraction of a millisecond per statement. The SQL is 031's, unchanged.
CREATE OR REPLACE FUNCTION deck_list_cover_holdings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
