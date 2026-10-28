-- Set eras (#366). Catalog's set picker groups sets into folders by Pokémon TCG era, so each catalog import also stores the
-- series TCGdex names on each set's record (its serie: id and name) beside the release date it already keeps (migration 044)
-- for the generation it promotes. A set TCGdex gives no valid serie for has no series; the picker puts it in a last folder.
--
-- release_date becomes nullable: a set with a series but no valid release date still gets a row. Every reader already
-- treats a missing date as no date (a missing row and a NULL date both fall back to the dates in the format rules files).
--
-- Catalog data only, like migration 044: writing it advances no revision, re-stamps no public record and leaves saved
-- format results and stored Format Standing (migration 042) current. Rows go with their generation (ON DELETE CASCADE).
--
-- Safe to run on existing data and to run again. Existing generations have no series until the next import; until then
-- the picker shows its flat A-Z list.
ALTER TABLE catalog_generation_set ALTER COLUMN release_date DROP NOT NULL;
ALTER TABLE catalog_generation_set ADD COLUMN IF NOT EXISTS series_id text CHECK (length(series_id) BETWEEN 1 AND 128);
ALTER TABLE catalog_generation_set ADD COLUMN IF NOT EXISTS series_name text CHECK (length(series_name) BETWEEN 1 AND 200);
-- A row says something: a series (id and name together), a date, or both.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_generation_set_series_pair'
                 AND conrelid = 'catalog_generation_set'::regclass) THEN
    ALTER TABLE catalog_generation_set
      ADD CONSTRAINT catalog_generation_set_series_pair CHECK ((series_id IS NULL) = (series_name IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_generation_set_not_empty'
                 AND conrelid = 'catalog_generation_set'::regclass) THEN
    ALTER TABLE catalog_generation_set
      ADD CONSTRAINT catalog_generation_set_not_empty CHECK (release_date IS NOT NULL OR series_id IS NOT NULL);
  END IF;
END $$;
