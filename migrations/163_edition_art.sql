-- Bounded reviewed image identities, separate from upstream pricing product IDs.
-- Linked images only (ADR0019). No copies, cache, generic URL or live price correction.
-- Scope/reference safety is immutable policy, independent of withdrawable links.
CREATE VIEW catalog_pokemon_promo_art_scope(source_id,reference_only) AS VALUES
 ('svp-013',true),
 ('svp-014',true),
 ('svp-027',true),
 ('svp-044',true),
 ('svp-051',true),
 ('svp-065',true),
 ('svp-066',true),
 ('svp-075',true),
 ('svp-097',true),
 ('svp-098',true),
 ('svp-123',true),
 ('svp-129',true),
 ('svp-141',true),
 ('svp-159',true),
 ('svp-173',true),
 ('svp-189',true),
 ('svp-203',false),
 ('svp-209',false),
 ('svp-210',false);
CREATE TABLE catalog_pokemon_promo_art (
 source_id text PRIMARY KEY CHECK (source_id ~ '^svp-[0-9]{3}$'),
 display_name text NOT NULL,
 collector_number text NOT NULL CHECK (collector_number ~ '^[0-9]{3}$'),
 pc_product_id int NOT NULL CHECK (pc_product_id BETWEEN 1 AND 999999999),
 CHECK (source_id='svp-' || collector_number)
);
-- Source: cached 280-product response, fetched 2026-11-04 01:59:48 UTC,
-- SHA256 a5c5a62d3a001a15a9a8de6567fcfca97fd9f69e143b93b5a32a516bd7d19d58.
-- Product names/numbers/group/PC qualifiers were audited; this is not a rights grant.
INSERT INTO catalog_pokemon_promo_art(source_id,display_name,collector_number,pc_product_id) VALUES
 ('svp-013','Miraidon','013',490730),
 ('svp-014','Koraidon','014',490725),
 ('svp-027','Pikachu','027',500264),
 ('svp-044','Charmander','044',512036),
 ('svp-051','Snorlax','051',517270),
 ('svp-065','Scream Tail','065',526655),
 ('svp-066','Iron Bundle','066',526657),
 ('svp-075','Mimikyu','075',535953),
 ('svp-097','Flutter Mane','097',543947),
 ('svp-098','Iron Thorns','098',543949),
 ('svp-123','Teal Mask Ogerpon','123',552786),
 ('svp-129','Pecharunt','129',573720),
 ('svp-141','Noctowl','141',578812),
 ('svp-159','Magneton','159',594468),
 ('svp-173','Eevee','173',610757),
 ('svp-189','N''s Zorua','189',625182),
 ('svp-203','Team Rocket''s Wobbuffet','203',635468),
 ('svp-209','Thundurus','209',644834),
 ('svp-210','Tornadus','210',644836);

CREATE VIEW catalog_edition_art AS
SELECT e.id AS edition_id,e.printing_id,x.linked_art,
 s.source_id IS NOT NULL AS art_scoped,policy.pc_stamp AS art_withheld,
 coalesce(gp.set_id,'') AS art_set_id,coalesce(gp.collector_number,'') AS art_number,
 b.low_image_url,b.high_image_url,b.stored_upgrade_url,b.reference_only,
 CASE WHEN x.product_id IS NOT NULL THEN x.small_url
      WHEN b.reference_only THEN catalog_art_route(e.printing_id,'small',b.low_image_url,b.low_image_url) || '&reference=1'
      WHEN policy.pc_stamp THEN NULL ELSE a.small_art_url END AS small_art_url,
 CASE WHEN x.product_id IS NOT NULL THEN x.large_url
      WHEN b.reference_only THEN catalog_art_route(e.printing_id,'large',b.high_image_url,b.low_image_url) || '&reference=1'
      WHEN policy.pc_stamp THEN NULL ELSE a.large_art_url END AS large_art_url
FROM catalog_edition e
JOIN catalog_printing p ON p.id=e.printing_id
JOIN catalog_edition_metadata m ON m.edition_id=e.id
LEFT JOIN catalog_printing_art a ON a.printing_id=p.id
LEFT JOIN catalog_pokemon_promo_art_scope s ON p.source='tcgdex' AND s.source_id=p.source_id
LEFT JOIN catalog_pokemon_promo_art r ON p.source='tcgdex' AND r.source_id=p.source_id
LEFT JOIN catalog_generation_printing gp ON gp.printing_id=p.id
 AND gp.generation_id=(SELECT active_generation FROM catalog_state) AND NOT gp.tombstoned
CROSS JOIN LATERAL (SELECT
 -- Only the two audited physical holo/standard forms. Lookup/provenance fields
 -- do not determine physical identity, while unknown physical facets disqualify it.
 e.descriptor - ARRAY['variantId','thirdParty','pricing','card_pricing','cardmarket','tcgplayer','tcgOnline'] AS physical,
 coalesce(s.source_id IS NOT NULL AND r.source_id IS NOT NULL AND gp.set_id='svp'
 AND ltrim(gp.collector_number,'0')=ltrim(r.collector_number,'0')
 AND catalog_search_words(gp.display_name)=catalog_search_words(r.display_name),false) AS identity_ok) facts
