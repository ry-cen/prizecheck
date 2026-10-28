-- Card art store (#358, ADR 0020).
--
-- art_object: one stored image per (Printing, size): the source URL it came from, where the bytes live in the art store
-- (storage_key, under ART_STORE_DIR), and the sha256, content type and byte size of those bytes. The route serves a file
-- only while this row matches the Printing's current source and the file's sha256 matches the row.
--
-- art_hit: how often each (Printing, size) was served and when last; the signal for a later "upgrade the most-used
-- images" job (#361). Only recorded here.
--
-- art_fetch_failure: the ledger that backs off a source that failed (status, timeout, wrong type, too large), so a missing
-- file is not asked for on every request. It mirrors scanner_fingerprint_failure.
--
-- Catalog-adjacent cache data only, like migration 150: writing any of it advances no revision, re-stamps no public
-- record and leaves saved format results and stored Format Standing current. The files under ART_STORE_DIR are
-- regenerable; deleting them only costs refetches.
--
-- Safe to run on existing data and to run again.
CREATE TABLE IF NOT EXISTS art_object (
  printing_id uuid NOT NULL REFERENCES catalog_printing(id),
  size text NOT NULL CHECK (size IN ('small','large')),
  source_url text NOT NULL CHECK (length(source_url) BETWEEN 1 AND 2048),
  storage_key text NOT NULL CHECK (length(storage_key) <= 255),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content_type text NOT NULL CHECK (content_type IN ('image/webp','image/png','image/jpeg')),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 2097152),
  stored_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (printing_id, size)
);

CREATE TABLE IF NOT EXISTS art_hit (
  printing_id uuid NOT NULL REFERENCES catalog_printing(id),
  size text NOT NULL CHECK (size IN ('small','large')),
  hits bigint NOT NULL CHECK (hits >= 1),
  last_hit_at timestamptz NOT NULL,
  PRIMARY KEY (printing_id, size)
);

CREATE TABLE IF NOT EXISTS art_fetch_failure (
  printing_id uuid NOT NULL REFERENCES catalog_printing(id),
  size text NOT NULL CHECK (size IN ('small','large')),
  source_url text NOT NULL,
  failures integer NOT NULL CHECK (failures >= 1),
  last_failed_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (reason IN ('status','timeout','transport','redirect','content_type','too_large','magic')),
  PRIMARY KEY (printing_id, size)
);
