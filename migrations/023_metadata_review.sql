-- Reviewed target metadata: commit-ordered public revisions, rule activation, reports,
-- maintainer decisions, effective Live/Marketplace state and a durable dirty-target outbox.
-- No ID, descriptor, public reference or correspondence is rewritten here.

-- Every correction takes its public revision from one clock row that stays locked until
-- commit, so revisions are ordered by commit and not by allocation.
CREATE TABLE catalog_public_clock (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0)
);
INSERT INTO catalog_public_clock DEFAULT VALUES;
CREATE FUNCTION catalog_begin_correction() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE r bigint := nullif(current_setting('tcg.catalog_revision', true), '')::bigint;
BEGIN
 IF r IS NULL THEN
  UPDATE catalog_public_clock SET revision=revision+1 WHERE singleton RETURNING revision INTO r;
  PERFORM set_config('tcg.catalog_revision', r::text, true);
 END IF;
 RETURN r;
END $$;

CREATE FUNCTION catalog_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Catalog review records are append-only'; END $$;

-- Rules live in code; rows record the maintainer's activation of one reviewed version.
CREATE TABLE catalog_rule_activation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 kind text NOT NULL CHECK(kind IN ('live_derivation','marketplace_matching')),
 version integer CHECK(version>0),
 code_digest text CHECK(code_digest ~ '^[0-9a-f]{64}$'),
 reviewer_id text NOT NULL REFERENCES inventory_owner(user_id),
 evidence_url text NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 clock_revision bigint NOT NULL,
 activated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((version IS NULL)=(code_digest IS NULL))
);
CREATE TRIGGER catalog_rule_activation_append_only BEFORE UPDATE OR DELETE ON catalog_rule_activation
 FOR EACH ROW EXECUTE FUNCTION catalog_append_only();
CREATE TABLE catalog_rule_state (
 kind text PRIMARY KEY CHECK(kind IN ('live_derivation','marketplace_matching')),
 activation_id uuid REFERENCES catalog_rule_activation(id)
);
INSERT INTO catalog_rule_state(kind) VALUES ('live_derivation'),('marketplace_matching');