CROSS JOIN LATERAL (SELECT
 facts.identity_ok AND facts.physical IN (
  '{"type":"holo","size":"standard","stamp":["pokemon-center"]}'::jsonb,
  '{"type":"holo","stamp":["pokemon-center"]}'::jsonb,
  '{"type":"holo","size":"standard","stamp":"pokemon-center"}'::jsonb,
  '{"type":"holo","stamp":"pokemon-center"}'::jsonb) AS pc,
 coalesce(s.reference_only,false) AND facts.physical IN ('{"type":"holo","size":"standard"}'::jsonb,'{"type":"holo"}'::jsonb) AS regular,
 p.source='tcgdex' AND p.source_id LIKE 'svp-%' AND coalesce(e.descriptor->'stamp'='"pokemon-center"'::jsonb OR e.descriptor->'stamp' @> '["pokemon-center"]'::jsonb,false) AS pc_stamp) policy
CROSS JOIN LATERAL (SELECT CASE WHEN policy.pc THEN r.pc_product_id END AS product_id) chosen
CROSS JOIN LATERAL (SELECT catalog_art_version('edition-linked:' || chosen.product_id || ':' || m.mapping_revision || ':' || m.public_revision) AS version) v
CROSS JOIN LATERAL (SELECT chosen.product_id,
 CASE WHEN chosen.product_id IS NOT NULL THEN jsonb_build_object(
  'version',v.version,'edition_ref',e.public_ref,'printing_ref',p.public_ref,
  'mapping_revision',m.mapping_revision,'revision',m.public_revision,'product_id',chosen.product_id) END AS linked_art,
 '/api/public/edition-art/' || e.public_ref || '/small?v=' || v.version AS small_url,
 '/api/public/edition-art/' || e.public_ref || '/large?v=' || v.version AS large_url) x
CROSS JOIN LATERAL (SELECT
 CASE WHEN x.product_id IS NOT NULL THEN x.small_url WHEN policy.pc_stamp THEN NULL
      WHEN policy.regular THEN a.tcgdex_url || '/low.webp' ELSE a.low_image_url END AS low_image_url,
 CASE WHEN x.product_id IS NOT NULL THEN x.large_url WHEN policy.pc_stamp THEN NULL
      WHEN policy.regular THEN a.tcgdex_url || '/high.webp' ELSE a.high_image_url END AS high_image_url,
 CASE WHEN NOT policy.regular THEN a.stored_upgrade_url END AS stored_upgrade_url,
 policy.regular AS reference_only) b;

-- Reviewed art changes participate in the same ordered public outbox as mapping
-- changes. A late public writer cannot resurrect an earlier selection.
CREATE FUNCTION pokemon_promo_art_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE catalog_edition_metadata m SET public_revision=catalog_begin_correction()
 FROM catalog_printing p WHERE p.id=m.printing_id AND p.source='tcgdex'
 AND p.source_id IN (CASE WHEN TG_OP='INSERT' THEN NEW.source_id ELSE OLD.source_id END,
                     CASE WHEN TG_OP='DELETE' THEN OLD.source_id ELSE NEW.source_id END);
 RETURN NULL;
END $$;
CREATE TRIGGER pokemon_promo_art_changed AFTER INSERT OR UPDATE OR DELETE ON catalog_pokemon_promo_art
 FOR EACH ROW EXECUTE FUNCTION pokemon_promo_art_changed();
-- Derived display metadata refresh only; no product mapping/binding/owner decision is changed.
UPDATE catalog_edition_metadata m SET public_revision=catalog_begin_correction()
FROM catalog_printing p WHERE p.id=m.printing_id AND p.source='tcgdex'
 AND p.source_id IN (SELECT source_id FROM catalog_pokemon_promo_art);

-- Generation inputs affect display even when mapping inputs do not change. Compare
-- only the bounded scope in the same catalog transaction; no mapping revision changes.
CREATE FUNCTION pokemon_promo_art_generation_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.active_generation IS DISTINCT FROM OLD.active_generation THEN
  UPDATE catalog_edition_metadata m SET public_revision=catalog_begin_correction()
  FROM catalog_printing p JOIN catalog_pokemon_promo_art_scope s ON s.source_id=p.source_id
  LEFT JOIN catalog_generation_printing old_gp ON old_gp.printing_id=p.id AND old_gp.generation_id=OLD.active_generation
  LEFT JOIN catalog_generation_printing new_gp ON new_gp.printing_id=p.id AND new_gp.generation_id=NEW.active_generation
  WHERE m.printing_id=p.id AND p.source='tcgdex'
   AND (old_gp.set_id,old_gp.collector_number,old_gp.display_name,old_gp.image_url,old_gp.tombstoned)
       IS DISTINCT FROM
       (new_gp.set_id,new_gp.collector_number,new_gp.display_name,new_gp.image_url,new_gp.tombstoned);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER pokemon_promo_art_generation_changed AFTER UPDATE OF active_generation ON catalog_state
 FOR EACH ROW EXECUTE FUNCTION pokemon_promo_art_generation_changed();
