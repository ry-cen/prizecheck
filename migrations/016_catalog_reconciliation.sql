-- Display data belongs to the immutable Printing identity, independent of retained imports.
CREATE TABLE catalog_printing_display (
 printing_id uuid PRIMARY KEY REFERENCES catalog_printing(id) ON DELETE CASCADE,
 display_name text NOT NULL,set_id text NOT NULL,set_name text NOT NULL,
 collector_number text NOT NULL,image_url text
);
INSERT INTO catalog_printing_display
 SELECT DISTINCT ON (gp.printing_id) gp.printing_id,gp.display_name,gp.set_id,gp.set_name,gp.collector_number,gp.image_url
 FROM catalog_generation_printing gp JOIN catalog_generation g ON g.id=gp.generation_id
 ORDER BY gp.printing_id,g.imported_at;
CREATE FUNCTION remember_printing_display() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO catalog_printing_display VALUES
 (NEW.printing_id,NEW.display_name,NEW.set_id,NEW.set_name,NEW.collector_number,NEW.image_url)
 ON CONFLICT(printing_id) DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER remember_printing_display AFTER INSERT ON catalog_generation_printing
 FOR EACH ROW EXECUTE FUNCTION remember_printing_display();
CREATE FUNCTION immutable_printing_display() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Printing display data is immutable'; END $$;
CREATE TRIGGER immutable_printing_display BEFORE UPDATE ON catalog_printing_display
 FOR EACH ROW EXECUTE FUNCTION immutable_printing_display();
ALTER TABLE catalog_review DROP CONSTRAINT catalog_review_kind_check;
ALTER TABLE catalog_review ADD CONSTRAINT catalog_review_kind_check
 CHECK(kind IN ('name_change','variant_ambiguity','source_match'));
ALTER TABLE catalog_review ADD COLUMN candidate jsonb NOT NULL DEFAULT '{}';
ALTER TABLE catalog_review ADD COLUMN reviewer_id text REFERENCES inventory_owner(user_id);
ALTER TABLE catalog_review ADD COLUMN reviewed_at timestamptz;
ALTER TABLE catalog_review ADD COLUMN evidence_url text;
ALTER TABLE catalog_review ADD COLUMN reason text;
CREATE TABLE catalog_source_reference (
 source_id text PRIMARY KEY,
 printing_id uuid NOT NULL REFERENCES catalog_printing(id),
 review_id uuid NOT NULL REFERENCES catalog_review(id),
 evidence_url text NOT NULL,confirmed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE catalog_edition_replacement (
 edition_id uuid PRIMARY KEY REFERENCES catalog_edition(id),
 replacement_edition_id uuid NOT NULL REFERENCES catalog_edition(id),
 review_id uuid REFERENCES catalog_review(id),
 reviewer_id text NOT NULL REFERENCES inventory_owner(user_id),
 evidence_url text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(edition_id<>replacement_edition_id)
);
ALTER TABLE catalog_approval_code ALTER COLUMN report_id DROP NOT NULL;
ALTER TABLE catalog_approval_code ADD COLUMN review_id uuid REFERENCES catalog_review(id);
ALTER TABLE catalog_approval_code DROP CONSTRAINT catalog_approval_code_action_check;
ALTER TABLE catalog_approval_code ADD CONSTRAINT catalog_approval_code_action_check
 CHECK(action IN ('approve_printing','approve_edition','confirm_source','resolve_catalog'));
ALTER TABLE catalog_approval_code ADD CHECK ((report_id IS NULL)<>(review_id IS NULL));
CREATE INDEX catalog_review_pending ON catalog_review(status,created_at,id);
CREATE TABLE catalog_printing_replacement (
 printing_id uuid PRIMARY KEY REFERENCES catalog_printing(id),
 replacement_printing_id uuid NOT NULL REFERENCES catalog_printing(id),
 review_id uuid NOT NULL REFERENCES catalog_review(id),
 CHECK(printing_id<>replacement_printing_id)
);
