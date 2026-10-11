-- Category and elemental type of a Card Printing, stored for the collector workspace filters (ticket 104).
-- Expand-only: the previous application keeps working against this schema. It never names these
-- columns, and the trigger below keeps them current whenever any release writes source_record.
-- ALTER TABLE takes the table's ACCESS EXCLUSIVE lock first, so the backfill below sees every row.
ALTER TABLE catalog_printing_metadata
  ADD COLUMN category text CHECK (category IN ('Pokemon','Trainer','Energy')),
  ADD COLUMN elemental_types text[] NOT NULL DEFAULT '{}';

-- TCGdex "category": Pokemon, Trainer or Energy. Anything else is unknown, not an error.
CREATE FUNCTION catalog_card_category(record jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN record->>'category' IN ('Pokemon','Trainer','Energy') THEN record->>'category' END
$$;

-- TCGdex "types": the card's elemental types (a basic Energy has its own; a Trainer has none).
-- Unknown or malformed entries are dropped; the result is sorted and has no duplicates.
CREATE FUNCTION catalog_elemental_types(record jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_agg(DISTINCT kind ORDER BY kind), '{}')
  FROM jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(record->'types')='array' THEN record->'types' ELSE '[]'::jsonb END) AS kind
  WHERE kind IN ('Colorless','Darkness','Dragon','Fairy','Fighting','Fire','Grass','Lightning','Metal','Psychic','Water')
$$;

-- The stored values always follow the retained source record, whoever writes it.
CREATE FUNCTION derive_printing_attributes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.category := catalog_card_category(NEW.source_record);
  NEW.elemental_types := catalog_elemental_types(NEW.source_record);
  RETURN NEW;
END $$;
CREATE TRIGGER derive_printing_attributes BEFORE INSERT OR UPDATE ON catalog_printing_metadata
  FOR EACH ROW EXECUTE FUNCTION derive_printing_attributes();

-- Backfill from each Printing's retained source record. Printings whose record is still empty
-- (manual Printings, or none imported since migration 021) stay unknown until the next import
-- writes their record. The stamp and outbox triggers ignore these columns, so nothing is republished.
UPDATE catalog_printing_metadata
  SET category=catalog_card_category(source_record), elemental_types=catalog_elemental_types(source_record)
  WHERE source_record<>'{}'::jsonb;
