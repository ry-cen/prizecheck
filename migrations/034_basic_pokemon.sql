-- Basic Pokémon status (Deck Lists 20). Every format check requires a deck to hold at least one Basic Pokémon, so each
-- Card Printing gains a derived ``basic_pokemon`` attribute (api/app/card_attributes.py, rules version 2) that a reviewed
-- correction can override like the others (migration 029). NULL means unknown, as for every attribute.
--
-- A migration cannot run the Python rules, so every existing Printing's Basic Pokémon status stays unknown until
-- scripts/derive_card_attributes.py or the next catalog import re-derives it (docs/operations/release.md). Until then a
-- deck whose Basic Pokémon status is unknown on every line checks as unknown, never legal.
--
-- The column is appended to both tables and to the end of catalog_card_attribute, so CREATE OR REPLACE VIEW keeps every
-- existing column, its order and its type: readers written for migration 029's columns keep working.

ALTER TABLE catalog_derived_attribute ADD COLUMN basic_pokemon boolean;
ALTER TABLE catalog_attribute_correction ADD COLUMN basic_pokemon boolean;

-- A correction still sets at least one attribute; basic_pokemon now counts. Migration 029 left this CHECK unnamed.
ALTER TABLE catalog_attribute_correction DROP CONSTRAINT catalog_attribute_correction_check;
ALTER TABLE catalog_attribute_correction ADD CONSTRAINT catalog_attribute_correction_sets_an_attribute
 CHECK(num_nonnulls(regulation_mark,card_kind,basic_energy,types,rule_box,ace_spec,radiant,prism_star,basic_pokemon)>0);

-- Migration 029's view with the new column last.
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
    coalesce(c.basic_pokemon, d.basic_pokemon) AS basic_pokemon
  FROM catalog_printing p
  LEFT JOIN catalog_derived_attribute d ON d.printing_id = p.id
  LEFT JOIN catalog_attribute_correction c ON c.printing_id = p.id
  WHERE d.printing_id IS NOT NULL OR c.printing_id IS NOT NULL;

-- Basic Pokémon status is a public format fact (migration 032): a change to it re-stamps the Printing like a change to
-- any other attribute. A rules_version-only rewrite still changes no fact.
CREATE OR REPLACE FUNCTION stamp_format_facts_from_attributes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND (NEW.printing_id, NEW.regulation_mark, NEW.card_kind, NEW.basic_energy, NEW.types, NEW.rule_box,
     NEW.ace_spec, NEW.radiant, NEW.prism_star, NEW.basic_pokemon)
    IS NOT DISTINCT FROM (OLD.printing_id, OLD.regulation_mark, OLD.card_kind, OLD.basic_energy, OLD.types, OLD.rule_box,
     OLD.ace_spec, OLD.radiant, OLD.prism_star, OLD.basic_pokemon) THEN
  RETURN NULL;
 END IF;
 IF TG_OP IN ('UPDATE', 'DELETE') THEN
  PERFORM catalog_stamp_format_facts(ARRAY[OLD.printing_id]);
 END IF;
 IF TG_OP IN ('INSERT', 'UPDATE') THEN
  PERFORM catalog_stamp_format_facts(ARRAY[NEW.printing_id]);
 END IF;
 RETURN NULL;
END $$;

-- Effective attributes gained a column, so format results saved before this migration (Deck Lists 17) are stale: the
-- attribute revision is part of their key.
SELECT catalog_advance_attribute_revision();
