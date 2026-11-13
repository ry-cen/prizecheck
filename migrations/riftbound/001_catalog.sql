CREATE SEQUENCE catalog_public_outbox_sequence_seq AS bigint START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

-- Shared catalog definitions derived from the Pokémon history via pg_catalog.

CREATE OR REPLACE FUNCTION public.catalog_search_words(name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
RETURN btrim(regexp_replace(regexp_replace(lower(NORMALIZE(name, NFKD)), '[^ -~]|[''.]'::text, ''::text, 'g'::text), '[^a-z0-9]+'::text, ' '::text, 'g'::text))
;

CREATE OR REPLACE FUNCTION public.immutable_catalog_public_reference()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.immutable_printing_display()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN RAISE EXCEPTION 'Printing display data is immutable'; END $function$
;

CREATE OR REPLACE FUNCTION public.random_public_reference()
 RETURNS text
 LANGUAGE sql
AS $function$
 SELECT left(
  overlay(overlay(replace(gen_random_uuid()::text,'-','') placing '' from 17 for 1) placing '' from 13 for 1) ||
  overlay(overlay(replace(gen_random_uuid()::text,'-','') placing '' from 17 for 1) placing '' from 13 for 1), 48)
$function$
;

CREATE OR REPLACE FUNCTION public.remember_printing_display()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 INSERT INTO catalog_printing_display VALUES
 (NEW.printing_id,NEW.display_name,NEW.set_id,NEW.set_name,NEW.collector_number,NEW.image_url)
 ON CONFLICT(printing_id) DO NOTHING;
 RETURN NEW;
END $function$
;

CREATE TABLE catalog_state (
    singleton boolean DEFAULT true NOT NULL,
    active_generation uuid,
    revision bigint DEFAULT 0 NOT NULL,
    last_success timestamp with time zone
);

CREATE TABLE catalog_run (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phase text DEFAULT 'queued'::text NOT NULL,
    outcome text,
    enumerated_count integer DEFAULT 0 NOT NULL,
    fetched_count integer DEFAULT 0 NOT NULL,
    validated_count integer DEFAULT 0 NOT NULL,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    lease_until timestamp with time zone
);

CREATE TABLE catalog_identity (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    language text DEFAULT 'en'::text NOT NULL,
    identity_key text NOT NULL,
    display_name text NOT NULL
);

CREATE TABLE catalog_printing (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text NOT NULL,
    source_id text,
    language text DEFAULT 'en'::text NOT NULL,
    identity_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    public_ref text DEFAULT random_public_reference() NOT NULL
);

ALTER TABLE catalog_printing ADD CONSTRAINT catalog_printing_tcgcsv_source_id_check CHECK (source <> 'tcgcsv' OR source_id ~ '^[1-9][0-9]{0,18}$');

CREATE TABLE catalog_edition (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    printing_id uuid NOT NULL,
    descriptor_key text NOT NULL,
    descriptor jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    public_ref text DEFAULT random_public_reference() NOT NULL
);

CREATE TABLE catalog_generation (
    id uuid NOT NULL,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    source_count integer NOT NULL,
    raw_gzip bytea NOT NULL,
    raw_sha256 text NOT NULL
);

CREATE TABLE catalog_generation_printing (
    generation_id uuid NOT NULL,
    printing_id uuid NOT NULL,
    source_id text NOT NULL,
    set_id text NOT NULL,
    set_name text NOT NULL,
    collector_number text NOT NULL,
    display_name text NOT NULL,
    search_name text NOT NULL,
    image_url text,
    source_fingerprint text NOT NULL,
    basic_energy text DEFAULT 'not_applicable'::text NOT NULL,
    tombstoned boolean DEFAULT false NOT NULL,
    search_words text GENERATED ALWAYS AS (catalog_search_words(display_name)) STORED NOT NULL,
    search_key text GENERATED ALWAYS AS (replace(catalog_search_words(display_name), ' '::text, ''::text)) STORED NOT NULL,
    search_key_bare text GENERATED ALWAYS AS (replace(catalog_search_words(regexp_replace(display_name, '[''’‘ʼ][sS]\M'::text, ''::text, 'g'::text)), ' '::text, ''::text)) STORED NOT NULL
);

CREATE TABLE catalog_generation_edition (
    generation_id uuid NOT NULL,
    edition_id uuid NOT NULL,
    printing_id uuid NOT NULL,
    active boolean DEFAULT true NOT NULL
);

CREATE TABLE catalog_review (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    printing_id uuid,
    source_id text NOT NULL,
    kind text NOT NULL,
    source_fingerprint text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    detail text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    candidate jsonb DEFAULT '{}'::jsonb NOT NULL,
    reviewer_id text,
    reviewed_at timestamp with time zone,
    evidence_url text,
    reason text
);

CREATE TABLE catalog_printing_display (
    printing_id uuid NOT NULL,
    display_name text NOT NULL,
    set_id text NOT NULL,
    set_name text NOT NULL,
    collector_number text NOT NULL,
    image_url text
);

CREATE TABLE catalog_attribute_state (
    singleton boolean DEFAULT true NOT NULL,
    revision bigint DEFAULT 1 NOT NULL
);

CREATE TABLE catalog_public_outbox (
    sequence bigint DEFAULT nextval('catalog_public_outbox_sequence_seq'::regclass) NOT NULL,
    target_kind text NOT NULL,
    target_id uuid NOT NULL,
    revision bigint NOT NULL,
    priority smallint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text
);

CREATE TABLE catalog_set_code (
    set_id text NOT NULL,
    code text NOT NULL
);

ALTER SEQUENCE catalog_public_outbox_sequence_seq OWNED BY catalog_public_outbox.sequence;

ALTER TABLE ONLY catalog_state ADD CONSTRAINT catalog_state_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY catalog_state ADD CONSTRAINT catalog_state_singleton_check CHECK (singleton);

ALTER TABLE ONLY catalog_run ADD CONSTRAINT catalog_run_outcome_check CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['succeeded'::text, 'failed'::text]))));

