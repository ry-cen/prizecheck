-- TCGCSV daily price snapshot (ADR 0019, design section 4.1). Rows are upserted and never deleted; there is no foreign key
-- from price to product because the two endpoints are imported independently.
CREATE TABLE IF NOT EXISTS price_import (
  id bigserial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text CHECK (outcome IN ('imported','unchanged','partial','failed')),
  source_updated_at timestamptz,
  groups_total int,
  groups_failed int NOT NULL DEFAULT 0,
  product_rows int,
  price_rows int,
  rejected_rows int NOT NULL DEFAULT 0,
  verified_editions int,
  priced_editions int,
  unpriced jsonb NOT NULL DEFAULT '{}',
  fallback_art int,
  public_error text,
  error_code text
);

CREATE TABLE IF NOT EXISTS tcgplayer_product (
  product_id int PRIMARY KEY CHECK (product_id > 0),
  group_id int NOT NULL,
  name text NOT NULL,
  number text,
  number_key text,
  image_count int NOT NULL DEFAULT 0,
  seen_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS tcgplayer_product_group_number ON tcgplayer_product (group_id, number_key);

CREATE TABLE IF NOT EXISTS tcgplayer_price (
  product_id int NOT NULL CHECK (product_id > 0),
  sub_type_name text NOT NULL CHECK (length(sub_type_name) BETWEEN 1 AND 60),
  market_price numeric(18,6),
  low_price numeric(18,6),
  mid_price numeric(18,6),
  high_price numeric(18,6),
  direct_low_price numeric(18,6),
  seen_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  PRIMARY KEY (product_id, sub_type_name)
);
