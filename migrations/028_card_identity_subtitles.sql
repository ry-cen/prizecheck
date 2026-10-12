-- Card Identity ignores a trailing parenthetical subtitle: "Professor's Research (Professor Juniper)"
-- and "Professor's Research (Professor Magnolia)" are one Card Identity, "Professor's Research".
-- Typographic apostrophes (U+2018, U+2019, U+02BC) fold to ASCII "'" first, so "Professor’s Letter"
-- and "Professor's Letter" are one Card Identity named with the ASCII apostrophe.
-- Existing identities are re-keyed; identities that now share a key merge into one surviving ID and
-- their Printings are repointed to it. Holdings, Editions, Printing display data, public references,
-- Published Deck snapshots, missing-card reports and Catalog Overrides reference Printings or Editions,
-- never identities, so none of them is rewritten.
-- catalog_card_identity_key mirrors app.card_identity.card_identity_key; api/tests/test_card_identity.py
-- checks that the two agree.
CREATE FUNCTION catalog_card_identity_key(name text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT CASE WHEN s.stripped = '' THEN s.folded ELSE s.stripped END
 FROM (SELECT f.folded, regexp_replace(f.folded, ' \([^()]+\)$', '') AS stripped
       FROM (SELECT translate(name, U&'\2018\2019\02BC', '''''''') AS folded) f) s
$$;

-- The public name each Printing's catalog record carried before this migration.
CREATE TEMP TABLE card_identity_printing_before ON COMMIT DROP AS
SELECT p.id AS printing_id, ci.display_name AS published_name
FROM catalog_printing p JOIN catalog_identity ci ON ci.id = p.identity_id;

CREATE TEMP TABLE card_identity_rekey ON COMMIT DROP AS
WITH keyed AS (
 SELECT ci.id, ci.identity_key, catalog_card_identity_key(ci.identity_key) AS new_key,
  ci.identity_key = translate(ci.identity_key, U&'\2018\2019\02BC', '''''''') AS ascii_spelling,
  (SELECT min(p.created_at) FROM catalog_printing p WHERE p.identity_id = ci.id) AS first_printing
 FROM catalog_identity ci
)
SELECT id, identity_key, new_key,
 first_value(id) OVER (PARTITION BY new_key
  ORDER BY (identity_key = new_key) DESC, ascii_spelling DESC, first_printing NULLS LAST, id) AS survivor_id
FROM keyed;

-- Every Printing of a merged identity now belongs to the survivor.
UPDATE catalog_printing p SET identity_id = r.survivor_id
 FROM card_identity_rekey r WHERE p.identity_id = r.id AND r.id <> r.survivor_id;
DELETE FROM catalog_identity ci USING card_identity_rekey r WHERE ci.id = r.id AND r.id <> r.survivor_id;

-- Survivor order: the identity already keyed by the folded bare name, then one spelled with ASCII
-- apostrophes, then the earliest Printing, then the lowest id. Its key and display name become the
-- folded bare name.
-- Two steps, so a survivor never transiently collides with another survivor's old key.
UPDATE catalog_identity ci SET identity_key = 'card-identity-rekey:' || ci.id::text
 FROM card_identity_rekey r WHERE ci.id = r.id AND r.identity_key <> r.new_key;
UPDATE catalog_identity ci SET identity_key = r.new_key, display_name = r.new_key
 FROM card_identity_rekey r WHERE ci.id = r.id AND r.identity_key <> r.new_key;

-- Public catalog records now name a Printing by its own display name (falling back to the identity's).
-- Any Printing whose published name would change is re-stamped with this migration's single public
-- revision, so its record is republished instead of looking like a recovery conflict. Ordinarily no
-- Printing qualifies: a Printing's display name is the name its identity was created from.
UPDATE catalog_printing_metadata m SET public_revision = catalog_begin_correction()
 FROM card_identity_printing_before b
 JOIN catalog_printing p ON p.id = b.printing_id
 JOIN catalog_identity ci ON ci.id = p.identity_id
 LEFT JOIN catalog_printing_display pd ON pd.printing_id = p.id
 WHERE m.printing_id = b.printing_id
   AND coalesce(pd.display_name, ci.display_name) IS DISTINCT FROM b.published_name;

-- Catalog search cursors and catalog-revision-keyed reads must not span the change.
UPDATE catalog_state SET revision = revision + 1
 WHERE singleton AND EXISTS (SELECT 1 FROM card_identity_rekey WHERE identity_key <> new_key);
