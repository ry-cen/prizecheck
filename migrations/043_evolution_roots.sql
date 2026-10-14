-- Evolution roots (app redesign #176). The deck builder groups a Deck List's Pokémon by evolution line. Each Pokémon's
-- evolves from (migration 041) names only the stage before it, so api/app/evolution_roots.py follows it through the
-- catalog to the first Pokémon of the line, once per Card Identity, and stores the result here: the root's display name
-- and the number of steps from it (0 for the root itself). Deck reads join it by Card Identity key.
--
-- It is catalog data derived from evolves from, which is not a card attribute: writing it advances no revision, re-stamps
-- no public format fact and leaves saved format results and stored Format Standing (migration 042) current.
--
-- This migration creates the table empty. Until scripts/derive_card_attributes.py or the next catalog import fills it,
-- every line's root reads null and the deck builder groups Pokémon by each line's own evolves from, as before; a deck
-- that skips a stage shows its Pokémon apart. An older release ignores the table.
--
-- Safe to run again: the table is created only if missing, with its checks.

CREATE TABLE IF NOT EXISTS catalog_evolution_root (
  identity_key text PRIMARY KEY,
  root_name text NOT NULL CHECK (length(root_name) > 0),
  stage smallint NOT NULL CHECK (stage BETWEEN 0 AND 4)
);
