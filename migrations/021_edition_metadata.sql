-- Additive public references: never rewrite descriptors, IDs or correspondence.
-- Built-in gen_random_uuid() keeps the schema restorable from public-only dumps.
-- Version/variant nibbles are removed, leaving 192 uniformly random bits.
CREATE FUNCTION random_public_reference() RETURNS text LANGUAGE sql VOLATILE AS $$
 SELECT left(
  overlay(overlay(replace(gen_random_uuid()::text,'-','') placing '' from 17 for 1) placing '' from 13 for 1) ||
  overlay(overlay(replace(gen_random_uuid()::text,'-','') placing '' from 17 for 1) placing '' from 13 for 1), 48)
$$;
ALTER TABLE catalog_printing ADD COLUMN public_ref text NOT NULL
 DEFAULT random_public_reference() UNIQUE CHECK(public_ref ~ '^[0-9a-f]{48}$');
ALTER TABLE catalog_edition ADD COLUMN public_ref text NOT NULL
 DEFAULT random_public_reference() UNIQUE CHECK(public_ref ~ '^[0-9a-f]{48}$');
CREATE FUNCTION immutable_catalog_public_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.public_ref IS DISTINCT FROM OLD.public_ref THEN
  RAISE EXCEPTION 'Catalog public reference is immutable';
 END IF;
 IF TG_TABLE_NAME='catalog_edition' THEN
  IF NEW.printing_id IS DISTINCT FROM OLD.printing_id THEN
   RAISE EXCEPTION 'Edition Printing correspondence is immutable';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_printing_public_reference BEFORE UPDATE ON catalog_printing
 FOR EACH ROW EXECUTE FUNCTION immutable_catalog_public_reference();
CREATE TRIGGER immutable_edition_public_reference BEFORE UPDATE ON catalog_edition
 FOR EACH ROW EXECUTE FUNCTION immutable_catalog_public_reference();

-- Source candidates are not approved mappings or per-card Live identifiers.
-- Reviewed target data and durable invalidation/outbox work are separate concerns.
CREATE TABLE catalog_printing_metadata (
 printing_id uuid PRIMARY KEY REFERENCES catalog_printing(id) ON DELETE CASCADE,
 source_record jsonb NOT NULL DEFAULT '{}',
 unknown_fields jsonb NOT NULL DEFAULT '{}',
 export_candidate jsonb NOT NULL DEFAULT '{}',
 live_revision bigint NOT NULL DEFAULT 1 CHECK(live_revision>0),
 live_verified boolean NOT NULL DEFAULT false,
 live_quarantined boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE catalog_edition_metadata (
 edition_id uuid PRIMARY KEY REFERENCES catalog_edition(id) ON DELETE CASCADE,
 mapping_candidate jsonb NOT NULL DEFAULT '{}',
 mapping_revision bigint NOT NULL DEFAULT 1 CHECK(mapping_revision>0),
 mapping_verified boolean NOT NULL DEFAULT false,
 mapping_quarantined boolean NOT NULL DEFAULT false,
 quote_candidate jsonb NOT NULL DEFAULT '{}',
 source_variant jsonb NOT NULL DEFAULT '{}',
 unknown_fields jsonb NOT NULL DEFAULT '{}',
 updated_at timestamptz NOT NULL DEFAULT now()
);
