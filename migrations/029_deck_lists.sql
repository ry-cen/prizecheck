-- Every Deck has a Deck List (ADR 0009): the Card Editions and quantities the collector intends it to contain.
-- Lines may name cards the collector does not own; they never count toward the Collection.
-- Writers wait while existing Decks are converted, so the conversion sees one consistent set of Holdings.
LOCK TABLE location IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE holding IN SHARE MODE;

CREATE TABLE deck_list (
  owner_id text NOT NULL,
  deck_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (owner_id, deck_id),
  FOREIGN KEY (owner_id, deck_id) REFERENCES location(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE deck_list_line (
  owner_id text NOT NULL,
  deck_id uuid NOT NULL,
  edition_id uuid NOT NULL REFERENCES catalog_edition(id),
  quantity bigint NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (owner_id, deck_id, edition_id),
  FOREIGN KEY (owner_id, deck_id) REFERENCES deck_list(owner_id, deck_id) ON DELETE CASCADE
);

-- Any Deck inserted from now on, by this release or by an older application still serving during a release or after
-- a rollback, starts with an empty Deck List.
CREATE FUNCTION create_deck_list() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO deck_list(owner_id, deck_id) VALUES (NEW.owner_id, NEW.id) ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER location_deck_list AFTER INSERT ON location
  FOR EACH ROW WHEN (NEW.kind = 'deck') EXECUTE FUNCTION create_deck_list();

-- One-time conversion: each existing Deck gets one line per Card Edition it holds, at the held quantity.
-- An Unspecified Variant Holding becomes a line naming that same Edition.
INSERT INTO deck_list(owner_id, deck_id)
  SELECT owner_id, id FROM location WHERE kind = 'deck';
INSERT INTO deck_list_line(owner_id, deck_id, edition_id, quantity)
  SELECT h.owner_id, h.location_id, h.edition_id, h.quantity
  FROM holding h JOIN location l ON l.owner_id = h.owner_id AND l.id = h.location_id
  WHERE l.kind = 'deck';
