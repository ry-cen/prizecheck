-- For trade Locations (Trading #267, spec "For trade Locations and the Trade List"). Trading migrations use the
-- reserved block 140-179 (docs/planning/trading/migrations.md). Re-runnable, and it only adds objects.

-- The collector's own choice for this Location. Everything inside a marked Location is For trade too, apart from
-- Decks; that is worked out when read (for_trade_locations below, and location_tree's for_trade_by), never stored, so
-- a Location added or moved inside a marked one is For trade at once. Independent of location.hidden. Marking never
-- moves the inventory revision and reserves nothing.
ALTER TABLE location ADD COLUMN IF NOT EXISTS for_trade boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS location_for_trade ON location(owner_id) WHERE for_trade;

-- A Deck can never be marked (location_tree.set_location_for_trade refuses it first, with DECK_NOT_FOR_TRADE).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'location'::regclass
                   AND conname = 'location_deck_not_for_trade') THEN
    ALTER TABLE location ADD CONSTRAINT location_deck_not_for_trade CHECK (NOT for_trade OR kind <> 'deck');
  END IF;
END $$;

-- Every Location of the given owners whose cards are offered for trade: each Location the owner marked and every
-- Location inside it, at any depth, except Decks, which are never on a Trade List, even inside a marked Location. The
-- one definition of "effectively For trade" (ADR 0015). Walks location_owner_parent from each marked Location, as
-- hidden_locations (migration 101) does.
CREATE OR REPLACE FUNCTION for_trade_locations(owners text[])
RETURNS TABLE(owner_id text, location_id uuid) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE marked(owner_id, location_id, kind) AS (
    SELECT l.owner_id, l.id, l.kind FROM location l WHERE l.owner_id = ANY(owners) AND l.for_trade
    UNION
    SELECT c.owner_id, c.id, c.kind FROM location c JOIN marked m ON c.owner_id = m.owner_id AND c.parent_id = m.location_id
  )
  SELECT marked.owner_id, marked.location_id FROM marked WHERE marked.kind <> 'deck'
$$;
