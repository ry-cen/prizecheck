ALTER TABLE inventory_owner ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS location_unique_sibling_name
  ON location (owner_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));

CREATE TABLE IF NOT EXISTS location_command (
  owner_id text NOT NULL REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
  request_key uuid NOT NULL,
  request_digest text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, request_key)
);
