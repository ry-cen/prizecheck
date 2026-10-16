-- Handles, Display Names and Invite Links (social network #246, spec "Handles, Invite Links and lookup").
-- Social network migrations use the reserved block 100-139 (docs/planning/social-network/migrations.md).
-- Re-runnable: every object is created only when missing and the backfill fills only accounts without a profile.

-- One profile per collector, made when the inventory_owner row is made (trigger below) and backfilled here.
-- handle keeps the case the collector typed; handle_key is the lower-cased Handle that lookups and uniqueness use.
-- handle_changed_at is NULL until the collector first chooses a Handle; the 30-day change limit runs from it.
CREATE TABLE IF NOT EXISTS collector_profile (
  user_id text PRIMARY KEY REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
  handle text NOT NULL CHECK (handle ~ '^[A-Za-z0-9_]{3,20}$'),
  handle_key text NOT NULL UNIQUE CHECK (handle_key = lower(handle)),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40),
  handle_changed_at timestamptz
);

-- A Handle a collector changed away from, held for 30 days so nobody else can claim it. Rows older than 30 days are
-- pruned when a Handle changes.
CREATE TABLE IF NOT EXISTS released_handle (
  handle_key text PRIMARY KEY CHECK (handle_key ~ '^[a-z0-9_]{3,20}$'),
  released_at timestamptz NOT NULL DEFAULT now()
);

-- One Invite Link per collector, made the first time the profile is read. The token is private (Copy link shows it
-- again); the public records store keys the signed-out page by token_hash (sha256 of the token, hex) only.
CREATE TABLE IF NOT EXISTS invite_link (
  user_id text PRIMARY KEY REFERENCES collector_profile(user_id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{32}$'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Pending writes of the public invite records (key invite:<token_hash>): a display_name puts the record, NULL removes
-- it. Only the triggers below write it; profile commands drain it after they commit (social.profile.drain_invites).
-- Nothing references a collector, so a removal outlives the account. For one token_hash, ids follow commit order,
-- because every write for it holds that collector's inventory_owner lock.
CREATE TABLE IF NOT EXISTS invite_projection_outbox (
  id bigserial PRIMARY KEY,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  display_name text CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Rate-limited Handle actions: 'handle_change' attempts that reach the availability check (#246) and 'lookup'
-- (Handle lookup, #247). Rows older than an hour are pruned when one is written, as auth_rate_event is.
CREATE TABLE IF NOT EXISTS handle_lookup_event (
  user_id text NOT NULL REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('lookup', 'handle_change')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS handle_lookup_event_recent ON handle_lookup_event(user_id, kind, created_at);

-- A generated Handle: collector_ and 8 characters with no vowels and no digit that reads as a letter, so no word can
-- form in it. 24^8 (about 1.1e11) choices, drawn from gen_random_uuid's strong random bytes.
CREATE OR REPLACE FUNCTION generated_handle() RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  alphabet constant text := 'bcdfghjklmnpqrstvwxz2689';
  noise bytea := sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()));
  result text := 'collector_';
BEGIN
  FOR i IN 0..7 LOOP
    result := result || substr(alphabet, get_byte(noise, i) % 24 + 1, 1);
  END LOOP;
  RETURN result;
END $$;

-- Gives one collector a profile with a generated Handle and the placeholder Display Name, unless they have one.
CREATE OR REPLACE FUNCTION create_collector_profile(owner text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  candidate text;
BEGIN
  FOR attempt IN 1..20 LOOP
    IF EXISTS (SELECT 1 FROM collector_profile WHERE user_id = owner) THEN
      RETURN;
    END IF;
    candidate := generated_handle();
    CONTINUE WHEN EXISTS (SELECT 1 FROM released_handle WHERE handle_key = candidate);
    INSERT INTO collector_profile(user_id, handle, handle_key, display_name)
      VALUES (owner, candidate, candidate, 'Collector')
      ON CONFLICT DO NOTHING;
    IF FOUND THEN
      RETURN;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'could not generate a Handle for %', owner;
END $$;

-- Every way an account is made (the auth onboarding trigger of migration 020, the API's lazy inserts, test fixtures)
-- inserts inventory_owner, so the profile is made here.
CREATE OR REPLACE FUNCTION onboard_collector_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM create_collector_profile(NEW.user_id);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS onboard_collector_profile ON inventory_owner;
CREATE TRIGGER onboard_collector_profile AFTER INSERT ON inventory_owner
  FOR EACH ROW EXECUTE FUNCTION onboard_collector_profile();

-- The public invite record follows the Invite Link and the Display Name: a new link puts its record, a new token
-- removes the old record and puts the new one, a deleted link (account deletion, a later ticket) removes its record,
-- and a changed Display Name rewrites the record of the collector's link.
CREATE OR REPLACE FUNCTION queue_invite_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'invite_link' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      INSERT INTO invite_projection_outbox(token_hash, display_name) VALUES (OLD.token_hash, NULL);
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      INSERT INTO invite_projection_outbox(token_hash, display_name)
        SELECT NEW.token_hash, p.display_name FROM collector_profile p WHERE p.user_id = NEW.user_id;
    END IF;
  ELSE
    INSERT INTO invite_projection_outbox(token_hash, display_name)
      SELECT l.token_hash, NEW.display_name FROM invite_link l WHERE l.user_id = NEW.user_id;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS queue_invite_record ON invite_link;
CREATE TRIGGER queue_invite_record AFTER INSERT OR DELETE OR UPDATE OF token_hash ON invite_link
  FOR EACH ROW EXECUTE FUNCTION queue_invite_record();
DROP TRIGGER IF EXISTS queue_invite_record ON collector_profile;
CREATE TRIGGER queue_invite_record AFTER UPDATE OF display_name ON collector_profile
  FOR EACH ROW WHEN (OLD.display_name IS DISTINCT FROM NEW.display_name) EXECUTE FUNCTION queue_invite_record();

-- Backfill: every existing account gets a profile.
SELECT create_collector_profile(user_id) FROM inventory_owner ORDER BY user_id;