ALTER TABLE ONLY catalog_run ADD CONSTRAINT catalog_run_phase_check CHECK ((phase = ANY (ARRAY['queued'::text, 'enumerating'::text, 'fetching'::text, 'validating'::text, 'promoting'::text, 'complete'::text, 'failed'::text])));

ALTER TABLE ONLY catalog_run ADD CONSTRAINT catalog_run_pkey PRIMARY KEY (id);

ALTER TABLE ONLY catalog_identity ADD CONSTRAINT catalog_identity_identity_key_key UNIQUE (identity_key);

ALTER TABLE ONLY catalog_identity ADD CONSTRAINT catalog_identity_language_check CHECK ((language = 'en'::text));

ALTER TABLE ONLY catalog_identity ADD CONSTRAINT catalog_identity_pkey PRIMARY KEY (id);

ALTER TABLE ONLY catalog_printing ADD CONSTRAINT catalog_printing_check CHECK (((source = 'tcgcsv'::text) = (source_id IS NOT NULL)));

ALTER TABLE ONLY catalog_printing ADD CONSTRAINT catalog_printing_language_check CHECK ((language = 'en'::text));

ALTER TABLE ONLY catalog_printing ADD CONSTRAINT catalog_printing_pkey PRIMARY KEY (id);

ALTER TABLE ONLY catalog_printing ADD CONSTRAINT catalog_printing_public_ref_check CHECK ((public_ref ~ '^[0-9a-f]{48}$'::text));

ALTER TABLE ONLY catalog_printing ADD CONSTRAINT catalog_printing_public_ref_key UNIQUE (public_ref);

ALTER TABLE ONLY catalog_printing ADD CONSTRAINT catalog_printing_source_check CHECK ((source = ANY (ARRAY['tcgcsv'::text, 'manual'::text])));

ALTER TABLE ONLY catalog_printing ADD CONSTRAINT catalog_printing_source_id_key UNIQUE (source_id);

ALTER TABLE ONLY catalog_edition ADD CONSTRAINT catalog_edition_pkey PRIMARY KEY (id);

ALTER TABLE ONLY catalog_edition ADD CONSTRAINT catalog_edition_printing_id_descriptor_key_key UNIQUE (printing_id, descriptor_key);

ALTER TABLE ONLY catalog_edition ADD CONSTRAINT catalog_edition_public_ref_check CHECK ((public_ref ~ '^[0-9a-f]{48}$'::text));

ALTER TABLE ONLY catalog_edition ADD CONSTRAINT catalog_edition_public_ref_key UNIQUE (public_ref);

ALTER TABLE ONLY catalog_generation ADD CONSTRAINT catalog_generation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY catalog_generation_printing ADD CONSTRAINT catalog_generation_printing_basic_energy_check CHECK (basic_energy = 'not_applicable');

