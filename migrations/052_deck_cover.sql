-- Deck cover (#291): the cover card a collector picked for a Deck, shown on the Decks index tile.
--
-- No row means the cover is automatic, worked out at read time from the Deck List lines. The foreign key to the Deck
-- List line clears the pick whenever its line leaves the Deck List, from every writer, in the same transaction.
--
-- There is deliberately no foreign key to catalog_edition: the catalog reset's TRUNCATE ... CASCADE would otherwise
-- reach Deck Lists. A reset reaches this table only through deck_list_line.
--
-- An older release ignores the table. Safe to run again: the table is created only if missing.

CREATE TABLE IF NOT EXISTS deck_cover (
  owner_id text NOT NULL,
  deck_id uuid NOT NULL,
  edition_id uuid NOT NULL,
  PRIMARY KEY (owner_id, deck_id),
  FOREIGN KEY (owner_id, deck_id, edition_id)
    REFERENCES deck_list_line(owner_id, deck_id, edition_id) ON DELETE CASCADE
);
