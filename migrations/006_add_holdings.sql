ALTER TABLE location ADD CONSTRAINT location_owner_identity UNIQUE (owner_id, id);

CREATE TABLE holding (
  owner_id text NOT NULL REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  edition_id uuid NOT NULL REFERENCES catalog_edition(id),
  quantity bigint NOT NULL CHECK (quantity > 0),
  version bigint NOT NULL CHECK (version > 0),
  PRIMARY KEY (owner_id, location_id, edition_id),
  FOREIGN KEY (owner_id, location_id) REFERENCES location(owner_id, id) ON DELETE RESTRICT
);
CREATE INDEX holding_owner_edition_location ON holding(owner_id, edition_id, location_id);

CREATE TABLE mutation_request (
  owner_id text NOT NULL REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
  request_key uuid NOT NULL,
  command_digest text NOT NULL,
  result_revision bigint NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  PRIMARY KEY (owner_id, request_key)
);
CREATE INDEX mutation_request_expiry ON mutation_request(expires_at);

CREATE FUNCTION holding_leaf_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM location l
    WHERE l.owner_id = NEW.owner_id AND l.id = NEW.location_id
      AND l.kind IN ('storage_leaf', 'deck')
      AND NOT EXISTS (SELECT 1 FROM location child WHERE child.parent_id = l.id)
  ) THEN
    RAISE EXCEPTION 'Holding requires an owned Storage Leaf' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER holding_leaf_guard_trigger
  AFTER INSERT OR UPDATE ON holding DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION holding_leaf_guard();
