-- Art-route URLs on the Printing art view (#360, ADR 0020).
--
-- Every signed-in card image is a same-origin URL `/api/art/{printing_id}/{size}?v={8 hex of sha256(small source URL)}`.
-- The server builds it here, next to the sources it names, so there is one rule: `catalog_art_version` and
-- `catalog_art_route` are the SQL twins of `art_urls.art_version`/`art_url` (api/tests/test_art_route_urls.py checks they
-- agree). The version is taken from the small source for both sizes: a Printing's two files change together, so a client
-- that asks for the other size by changing the path's size keeps a version the route accepts. `small_art_url` and
-- `large_art_url` are what signed-in reads select; `art_version` is what the route compares `v` with. `low_image_url`
-- and `high_image_url` stay the source URLs, which the anonymous reads (Published Deck page, public catalog) and the
-- art route's resolver read.
--
-- Safe to run on existing data and to run again.
CREATE OR REPLACE FUNCTION catalog_art_version(source text) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN source IS NULL OR source = '' THEN NULL
    ELSE left(encode(sha256(convert_to(source, 'UTF8')), 'hex'), 8) END
$$;

CREATE OR REPLACE FUNCTION catalog_art_route(printing uuid, size text, source text, small_source text) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN source IS NULL OR source = '' THEN NULL
    ELSE '/api/art/' || printing || '/' || size || '?v=' || catalog_art_version(small_source) END
$$;

CREATE OR REPLACE VIEW catalog_printing_art AS
SELECT b.printing_id, b.tcgdex_url, b.low_image_url, b.high_image_url,
  catalog_art_route(b.printing_id, 'small', b.low_image_url, b.low_image_url) AS small_art_url,
  catalog_art_route(b.printing_id, 'large', b.high_image_url, b.low_image_url) AS large_art_url,
  catalog_art_version(b.low_image_url) AS art_version
FROM (
  SELECT p.id AS printing_id, t.url AS tcgdex_url,
    CASE WHEN t.url IS NOT NULL THEN t.url || '/low.webp'
         WHEN f.product_id IS NOT NULL THEN 'https://tcgplayer-cdn.tcgplayer.com/product/' || f.product_id || '_200w.jpg' END AS low_image_url,
    CASE WHEN t.url IS NOT NULL THEN t.url || '/high.webp'
         WHEN f.product_id IS NOT NULL THEN 'https://tcgplayer-cdn.tcgplayer.com/product/' || f.product_id || '_400w.jpg' END AS high_image_url
  FROM catalog_printing p
  LEFT JOIN catalog_printing_display pd ON pd.printing_id = p.id
  LEFT JOIN catalog_generation_printing gp ON gp.printing_id = p.id
         AND gp.generation_id = (SELECT active_generation FROM catalog_state)
  CROSS JOIN LATERAL (SELECT coalesce(nullif(gp.image_url, ''), nullif(pd.image_url, '')) AS url) t
  LEFT JOIN catalog_printing_fallback_art f ON f.printing_id = p.id
) b;
