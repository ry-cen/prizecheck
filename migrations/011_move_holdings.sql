CREATE TABLE move_manifest (
  owner_id text PRIMARY KEY REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
  id uuid NOT NULL UNIQUE,
  source_id uuid NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '1 hour'),
  FOREIGN KEY (owner_id, source_id) REFERENCES location(owner_id, id) ON DELETE CASCADE
);
CREATE INDEX move_manifest_expiry ON move_manifest(expires_at);

CREATE TABLE move_manifest_item (
  owner_id text NOT NULL REFERENCES move_manifest(owner_id) ON DELETE CASCADE,
  edition_id uuid NOT NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  expected_version bigint NOT NULL CHECK (expected_version > 0),
  PRIMARY KEY (owner_id, edition_id)
);

-- Replay responses contain counts only. Neither this table nor mutation_request
-- contains the selected Editions after the manifest is consumed.
CREATE TABLE move_response (
  owner_id text NOT NULL,
  request_key uuid NOT NULL,
  edition_count integer NOT NULL CHECK (edition_count > 0),
  copy_count numeric(30,0) NOT NULL CHECK (copy_count > 0),
  PRIMARY KEY (owner_id, request_key),
  FOREIGN KEY (owner_id, request_key)
    REFERENCES mutation_request(owner_id, request_key) ON DELETE CASCADE
);
