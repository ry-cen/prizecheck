-- Card attributes: each Card Printing's regulation mark, card kind, Basic Energy status, types, and Rule Box,
-- ACE SPEC, Radiant and Prism Star status. The rules in api/app/card_attributes.py derive them from the Printing's
-- catalog source record. NULL means unknown: missing or contradictory source data is never guessed, and manually
-- approved Printings have no derived row.
-- Only app.card_attributes.refresh_card_attributes writes derived rows; every catalog import runs it, and so does
-- scripts/derive_card_attributes.py. A migration cannot run the Python rules, so Printings that exist before this
-- migration stay unknown until that script or the next catalog import runs.

-- One revision for the catalog facts format checks read: card attributes now, Reprint Groups later.
-- It advances once per transaction that changes any Printing's attributes.
CREATE TABLE catalog_attribute_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0)
);
INSERT INTO catalog_attribute_state DEFAULT VALUES;

CREATE TABLE catalog_derived_attribute (
  printing_id uuid PRIMARY KEY REFERENCES catalog_printing(id) ON DELETE CASCADE,
  rules_version integer NOT NULL CHECK (rules_version > 0),
  regulation_mark text CHECK (regulation_mark ~ '^[A-Z]$'),
  card_kind text CHECK (card_kind IN ('pokemon', 'trainer', 'energy')),
  basic_energy boolean,
  -- Pokémon types in source order; empty for Trainer and Energy cards.
  types text[] CHECK (array_position(types, NULL) IS NULL AND types <@ ARRAY['Grass', 'Fire', 'Water', 'Lightning',
    'Psychic', 'Fighting', 'Darkness', 'Metal', 'Fairy', 'Dragon', 'Colorless']),
  rule_box boolean,
  ace_spec boolean,
  radiant boolean,
  prism_star boolean,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Effective attributes: the only relation readers use (the Basic Energy exemption now, format checks later).
-- Reviewed per-Printing corrections will redefine this view to override derived values, keeping these columns,
-- so no reader changes.
CREATE VIEW catalog_card_attribute AS
  SELECT printing_id, regulation_mark, card_kind, basic_energy, types, rule_box, ace_spec, radiant, prism_star
  FROM catalog_derived_attribute;
