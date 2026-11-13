CREATE TABLE catalog_auto_settlement (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 subject text NOT NULL CHECK(subject IN ('review','edition','printing')),
 review_id uuid REFERENCES catalog_review(id),
 edition_id uuid REFERENCES catalog_edition(id),
 printing_id uuid REFERENCES catalog_printing(id),
 action text NOT NULL CHECK(action IN ('stale','superseded','reopened','default_accepted','released')),
 trigger text NOT NULL CHECK(trigger IN ('automatic','command')),
 actor_id text,
 before jsonb NOT NULL, after jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((subject='review')=(review_id IS NOT NULL)),
 CHECK(subject<>'edition' OR edition_id IS NOT NULL),
 CHECK(subject<>'printing' OR printing_id IS NOT NULL),
 CHECK((trigger='command')=(actor_id IS NOT NULL)));
CREATE TRIGGER catalog_auto_settlement_append_only BEFORE UPDATE OR DELETE ON catalog_auto_settlement
 FOR EACH ROW EXECUTE FUNCTION catalog_append_only();
CREATE INDEX catalog_auto_settlement_review ON catalog_auto_settlement(review_id) WHERE review_id IS NOT NULL;
CREATE INDEX catalog_auto_settlement_edition ON catalog_auto_settlement(edition_id) WHERE edition_id IS NOT NULL;
