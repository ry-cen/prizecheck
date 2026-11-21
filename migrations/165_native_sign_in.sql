-- Native iOS sign-in (opt-in, nonprod only: NATIVE_SIGN_IN=on). A one-time grant is issued after an explicit consent and
-- exchanged, with the device's PKCE verifier, for a short-lived credential that may read the Collection and nothing else.
-- Only sha256 hashes of the code and the token are stored. Both tables stay empty while the switch is off.
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
-- The consent and the code exchange are rate limited per trusted IP in auth_rate_event, like sign-in starts.
ALTER TABLE auth_rate_event DROP CONSTRAINT auth_rate_event_kind_check;
ALTER TABLE auth_rate_event ADD CONSTRAINT auth_rate_event_kind_check CHECK (kind IN ('signup','start','native_approve','native_token'));
