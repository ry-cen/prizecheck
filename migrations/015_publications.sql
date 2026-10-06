-- Private linkage and durable projection work never serve anonymous reads.
CREATE TABLE deck_publication (
  token text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES inventory_owner(user_id),
  deck_id uuid NOT NULL REFERENCES location(id),
  version bigint NOT NULL DEFAULT 1,
  title text NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  visibility text NOT NULL DEFAULT 'unlisted' CHECK (visibility IN ('unlisted','listed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_deck_publication ON deck_publication(deck_id) WHERE NOT revoked;
CREATE TABLE publication_command (
  sequence bigserial PRIMARY KEY,
  owner_id text NOT NULL REFERENCES inventory_owner(user_id),
  request_key uuid NOT NULL,
  request_digest text NOT NULL,
  token text NOT NULL REFERENCES deck_publication(token),
  projection jsonb,
  result jsonb NOT NULL,
  projected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,request_key)
);
CREATE INDEX publication_pending_projection ON publication_command(sequence) WHERE NOT projected;
