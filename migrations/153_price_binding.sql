-- Price binding (ADR 0019, design sections 4.3 and 4.6). A verified Edition's product stays the reviewed mapping; the
-- TCGplayer subtype is derived by api/app/price_binding.py and stored here. A row is unbound (sub_type_name null) with a
-- reason when the Edition cannot be priced from exactly one product row.
CREATE TABLE IF NOT EXISTS edition_price_binding (
  edition_id uuid PRIMARY KEY REFERENCES catalog_edition(id) ON DELETE CASCADE,
  product_id int NOT NULL,
  mapping_revision bigint NOT NULL,
  sub_type_name text,
  reason text CHECK (reason IN ('no_product_rows','uncovered_variant','ambiguous','shared_price','unspecified_variant')),
  bound_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((sub_type_name IS NULL) <> (reason IS NULL))
);
-- The refs ever written as `price:` public records (ticket P5). Kept a superset of the record store: a ref is inserted
-- before its first write and removed only after its delete has committed.
CREATE TABLE IF NOT EXISTS public_price_ref (
  edition_ref text PRIMARY KEY
);
