CREATE TABLE catalog_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_generation uuid,
  revision bigint NOT NULL DEFAULT 0,
  last_success timestamptz
);
INSERT INTO catalog_state(singleton) VALUES (true);

CREATE TABLE catalog_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phase text NOT NULL DEFAULT 'queued',
  outcome text,
  enumerated_count integer NOT NULL DEFAULT 0,
  fetched_count integer NOT NULL DEFAULT 0,
  validated_count integer NOT NULL DEFAULT 0,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  lease_until timestamptz,
  CHECK (phase IN ('queued','enumerating','fetching','validating','promoting','complete','failed')),
  CHECK (outcome IS NULL OR outcome IN ('succeeded','failed'))
);
CREATE UNIQUE INDEX catalog_one_active_run ON catalog_run ((true)) WHERE outcome IS NULL;

CREATE TABLE catalog_identity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  language text NOT NULL DEFAULT 'en' CHECK (language = 'en'),
  identity_key text NOT NULL UNIQUE,
  display_name text NOT NULL
);
CREATE TABLE catalog_printing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('tcgdex','manual')),
  source_id text UNIQUE,
  language text NOT NULL DEFAULT 'en' CHECK (language = 'en'),
  identity_id uuid NOT NULL REFERENCES catalog_identity(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source = 'tcgdex') = (source_id IS NOT NULL))
);
CREATE TABLE catalog_edition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  printing_id uuid NOT NULL REFERENCES catalog_printing(id),
  descriptor_key text NOT NULL,
  descriptor jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(printing_id, descriptor_key)
);
CREATE TABLE catalog_generation (
  id uuid PRIMARY KEY,
  imported_at timestamptz NOT NULL DEFAULT now(),
  source_count integer NOT NULL,
  raw_gzip bytea NOT NULL,
  raw_sha256 text NOT NULL
);
ALTER TABLE catalog_state ADD CONSTRAINT catalog_active_generation_fk
  FOREIGN KEY (active_generation) REFERENCES catalog_generation(id);
CREATE TABLE catalog_generation_printing (
  generation_id uuid NOT NULL REFERENCES catalog_generation(id) ON DELETE CASCADE,
  printing_id uuid NOT NULL REFERENCES catalog_printing(id),
  source_id text NOT NULL,
  set_id text NOT NULL,
  set_name text NOT NULL,
  collector_number text NOT NULL,
  display_name text NOT NULL,
  search_name text NOT NULL,
  image_url text,
  source_fingerprint text NOT NULL,
  basic_energy text NOT NULL CHECK (basic_energy IN ('supported','unresolved','not_basic')),
  tombstoned boolean NOT NULL DEFAULT false,
  PRIMARY KEY(generation_id, printing_id),
  UNIQUE(generation_id, source_id)
);
CREATE INDEX catalog_gen_search ON catalog_generation_printing(generation_id, search_name text_pattern_ops, printing_id);
CREATE INDEX catalog_gen_set_number ON catalog_generation_printing(generation_id, set_id, collector_number);
CREATE TABLE catalog_generation_edition (
  generation_id uuid NOT NULL REFERENCES catalog_generation(id) ON DELETE CASCADE,
  edition_id uuid NOT NULL REFERENCES catalog_edition(id),
  printing_id uuid NOT NULL REFERENCES catalog_printing(id),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(generation_id, edition_id)
);
CREATE TABLE catalog_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  printing_id uuid REFERENCES catalog_printing(id),
  source_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('name_change','variant_ambiguity')),
  source_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  detail text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_id, kind, source_fingerprint)
);
