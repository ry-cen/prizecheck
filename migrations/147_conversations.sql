-- Conversations (Trading #298, Stage 2 spec "Conversations and messages"; docs/planning/trading/migrations.md). Trading
-- migrations use the reserved block 140-179. Re-runnable. Not purely additive: it adds triggers to trade and
-- collector_profile, and backfills conversations for the pairs Stage 1 left trading.
--
-- One conversation per pair of collectors, with a member row for each side, plain-text messages, and the pair's Trade
-- rounds shown inline (trade.conversation_id). A conversation outlives an account: when one side is deleted its id goes
-- NULL, its name stays, and the messages stay with the conversation. Messages have no user foreign key.
--
-- Lock order (spec "Locks"): advisory locks, then inventory_owner rows ascending, then loan, then trade, then
-- conversation. The triggers below keep it:
--   * trade_joins_conversation (BEFORE INSERT) only finds or creates the pair's row and its two member rows. It never
--     attaches the pair's earlier Trades: that would lock closed trade rows in an order a concurrent rename does not
--     use. open_conversation (the API) attaches them, under both owner locks.
--   * trade_conversation_activity (AFTER INSERT OR UPDATE OF revision) runs after the foreign-key checks, so a Trade
--     step reaches conversation only after trade.
--   * trade_names_follow_profile_conversations sorts after trade_names_follow_profile (and after the loan trigger), so a
--     rename locks loan, then trade, then conversation rows. A name that sorted earlier could deadlock a rename against
--     an accept. Do not rename these triggers.
--
-- Account ids compare COLLATE "C" (byte order) here, as friendship_pair_order, social/owners.py and Python sorted() do.
-- Real account ids are mixed case, so a locale collation would order a pair differently from the code that writes it.

CREATE TABLE IF NOT EXISTS conversation (
  id uuid PRIMARY KEY,
  user_low text REFERENCES inventory_owner(user_id) ON DELETE SET NULL,
  user_high text REFERENCES inventory_owner(user_id) ON DELETE SET NULL,
  low_name text NOT NULL CHECK (char_length(low_name) BETWEEN 1 AND 40),
  high_name text NOT NULL CHECK (char_length(high_name) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),   -- messages and new Trade rows: list order, archive
  changed_at timestamptz NOT NULL DEFAULT now(),         -- any message or Trade step: the pulse watermark
  last_from_low_at timestamptz, last_from_high_at timestamptz,
  CONSTRAINT conversation_ordered CHECK (user_low IS NULL OR user_high IS NULL
    OR (user_low COLLATE "C") < (user_high COLLATE "C")),
  CONSTRAINT conversation_pair UNIQUE (user_low, user_high));
-- conversation_pair serves user_low. The names trigger's user_high lookups and the ON DELETE SET NULL from
-- inventory_owner need this one.
CREATE INDEX IF NOT EXISTS conversation_user_high ON conversation(user_high);

CREATE TABLE IF NOT EXISTS conversation_member (
  conversation_id uuid NOT NULL REFERENCES conversation ON DELETE CASCADE,
  member_id text NOT NULL REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
  read_at timestamptz, archived_at timestamptz, PRIMARY KEY (conversation_id, member_id));
CREATE INDEX IF NOT EXISTS conversation_member_member ON conversation_member(member_id);

CREATE TABLE IF NOT EXISTS message (
  id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversation ON DELETE CASCADE,
  from_low boolean NOT NULL, client_key uuid NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL,
  CONSTRAINT message_once UNIQUE (conversation_id, from_low, client_key));
CREATE INDEX IF NOT EXISTS message_timeline ON message(conversation_id, created_at DESC, id DESC);

-- A Trade belongs to its pair's conversation when the pair has one. Closed Trades of a pair that never opened one keep
-- NULL and stay readable at /trades/<id> and through the inbox.
ALTER TABLE trade ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversation(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS trade_conversation ON trade(conversation_id, created_at DESC);

-- Completed Trades per collector (both sides confirmed the swap), one index for each side of the Trade.
CREATE INDEX IF NOT EXISTS trade_completed_proposer ON trade(proposer_id)
  WHERE proposer_swap_at IS NOT NULL AND recipient_swap_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS trade_completed_recipient ON trade(recipient_id)
  WHERE proposer_swap_at IS NOT NULL AND recipient_swap_at IS NOT NULL;

-- The one definition of "the pair's conversation", shared by the Trade trigger and the API's open_conversation: finds
-- or creates the row and both member rows, and returns its id. An existing conversation keeps its names, because the
-- names trigger keeps them current.
CREATE OR REPLACE FUNCTION pair_conversation(a text, b text, a_name text, b_name text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  a_low boolean := (a COLLATE "C") < (b COLLATE "C");
  pair_id uuid;
BEGIN
  INSERT INTO conversation (id, user_low, user_high, low_name, high_name)
    VALUES (gen_random_uuid(), CASE WHEN a_low THEN a ELSE b END, CASE WHEN a_low THEN b ELSE a END,
            CASE WHEN a_low THEN a_name ELSE b_name END, CASE WHEN a_low THEN b_name ELSE a_name END)
    ON CONFLICT ON CONSTRAINT conversation_pair DO NOTHING;
  SELECT c.id INTO pair_id FROM conversation c
    WHERE c.user_low = CASE WHEN a_low THEN a ELSE b END AND c.user_high = CASE WHEN a_low THEN b ELSE a END;
  INSERT INTO conversation_member (conversation_id, member_id) VALUES (pair_id, a), (pair_id, b)
    ON CONFLICT DO NOTHING;
  RETURN pair_id;
END $$;

-- Backfill: a conversation for each pair with a Trade that is Friends now or has a Trade in proposed or accepted. Other
-- pairs' Trades keep NULL. Every statement is safe to run again; a run after deploy can also give a conversation to a
-- pair who became Friends since, and attach the Trades of a pair that opened one. That is the same rule the API's
-- open_conversation applies.
WITH pairs AS (
  SELECT least(proposer_id COLLATE "C", recipient_id COLLATE "C") AS low,
         greatest(proposer_id COLLATE "C", recipient_id COLLATE "C") AS high,
         min(created_at) AS first_at, max(created_at) AS last_at,
         bool_or(state IN ('proposed', 'accepted')) AS open
  FROM trade WHERE proposer_id IS NOT NULL AND recipient_id IS NOT NULL GROUP BY 1, 2),
friends AS (SELECT viewer_id AS low, friend_id AS high FROM friends_of(ARRAY(SELECT low FROM pairs)))
INSERT INTO conversation (id, user_low, user_high, low_name, high_name, created_at, last_activity_at, changed_at)
SELECT gen_random_uuid(), p.low, p.high, lp.display_name, hp.display_name, p.first_at, p.last_at, p.last_at
FROM pairs p JOIN collector_profile lp ON lp.user_id = p.low JOIN collector_profile hp ON hp.user_id = p.high
WHERE p.open OR EXISTS (SELECT 1 FROM friends f WHERE f.low = p.low AND f.high = p.high)
ON CONFLICT ON CONSTRAINT conversation_pair DO NOTHING;

INSERT INTO conversation_member (conversation_id, member_id)
SELECT c.id, u.member FROM conversation c CROSS JOIN LATERAL (VALUES (c.user_low), (c.user_high)) u(member)
WHERE u.member IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE trade t SET conversation_id = c.id FROM conversation c
WHERE t.conversation_id IS NULL
  AND c.user_low = least(t.proposer_id COLLATE "C", t.recipient_id COLLATE "C")
  AND c.user_high = greatest(t.proposer_id COLLATE "C", t.recipient_id COLLATE "C");

-- A new Trade joins its pair's conversation, so an older API build that does not know conversations still produces
-- consistent rows during a deploy. It finds or creates the conversation and the member rows and nothing more (see the
-- lock order above).
CREATE OR REPLACE FUNCTION trade_joins_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.conversation_id IS NULL AND NEW.proposer_id IS NOT NULL AND NEW.recipient_id IS NOT NULL THEN
    NEW.conversation_id := pair_conversation(NEW.proposer_id, NEW.recipient_id, NEW.proposer_name, NEW.recipient_name);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trade_joins_conversation ON trade;
CREATE TRIGGER trade_joins_conversation BEFORE INSERT ON trade
  FOR EACH ROW EXECUTE FUNCTION trade_joins_conversation();

-- Every Trade step moves revision, and a new Trade row is new activity: changed_at moves the pulse watermark (strictly
-- forward), and an insert also moves last_activity_at, which orders the list and brings an archived conversation back.
CREATE OR REPLACE FUNCTION trade_conversation_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.conversation_id IS NOT NULL THEN
    UPDATE conversation
      SET changed_at = greatest(changed_at + interval '1 microsecond', clock_timestamp()),
          last_activity_at = CASE WHEN TG_OP = 'INSERT' THEN greatest(last_activity_at, clock_timestamp())
                                  ELSE last_activity_at END
      WHERE id = NEW.conversation_id;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trade_conversation_activity ON trade;
CREATE TRIGGER trade_conversation_activity AFTER INSERT OR UPDATE OF revision ON trade
  FOR EACH ROW EXECUTE FUNCTION trade_conversation_activity();

-- A rename follows into the conversations, like trade_names_follow_profile (migration 141). A rename is not activity:
-- it never touches changed_at or last_activity_at. The name sorts after trade_names_follow_profile on purpose.
CREATE OR REPLACE FUNCTION trade_names_follow_profile_conversations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE conversation SET low_name = NEW.display_name
    WHERE user_low = NEW.user_id AND low_name <> NEW.display_name;
  UPDATE conversation SET high_name = NEW.display_name
    WHERE user_high = NEW.user_id AND high_name <> NEW.display_name;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trade_names_follow_profile_conversations ON collector_profile;
CREATE TRIGGER trade_names_follow_profile_conversations AFTER UPDATE OF display_name ON collector_profile
  FOR EACH ROW WHEN (OLD.display_name IS DISTINCT FROM NEW.display_name)
  EXECUTE FUNCTION trade_names_follow_profile_conversations();