ALTER TABLE ONLY catalog_generation_printing ADD CONSTRAINT catalog_generation_printing_generation_id_source_id_key UNIQUE (generation_id, source_id);

ALTER TABLE ONLY catalog_generation_printing ADD CONSTRAINT catalog_generation_printing_pkey PRIMARY KEY (generation_id, printing_id);

ALTER TABLE ONLY catalog_generation_edition ADD CONSTRAINT catalog_generation_edition_pkey PRIMARY KEY (generation_id, edition_id);

ALTER TABLE ONLY catalog_review ADD CONSTRAINT catalog_review_kind_check CHECK (kind IN ('identity_text_conflict', 'card_scope_pending', 'finish_policy_pending', 'marker_grouping_pending', 'duplicate_number_pending', 'multi_value_delimiter_unrecognised', 'price_without_product', 'extended_field_repeated', 'printing_details_differ', 'missing_from_source', 'group_change', 'display_change', 'duplicate_product_id'));

ALTER TABLE ONLY catalog_review ADD CONSTRAINT catalog_review_pkey PRIMARY KEY (id);

ALTER TABLE ONLY catalog_review ADD CONSTRAINT catalog_review_source_id_kind_source_fingerprint_key UNIQUE (source_id, kind, source_fingerprint);

ALTER TABLE ONLY catalog_printing_display ADD CONSTRAINT catalog_printing_display_pkey PRIMARY KEY (printing_id);

ALTER TABLE ONLY catalog_attribute_state ADD CONSTRAINT catalog_attribute_state_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY catalog_attribute_state ADD CONSTRAINT catalog_attribute_state_revision_check CHECK ((revision > 0));

ALTER TABLE ONLY catalog_attribute_state ADD CONSTRAINT catalog_attribute_state_singleton_check CHECK (singleton);

ALTER TABLE ONLY catalog_public_outbox ADD CONSTRAINT catalog_public_outbox_attempts_check CHECK ((attempts >= 0));

ALTER TABLE ONLY catalog_public_outbox ADD CONSTRAINT catalog_public_outbox_last_error_check CHECK ((last_error ~ '^[A-Za-z]{1,64}$'::text));

ALTER TABLE ONLY catalog_public_outbox ADD CONSTRAINT catalog_public_outbox_pkey PRIMARY KEY (sequence);

ALTER TABLE ONLY catalog_public_outbox ADD CONSTRAINT catalog_public_outbox_priority_check CHECK ((priority = ANY (ARRAY[0, 1])));

ALTER TABLE ONLY catalog_public_outbox ADD CONSTRAINT catalog_public_outbox_revision_check CHECK ((revision > 0));

ALTER TABLE ONLY catalog_public_outbox ADD CONSTRAINT catalog_public_outbox_target_kind_check CHECK ((target_kind = ANY (ARRAY['printing'::text, 'edition'::text])));

ALTER TABLE ONLY catalog_public_outbox ADD CONSTRAINT catalog_public_outbox_target_kind_target_id_revision_key UNIQUE (target_kind, target_id, revision);

ALTER TABLE ONLY catalog_set_code ADD CONSTRAINT catalog_set_code_code_check CHECK ((code ~ '^[A-Z0-9]{2,4}$'::text));

ALTER TABLE ONLY catalog_set_code ADD CONSTRAINT catalog_set_code_pkey PRIMARY KEY (set_id);

ALTER TABLE ONLY catalog_set_code ADD CONSTRAINT catalog_set_code_set_id_check CHECK (((length(set_id) >= 1) AND (length(set_id) <= 80)));

ALTER TABLE ONLY catalog_state ADD CONSTRAINT catalog_active_generation_fk FOREIGN KEY (active_generation) REFERENCES catalog_generation(id);

ALTER TABLE ONLY catalog_printing ADD CONSTRAINT catalog_printing_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES catalog_identity(id);

ALTER TABLE ONLY catalog_edition ADD CONSTRAINT catalog_edition_printing_id_fkey FOREIGN KEY (printing_id) REFERENCES catalog_printing(id);

ALTER TABLE ONLY catalog_generation_printing ADD CONSTRAINT catalog_generation_printing_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES catalog_generation(id) ON DELETE CASCADE;

ALTER TABLE ONLY catalog_generation_printing ADD CONSTRAINT catalog_generation_printing_printing_id_fkey FOREIGN KEY (printing_id) REFERENCES catalog_printing(id);