-- Collector reports are unapproved input.
CREATE UNIQUE INDEX catalog_edition_id_printing ON catalog_edition(id,printing_id);
CREATE TABLE catalog_metadata_report (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 reporter_id text REFERENCES inventory_owner(user_id) ON DELETE SET NULL,
 target text NOT NULL CHECK(target IN ('live','marketplace')),
 issue text NOT NULL CHECK(issue IN ('missing','incorrect')),
 printing_id uuid NOT NULL REFERENCES catalog_printing(id),
 edition_id uuid,
 proposed jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(proposed)='object' AND pg_column_size(proposed)<=2048),
 evidence_url text CHECK(evidence_url IS NULL OR length(evidence_url)<=2048),
 note text NOT NULL DEFAULT '' CHECK(length(note)<=2000),
 observed_revision bigint,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','needs_info','rejected','approved','superseded')),
 review_reason text,
 reviewer_id text REFERENCES inventory_owner(user_id),
 reviewed_at timestamptz,
 decision_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(edition_id,printing_id) REFERENCES catalog_edition(id,printing_id),
 CHECK(target<>'marketplace' OR edition_id IS NOT NULL),
 CHECK((status IN ('approved','rejected'))=(reviewer_id IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX catalog_metadata_report_reporter ON catalog_metadata_report(reporter_id,created_at DESC);
CREATE INDEX catalog_metadata_report_queue ON catalog_metadata_report(status,created_at,id);

-- Maintainer decisions are append-only provenance.
CREATE TABLE catalog_metadata_decision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 target text NOT NULL CHECK(target IN ('live','marketplace')),
 printing_id uuid NOT NULL REFERENCES catalog_printing(id),
 edition_id uuid,
 decision text NOT NULL CHECK(decision IN ('verify_source','correct','reject_source','unmap','unsupported')),
 reviewed_value jsonb NOT NULL,
 source_value jsonb,
 source_fingerprint text CHECK(source_fingerprint ~ '^[0-9a-f]{64}$'),
 checks jsonb NOT NULL DEFAULT '{}',
 basis_revision bigint NOT NULL,
 rule_activation_id uuid REFERENCES catalog_rule_activation(id),
 evidence_url text NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 reviewer_id text NOT NULL REFERENCES inventory_owner(user_id),
 reviewed_at timestamptz NOT NULL DEFAULT now(),
 clock_revision bigint NOT NULL,
 FOREIGN KEY(edition_id,printing_id) REFERENCES catalog_edition(id,printing_id),
 CHECK((target='marketplace')=(edition_id IS NOT NULL))
);
CREATE TRIGGER catalog_metadata_decision_append_only BEFORE UPDATE OR DELETE ON catalog_metadata_decision
 FOR EACH ROW EXECUTE FUNCTION catalog_append_only();
CREATE INDEX catalog_metadata_decision_printing ON catalog_metadata_decision(printing_id,reviewed_at DESC);
ALTER TABLE catalog_metadata_report ADD FOREIGN KEY(decision_id) REFERENCES catalog_metadata_decision(id);
CREATE TABLE catalog_metadata_rejection (
 target text NOT NULL CHECK(target IN ('live','marketplace')),
 printing_id uuid NOT NULL REFERENCES catalog_printing(id),
 edition_id uuid REFERENCES catalog_edition(id),
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[0-9a-f]{64}$'),
 decision_id uuid NOT NULL REFERENCES catalog_metadata_decision(id),
 CHECK((target='marketplace')=(edition_id IS NOT NULL))
);
CREATE UNIQUE INDEX catalog_rejection_live ON catalog_metadata_rejection(printing_id,source_fingerprint) WHERE target='live';
CREATE UNIQUE INDEX catalog_rejection_market ON catalog_metadata_rejection(edition_id,source_fingerprint) WHERE target='marketplace';

-- Effective state replaces the 021 booleans. Nothing ever verified a mapping or Live input,
-- so every former quarantine becomes an unverified/unsupported default without losing eligibility.
ALTER TABLE catalog_edition_metadata
 ADD COLUMN mapping_state text NOT NULL DEFAULT 'unverified' CHECK(mapping_state IN ('unverified','verified','quarantined')),
 ADD COLUMN product_id bigint CHECK(product_id>0),
 ADD COLUMN quote_variant text CHECK(quote_variant ~ '^[a-z0-9-]{1,40}$'),
 ADD COLUMN mapping_basis text CHECK(mapping_basis IN ('matching_rule','maintainer')),
 ADD COLUMN mapping_decision_id uuid REFERENCES catalog_metadata_decision(id),
 ADD COLUMN matching_activation_id uuid REFERENCES catalog_rule_activation(id),
 ADD COLUMN accepted_fingerprint text,
 ADD COLUMN mapping_reason text CHECK(mapping_reason IN ('candidate_changed','candidate_conflict','physical_conflict',
   'duplicate_mapping','recovery_conflict','reviewed_unmapped','unspecified_variant','no_matching_rule','rule_failed')),
 ADD COLUMN auto_closed boolean NOT NULL DEFAULT false,
 ADD COLUMN public_revision bigint NOT NULL DEFAULT 0,
 ADD CHECK(mapping_state<>'verified' OR (product_id IS NOT NULL AND mapping_basis IS NOT NULL)),
 ADD CHECK(mapping_basis IS DISTINCT FROM 'maintainer' OR mapping_decision_id IS NOT NULL),
 ADD CHECK(mapping_basis IS DISTINCT FROM 'matching_rule' OR matching_activation_id IS NOT NULL),
 ADD CHECK(quote_variant IS NULL OR product_id IS NOT NULL),
 ADD CHECK(mapping_state<>'quarantined' OR mapping_reason IS NOT NULL),
 ADD CHECK(mapping_state NOT IN ('verified','quarantined') OR auto_closed);
-- DB backstop: one verified Edition per (product, quote variant), so no two Editions share a price.
CREATE UNIQUE INDEX catalog_edition_verified_price_slot ON catalog_edition_metadata(product_id,quote_variant)
 WHERE mapping_state='verified' AND quote_variant IS NOT NULL;
-- One price slot per (Printing, quote variant) whatever the product: the published quote lookup names the
-- Printing's source card and variant key but not the product, so two sibling Editions in one slot would show one price.
ALTER TABLE catalog_edition_metadata ADD COLUMN printing_id uuid;
UPDATE catalog_edition_metadata m SET printing_id=e.printing_id FROM catalog_edition e WHERE e.id=m.edition_id;
ALTER TABLE catalog_edition_metadata ALTER COLUMN printing_id SET NOT NULL,
 ADD FOREIGN KEY (edition_id,printing_id) REFERENCES catalog_edition(id,printing_id) ON DELETE CASCADE;
CREATE UNIQUE INDEX catalog_edition_verified_printing_slot ON catalog_edition_metadata(printing_id,quote_variant)
 WHERE mapping_state='verified' AND quote_variant IS NOT NULL;
ALTER TABLE catalog_edition_metadata DROP COLUMN mapping_verified, DROP COLUMN mapping_quarantined;

ALTER TABLE catalog_printing_metadata
 ADD COLUMN live_state text NOT NULL DEFAULT 'unsupported' CHECK(live_state IN ('unsupported','eligible','suspended')),
 ADD COLUMN live_basis text CHECK(live_basis IN ('rule','maintainer')),
 ADD COLUMN live_inputs jsonb,
 ADD COLUMN live_identity jsonb,
 ADD COLUMN live_claim text,
 ADD COLUMN live_decision_id uuid REFERENCES catalog_metadata_decision(id),
 ADD COLUMN live_activation_id uuid REFERENCES catalog_rule_activation(id),
 ADD COLUMN live_accepted_fingerprint text,
 ADD COLUMN live_reason text DEFAULT 'no_active_rule' CHECK(live_reason IN ('unreviewed_inputs','missing_input','rule_uncovered',
   'no_active_rule','source_changed','identity_review_pending','conflicting_input','recovery_conflict','reviewed_unsupported')),
 ADD COLUMN live_auto_closed boolean NOT NULL DEFAULT false,
 ADD COLUMN public_revision bigint NOT NULL DEFAULT 0,
 ADD CHECK(live_state<>'eligible' OR (live_identity IS NOT NULL AND live_activation_id IS NOT NULL AND live_basis IS NOT NULL)),
 ADD CHECK(live_basis IS DISTINCT FROM 'maintainer' OR live_state<>'eligible' OR live_decision_id IS NOT NULL),
 ADD CHECK((live_identity IS NULL)=(live_state<>'eligible')),
 ADD CHECK((live_state='eligible')=(live_reason IS NULL)),
 -- Once a Printing has been eligible, loss of eligibility is a suspension that only a
 -- maintainer decision lifts; it is never an automatic return to unsupported.
 ADD CHECK(live_state NOT IN ('eligible','suspended') OR live_auto_closed),
 ADD CHECK(NOT live_auto_closed OR live_state<>'unsupported' OR live_reason='reviewed_unsupported');
ALTER TABLE catalog_printing_metadata DROP COLUMN live_verified, DROP COLUMN live_quarantined;
CREATE INDEX catalog_printing_live_claim ON catalog_printing_metadata(live_claim) WHERE live_claim IS NOT NULL;

-- Approval codes may now name a metadata decision or a rule activation.
ALTER TABLE catalog_approval_code ADD COLUMN metadata_target text
 CHECK(metadata_target ~ '^(edition|printing):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR metadata_target ~ '^rule:(live_derivation|marketplace_matching):[0-9]{1,6}$');
DO $$
DECLARE found record; dropped integer := 0;
BEGIN
 FOR found IN SELECT conname FROM pg_constraint
   WHERE conrelid='catalog_approval_code'::regclass AND contype='c'
     AND pg_get_constraintdef(oid) LIKE '%report_id IS NULL%' AND pg_get_constraintdef(oid) LIKE '%review_id IS NULL%'
 LOOP
  EXECUTE format('ALTER TABLE catalog_approval_code DROP CONSTRAINT %I', found.conname);
  dropped := dropped+1;
 END LOOP;
 IF dropped <> 1 THEN RAISE EXCEPTION 'Expected exactly one report/review exclusivity constraint, found %', dropped; END IF;
END $$;
ALTER TABLE catalog_approval_code ADD CONSTRAINT catalog_approval_code_one_target
 CHECK(num_nonnulls(report_id,review_id,metadata_target)=1);
ALTER TABLE catalog_approval_code DROP CONSTRAINT catalog_approval_code_action_check;
ALTER TABLE catalog_approval_code ADD CONSTRAINT catalog_approval_code_action_check
 CHECK(action IN ('approve_printing','approve_edition','confirm_source','resolve_catalog','resolve_metadata','activate_rule'));
CREATE INDEX catalog_approval_code_metadata ON catalog_approval_code(owner_id,metadata_target,action,created_at DESC)
 WHERE metadata_target IS NOT NULL;

-- Durable dirty-target list: delivery re-reads current PostgreSQL state.
CREATE TABLE catalog_public_outbox (
 sequence bigserial PRIMARY KEY,
 target_kind text NOT NULL CHECK(target_kind IN ('printing','edition')),
 target_id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),
 priority smallint NOT NULL DEFAULT 1 CHECK(priority IN (0,1)),
 created_at timestamptz NOT NULL DEFAULT now(),
 delivered_at timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 last_error text CHECK(last_error ~ '^[A-Za-z]{1,64}$'),
 UNIQUE(target_kind,target_id,revision)
);
CREATE INDEX catalog_public_outbox_pending ON catalog_public_outbox(priority,sequence) WHERE delivered_at IS NULL;

-- Database-enforced revision stamping and same-transaction enqueue.
CREATE FUNCTION stamp_edition_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.printing_id IS NULL THEN
  SELECT printing_id INTO NEW.printing_id FROM catalog_edition WHERE id=NEW.edition_id;
 END IF;
 IF NEW.mapping_state='verified' AND EXISTS (SELECT 1 FROM catalog_edition e
     WHERE e.id=NEW.edition_id AND e.descriptor->>'label'='Unspecified Variant') THEN
  RAISE EXCEPTION 'An Unspecified Variant cannot be marketplace-verified';
 END IF;
 IF TG_OP='INSERT' OR (NEW.mapping_state,NEW.mapping_revision,NEW.product_id,NEW.quote_variant,NEW.mapping_reason)
    IS DISTINCT FROM (OLD.mapping_state,OLD.mapping_revision,OLD.product_id,OLD.quote_variant,OLD.mapping_reason) THEN
  NEW.public_revision := catalog_begin_correction();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stamp_edition_metadata BEFORE INSERT OR UPDATE ON catalog_edition_metadata
 FOR EACH ROW EXECUTE FUNCTION stamp_edition_metadata();
CREATE FUNCTION stamp_printing_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR (NEW.live_state,NEW.live_identity,NEW.live_activation_id,NEW.live_reason)
    IS DISTINCT FROM (OLD.live_state,OLD.live_identity,OLD.live_activation_id,OLD.live_reason) THEN
  NEW.public_revision := catalog_begin_correction();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stamp_printing_metadata BEFORE INSERT OR UPDATE ON catalog_printing_metadata
 FOR EACH ROW EXECUTE FUNCTION stamp_printing_metadata();
CREATE FUNCTION enqueue_metadata_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text; target uuid; urgent boolean;
BEGIN
 -- A second change in the same transaction keeps its revision, so enqueue also when the
 -- public tuple moves; the unique key makes that an idempotent priority upgrade.
 IF TG_TABLE_NAME='catalog_edition_metadata' THEN
  IF TG_OP='UPDATE' AND (NEW.public_revision,NEW.mapping_state,NEW.mapping_revision,NEW.product_id,NEW.quote_variant,NEW.mapping_reason)
     IS NOT DISTINCT FROM (OLD.public_revision,OLD.mapping_state,OLD.mapping_revision,OLD.product_id,OLD.quote_variant,OLD.mapping_reason)
  THEN RETURN NULL; END IF;
  kind := 'edition'; target := NEW.edition_id; urgent := NEW.mapping_state='quarantined';
 ELSE
  IF TG_OP='UPDATE' AND (NEW.public_revision,NEW.live_state,NEW.live_identity,NEW.live_activation_id,NEW.live_reason)
     IS NOT DISTINCT FROM (OLD.public_revision,OLD.live_state,OLD.live_identity,OLD.live_activation_id,OLD.live_reason)
  THEN RETURN NULL; END IF;
  kind := 'printing'; target := NEW.printing_id; urgent := NEW.live_state='suspended';
 END IF;
 INSERT INTO catalog_public_outbox(target_kind,target_id,revision,priority)
  VALUES (kind,target,NEW.public_revision,CASE WHEN urgent THEN 0 ELSE 1 END)
  ON CONFLICT(target_kind,target_id,revision) DO UPDATE
   SET priority=least(catalog_public_outbox.priority,EXCLUDED.priority)
   WHERE catalog_public_outbox.delivered_at IS NULL;
 RETURN NULL;
END $$;
CREATE TRIGGER enqueue_edition_metadata AFTER INSERT OR UPDATE ON catalog_edition_metadata
 FOR EACH ROW EXECUTE FUNCTION enqueue_metadata_outbox();
CREATE TRIGGER enqueue_printing_metadata AFTER INSERT OR UPDATE ON catalog_printing_metadata
 FOR EACH ROW EXECUTE FUNCTION enqueue_metadata_outbox();

-- Every Printing and Edition has a metadata row from its first moment.
CREATE FUNCTION default_printing_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO catalog_printing_metadata(printing_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
 RETURN NULL;
END $$;
CREATE TRIGGER default_printing_metadata AFTER INSERT ON catalog_printing
 FOR EACH ROW EXECUTE FUNCTION default_printing_metadata();
CREATE FUNCTION default_edition_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO catalog_edition_metadata(edition_id,mapping_reason)
  VALUES (NEW.id,CASE WHEN NEW.descriptor->>'label'='Unspecified Variant' THEN 'unspecified_variant' ELSE 'no_matching_rule' END)
  ON CONFLICT DO NOTHING;
 RETURN NULL;
END $$;
CREATE TRIGGER default_edition_metadata AFTER INSERT ON catalog_edition
 FOR EACH ROW EXECUTE FUNCTION default_edition_metadata();

-- Backfill: one revision for the whole migration, everything enqueued, nothing identity-bearing touched.
INSERT INTO catalog_printing_metadata(printing_id) SELECT id FROM catalog_printing ON CONFLICT DO NOTHING;
INSERT INTO catalog_edition_metadata(edition_id,mapping_reason)
 SELECT id,CASE WHEN descriptor->>'label'='Unspecified Variant' THEN 'unspecified_variant' ELSE 'no_matching_rule' END
 FROM catalog_edition ON CONFLICT DO NOTHING;
UPDATE catalog_edition_metadata m SET public_revision=catalog_begin_correction(),
 mapping_reason=CASE WHEN e.descriptor->>'label'='Unspecified Variant' THEN 'unspecified_variant' ELSE 'no_matching_rule' END
 FROM catalog_edition e WHERE e.id=m.edition_id AND m.public_revision=0;
UPDATE catalog_printing_metadata SET public_revision=catalog_begin_correction() WHERE public_revision=0;
