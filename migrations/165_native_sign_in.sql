-- Native iOS sign-in (opt-in, nonprod only: NATIVE_SIGN_IN=on). A one-time grant is issued after an explicit consent and
-- exchanged, with the device's PKCE verifier, for a short-lived credential that may read the Collection and nothing else.
-- Only sha256 hashes of the code and the token are stored. The tables stay empty while the switch is off.
CREATE TABLE native_grant (
  code_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX native_grant_expires ON native_grant(expires_at);
CREATE TABLE native_credential (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope = 'collection:read'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX native_credential_user ON native_credential(user_id);
-- The consent and code exchange limits, per sha256 of the trusted IP. Their own table, so no native lock, prune or row can
-- touch the web sign-in limits (auth_rate_event). The gateway prunes rows older than two days whenever it writes one.
CREATE TABLE native_rate_event (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('approve','token')),
  ip_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX native_rate_event_kind_ip_time ON native_rate_event(kind, ip_key, created_at DESC);
CREATE INDEX native_rate_event_time ON native_rate_event(created_at);
