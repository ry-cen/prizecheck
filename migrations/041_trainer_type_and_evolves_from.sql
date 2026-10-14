-- Trainer Type and evolves from (app redesign #170, spec "Card type: one source"). The effective card attributes become
-- the one source of card type: Collection's category and type filters read them instead of the metadata columns of
-- migration 027, which stay until a cleanup removes them.
--
-- - Trainer Type ('supporter', 'item', 'tool', 'stadium'; NULL when unknown) is a card attribute: derived from TCGdex
--   ``trainerType`` (api/app/card_attributes.py, rules version 3) and correctable through the attribute review like the
--   others. It belongs to Trainers only: the view below shows it only while the effective card kind is 'trainer', so a
--   card corrected to another kind loses a derived Trainer Type without a way to "correct it to unknown".
-- - Evolves from (the name of the Pokémon a Pokémon evolves from) is derived from TCGdex ``evolveFrom`` but is not an
--   attribute: it is never reviewed or corrected, so only the derived table has it, and the view shows it for Pokémon.
--
-- Neither is a public format fact: no format rule reads them, so the stamp trigger of migration 038 (which compares the
-- fact columns only) is left alone, and writing them re-stamps and republishes nothing.
--
-- A migration cannot run the Python rules, so every existing Printing's Trainer Type and evolves from stay unknown until
-- scripts/derive_card_attributes.py or the next catalog import re-derives it (docs/operations/release.md). The rules
-- version changed, so either one rewrites every TCGdex Printing's derived row once.
--
-- Safe to run on existing data and to run again: every statement adds nullable columns if missing, replaces a CHECK by
-- name or replaces the view keeping every existing column, its order and its type (new columns go last).

ALTER TABLE catalog_derived_attribute
  ADD COLUMN IF NOT EXISTS trainer_type text CHECK (trainer_type IN ('supporter', 'item', 'tool', 'stadium')),
  ADD COLUMN IF NOT EXISTS evolves_from text CHECK (length(evolves_from) BETWEEN 1 AND 120);
ALTER TABLE catalog_attribute_correction
  ADD COLUMN IF NOT EXISTS trainer_type text CHECK (trainer_type IN ('supporter', 'item', 'tool', 'stadium'));

-- A correction still sets at least one attribute; trainer_type now counts (the named CHECK of migration 038).
ALTER TABLE catalog_attribute_correction DROP CONSTRAINT IF EXISTS catalog_attribute_correction_sets_an_attribute;
ALTER TABLE catalog_attribute_correction ADD CONSTRAINT catalog_attribute_correction_sets_an_attribute
 CHECK(num_nonnulls(regulation_mark,card_kind,basic_energy,types,rule_box,ace_spec,radiant,prism_star,basic_pokemon,
   trainer_type)>0);

-- Migration 038's view with the two new columns last.
CREATE OR REPLACE VIEW catalog_card_attribute AS
  SELECT p.id AS printing_id,
    coalesce(c.regulation_mark, d.regulation_mark) AS regulation_mark,
    coalesce(c.card_kind, d.card_kind) AS card_kind,
    coalesce(c.basic_energy, d.basic_energy) AS basic_energy,
    coalesce(c.types, d.types) AS types,
    coalesce(c.rule_box, d.rule_box) AS rule_box,
    coalesce(c.ace_spec, d.ace_spec) AS ace_spec,
    coalesce(c.radiant, d.radiant) AS radiant,
    coalesce(c.prism_star, d.prism_star) AS prism_star,
    coalesce(c.basic_pokemon, d.basic_pokemon) AS basic_pokemon,
    CASE WHEN coalesce(c.card_kind, d.card_kind) = 'trainer' THEN coalesce(c.trainer_type, d.trainer_type) END
      AS trainer_type,
    CASE WHEN coalesce(c.card_kind, d.card_kind) = 'pokemon' THEN d.evolves_from END AS evolves_from
  FROM catalog_printing p
  LEFT JOIN catalog_derived_attribute d ON d.printing_id = p.id
  LEFT JOIN catalog_attribute_correction c ON c.printing_id = p.id
  WHERE d.printing_id IS NOT NULL OR c.printing_id IS NOT NULL;

-- Effective attributes gained a column, so saved Deck format results are stale (the attribute revision is in their key),
-- as after migration 038. Collection holding cursors carry the revision too and restart once.
SELECT catalog_advance_attribute_revision();