ALTER TABLE ONLY catalog_generation_edition ADD CONSTRAINT catalog_generation_edition_edition_id_fkey FOREIGN KEY (edition_id) REFERENCES catalog_edition(id);

ALTER TABLE ONLY catalog_generation_edition ADD CONSTRAINT catalog_generation_edition_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES catalog_generation(id) ON DELETE CASCADE;

ALTER TABLE ONLY catalog_generation_edition ADD CONSTRAINT catalog_generation_edition_printing_id_fkey FOREIGN KEY (printing_id) REFERENCES catalog_printing(id);

ALTER TABLE ONLY catalog_review ADD CONSTRAINT catalog_review_printing_id_fkey FOREIGN KEY (printing_id) REFERENCES catalog_printing(id);

ALTER TABLE ONLY catalog_review ADD CONSTRAINT catalog_review_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES inventory_owner(user_id);

ALTER TABLE ONLY catalog_printing_display ADD CONSTRAINT catalog_printing_display_printing_id_fkey FOREIGN KEY (printing_id) REFERENCES catalog_printing(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX catalog_one_active_run ON public.catalog_run USING btree ((true)) WHERE (outcome IS NULL);

CREATE INDEX catalog_printing_identity ON public.catalog_printing USING btree (identity_id, id);

CREATE UNIQUE INDEX catalog_edition_id_printing ON public.catalog_edition USING btree (id, printing_id);

CREATE INDEX catalog_edition_printing ON public.catalog_edition USING btree (printing_id, id);

CREATE INDEX catalog_gen_order ON public.catalog_generation_printing USING btree (generation_id, search_name, set_id, collector_number, printing_id) WHERE (NOT tombstoned);

CREATE INDEX catalog_gen_search ON public.catalog_generation_printing USING btree (generation_id, search_name text_pattern_ops, printing_id);

CREATE INDEX catalog_gen_set_number ON public.catalog_generation_printing USING btree (generation_id, set_id, collector_number);

CREATE INDEX catalog_gen_set_number_ci ON public.catalog_generation_printing USING btree (generation_id, lower(set_id), lower(collector_number), search_name, printing_id) WHERE (NOT tombstoned);

CREATE INDEX catalog_review_pending ON public.catalog_review USING btree (status, created_at, id);

CREATE INDEX catalog_public_outbox_pending ON public.catalog_public_outbox USING btree (priority, sequence) WHERE (delivered_at IS NULL);

CREATE TRIGGER immutable_edition_public_reference BEFORE UPDATE ON public.catalog_edition FOR EACH ROW EXECUTE FUNCTION immutable_catalog_public_reference();

CREATE TRIGGER immutable_printing_display BEFORE UPDATE ON public.catalog_printing_display FOR EACH ROW EXECUTE FUNCTION immutable_printing_display();

CREATE TRIGGER immutable_printing_public_reference BEFORE UPDATE ON public.catalog_printing FOR EACH ROW EXECUTE FUNCTION immutable_catalog_public_reference();

CREATE TRIGGER remember_printing_display AFTER INSERT ON public.catalog_generation_printing FOR EACH ROW EXECUTE FUNCTION remember_printing_display();

CREATE VIEW catalog_printing_set_code AS SELECT p.id AS printing_id, coalesce(sc.code, '') AS set_code FROM catalog_printing p LEFT JOIN catalog_printing_display pd ON pd.printing_id=p.id LEFT JOIN catalog_set_code sc ON sc.set_id=pd.set_id;

CREATE VIEW catalog_printing_art AS SELECT p.id AS printing_id, NULL::text AS tcgdex_url, NULL::text AS low_image_url, NULL::text AS high_image_url, NULL::text AS small_art_url, NULL::text AS large_art_url, NULL::text AS art_version, NULL::text AS large_upgrade_url, NULL::text AS stored_upgrade_url FROM catalog_printing p;

CREATE VIEW catalog_edition_art AS SELECT p.id AS edition_id, p.printing_id AS printing_id, NULL::jsonb AS linked_art, false AS art_scoped, false AS art_withheld, NULL::text AS art_set_id, NULL::text AS art_number, NULL::text AS low_image_url, NULL::text AS high_image_url, NULL::text AS stored_upgrade_url, false AS reference_only, NULL::text AS small_art_url, NULL::text AS large_art_url FROM catalog_edition p;

INSERT INTO catalog_state(singleton) VALUES (true);

INSERT INTO catalog_attribute_state DEFAULT VALUES;
