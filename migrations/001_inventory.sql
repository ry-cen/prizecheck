CREATE TABLE IF NOT EXISTS inventory_owner (
  user_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS location (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
  parent_id uuid REFERENCES location(id),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('storage_leaf', 'organization', 'deck')),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_unsorted_root_per_owner ON location(owner_id, name) WHERE parent_id IS NULL AND name = 'Unsorted';
CREATE INDEX IF NOT EXISTS location_owner_parent ON location(owner_id, parent_id);
CREATE TABLE IF NOT EXISTS owner_binding (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  user_id text NOT NULL REFERENCES inventory_owner(user_id),
  bound_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_send_event (
  id bigserial PRIMARY KEY,
  email_key text NOT NULL,
  ip_key text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_send_email_time ON auth_send_event(email_key, sent_at DESC);
CREATE INDEX IF NOT EXISTS auth_send_ip_time ON auth_send_event(ip_key, sent_at DESC);
