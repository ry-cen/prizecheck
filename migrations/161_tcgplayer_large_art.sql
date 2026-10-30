-- TCGplayer large art (#438): catalog-adjacent cache data only; advances no revision.
-- Safe to run again.
CREATE TABLE IF NOT EXISTS catalog_printing_art_product (
 printing_id uuid PRIMARY KEY REFERENCES catalog_printing(id) ON DELETE CASCADE,
 product_id int NOT NULL CHECK (product_id > 0), chosen_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS art_large_upgrade (
 printing_id uuid PRIMARY KEY REFERENCES catalog_printing(id),
 candidate_url text NOT NULL CHECK (length(candidate_url) BETWEEN 1 AND 2048),
 base_url text NOT NULL CHECK (length(base_url) BETWEEN 1 AND 2048),
 outcome text NOT NULL CHECK (outcome IN ('won','lost','failed')),
 width int CHECK (width BETWEEN 1 AND 65535), height int CHECK (height BETWEEN 1 AND 65535),
 failures int NOT NULL DEFAULT 0 CHECK (failures >= 0),
 reason text CHECK (reason IN ('status','timeout','transport','redirect','content_type','too_large','magic')),
 checked_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((outcome='failed') = (reason IS NOT NULL)), CHECK ((outcome='failed') = (failures >= 1)),
 CHECK (outcome <> 'won' OR (width IS NOT NULL AND height IS NOT NULL))
);
CREATE OR REPLACE FUNCTION catalog_art_version(source text, upgrade text) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
 SELECT CASE WHEN source IS NULL OR source='' THEN NULL
 WHEN upgrade IS NULL OR upgrade='' THEN catalog_art_version(source)
 ELSE left(encode(sha256(convert_to(source || E'\n' || upgrade,'UTF8')),'hex'),8) END
$$;
CREATE OR REPLACE FUNCTION catalog_art_route_v(printing uuid, size text, source text, version text) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
 SELECT CASE WHEN source IS NULL OR source='' THEN NULL
 ELSE '/api/art/' || printing || '/' || size || '?v=' || version END
$$;
CREATE OR REPLACE VIEW catalog_printing_art AS
SELECT b.printing_id, b.tcgdex_url, b.low_image_url, b.high_image_url,
  catalog_art_route_v(b.printing_id, 'small', b.low_image_url, catalog_art_version(b.low_image_url,u.candidate_url)) AS small_art_url,
  catalog_art_route_v(b.printing_id, 'large', b.high_image_url, catalog_art_version(b.low_image_url,u.candidate_url)) AS large_art_url,
  catalog_art_version(b.low_image_url,u.candidate_url) AS art_version,
  b.cand AS large_upgrade_url, u.candidate_url AS stored_upgrade_url
FROM (
  SELECT p.id AS printing_id, t.url AS tcgdex_url,
    CASE WHEN coalesce(f.product_id,ap.product_id) IS NOT NULL THEN 'https://tcgplayer-cdn.tcgplayer.com/product/' || coalesce(f.product_id,ap.product_id) || '_in_1000x1000.jpg' END AS cand,
    CASE WHEN t.url IS NOT NULL THEN t.url || '/low.webp'
         WHEN f.product_id IS NOT NULL THEN 'https://tcgplayer-cdn.tcgplayer.com/product/' || f.product_id || '_200w.jpg' END AS low_image_url,
    CASE WHEN t.url IS NOT NULL THEN t.url || '/high.webp'
         WHEN f.product_id IS NOT NULL THEN 'https://tcgplayer-cdn.tcgplayer.com/product/' || f.product_id || '_400w.jpg' END AS high_image_url
  FROM catalog_printing p
  LEFT JOIN catalog_printing_display pd ON pd.printing_id = p.id
  LEFT JOIN catalog_generation_printing gp ON gp.printing_id = p.id
         AND gp.generation_id = (SELECT active_generation FROM catalog_state)
  CROSS JOIN LATERAL (SELECT coalesce(nullif(gp.image_url, ''), nullif(pd.image_url, '')) AS url) t
  LEFT JOIN catalog_printing_art_product ap ON ap.printing_id=p.id
  LEFT JOIN catalog_printing_fallback_art f ON f.printing_id = p.id
) b LEFT JOIN art_large_upgrade u ON u.printing_id=b.printing_id AND u.outcome='won'
  AND u.candidate_url=b.cand AND u.base_url=b.high_image_url;
