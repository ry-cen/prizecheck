-- Set release dates (app redesign #173). Catalog lists Card Editions newest set first, so each catalog import stores the
-- release date TCGdex gives each set (its set record's releaseDate) for the generation it promotes. A set TCGdex gives no
-- valid date for has no row; Catalog then uses the date in the format rules files, and sorts a set with neither last.
--
-- Catalog data only: writing it advances no revision, re-stamps no public record and leaves saved format results and
-- stored Format Standing (migration 042) current. Rows go with their generation (ON DELETE CASCADE).
--
-- Safe to run on existing data and to run again. Existing generations have no rows until the next import; until then
-- Catalog orders the sets the rules files date and puts every other set last.
CREATE TABLE IF NOT EXISTS catalog_generation_set (
  generation_id uuid NOT NULL REFERENCES catalog_generation(id) ON DELETE CASCADE,
  set_id text NOT NULL CHECK (length(set_id) BETWEEN 1 AND 80),
  release_date date NOT NULL,
  PRIMARY KEY (generation_id, set_id)
);
