-- TCGplayer art for Printings without a TCGdex image (ADR 0019, design section 4.8). The table holds the chosen product per
-- Printing (written by api/app/card_art.py); the view is what every image consumer except the scanner reads.
CREATE TABLE IF NOT EXISTS catalog_printing_fallback_art (
  printing_id uuid PRIMARY KEY REFERENCES catalog_printing(id) ON DELETE CASCADE,
  product_id int NOT NULL CHECK (product_id > 0),
  chosen_at timestamptz NOT NULL DEFAULT now()
);

-- TCGdex wins: the active generation's image, else the established display's. Only when both are null or empty does the
-- fallback apply. URLs are built from the integer product id, never copied from TCGCSV.
CREATE OR REPLACE VIEW catalog_printing_art AS
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
LEFT JOIN catalog_printing_fallback_art f ON f.printing_id = p.id;

-- price_import.fallback_art already exists (152).
