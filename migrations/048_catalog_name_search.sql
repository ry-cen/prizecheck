-- Catalog name search (catalog fuzzy search). Catalog's search box and the deck builder's library
-- (GET /api/catalog/editions q) find a name's letters and digits anywhere in it, ignoring accents, spaces and
-- punctuation, and fall back to close spellings when no name contains them (api/app/catalog_browse.py,
-- api/app/name_search.py).
--
-- catalog_search_words(name): Unicode NFKD (an accented letter becomes the plain letter and a combining mark, a
-- full-width letter the plain letter), lower case, every character outside printable ASCII dropped (combining marks,
-- curly apostrophes, symbols such as ♀, ☆ and δ), straight apostrophes and periods dropped, and every other run of
-- characters that are not a-z or 0-9 one space, trimmed: "Farfetch’d" -> "farfetchd", "Mr. Mime" -> "mr mime",
-- "Porygon-Z" -> "porygon z", "Flabébé" -> "flabebe", "Nidoran ♀" -> "nidoran". The route normalizes q with this same
-- function, so a name and a query always agree.
--
-- Three stored generated columns of catalog_generation_printing:
--   search_words     catalog_search_words(display_name), the names a close-spelling search compares against;
--   search_key       the same without spaces ("mrmime"), which a name search's key must be part of;
--   search_key_bare  search_key of the name with each possessive 's dropped first ("Boss's Orders" -> "bossorders"),
--                    so "boss orders" finds Boss's Orders as "boss's orders" and "bosss orders" do through search_key.
-- PostgreSQL computes them for every existing row here (the table is rewritten under an exclusive lock) and for every
-- later INSERT, whichever release writes it: every writer names its columns, so no backfill script is needed. A change
-- to the function needs a new migration that drops and adds the columns again; replacing the function alone leaves
-- stored values stale.
--
-- No extension (pg_trgm, unaccent): scripts/recovery.py dumps the public schema only, which leaves extensions out, so
-- a restore would fail on anything that depends on one.
--
-- Expand-only. The previous application never reads the columns or the function, so during an activation overlap or
-- after a rollback it searches as before. Safe to run again.
CREATE OR REPLACE FUNCTION catalog_search_words(name text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN btrim(regexp_replace(regexp_replace(lower(normalize(name, NFKD)), '[^ -~]|[''.]', '', 'g'),
                              '[^a-z0-9]+', ' ', 'g'));

ALTER TABLE catalog_generation_printing
  ADD COLUMN IF NOT EXISTS search_words text NOT NULL
    GENERATED ALWAYS AS (catalog_search_words(display_name)) STORED,
  ADD COLUMN IF NOT EXISTS search_key text NOT NULL
    GENERATED ALWAYS AS (replace(catalog_search_words(display_name), ' ', '')) STORED,
  ADD COLUMN IF NOT EXISTS search_key_bare text NOT NULL
    GENERATED ALWAYS AS (replace(catalog_search_words(regexp_replace(display_name, '[''’‘ʼ][sS]\M', '', 'g')), ' ', ''))
    STORED;
