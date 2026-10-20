-- Trade Proposals, the Trades they become, the cards each side gives and the Trade Pick List (Trading #268, spec
-- "Schema changes"). Trading migrations use the reserved block 140-179 (docs/planning/trading/migrations.md).
-- Re-runnable, and it only adds objects. No route writes these tables yet (the Trade steps are #269 onward).
--
-- Merge order: this file widens the handle_lookup_event kind CHECK (last widened by 105_loans.sql). Whoever merges
-- second checks the CHECK against every branch that widened it: the last CHECK applied must allow the union of every
-- kind any branch writes (docs/planning/trading/migrations.md, "Two kind CHECKs are widened").

-- One row per Trade Proposal (one round); the row that is accepted is the Trade, as loan holds Borrow Requests, Lend
-- Offers and the Loans they become (migration 105).
--   state: 'proposed' until the recipient answers; 'accepted' once they accept; 'closed' at the end, with closed_reason.
--   proposer_id, recipient_id: NULL once that account is deleted; the names are kept so a Trade still reads, and a
--     Display Name change refreshes them (trade_names_follow_profile below).
--   countered_from: the proposal this one answers (a Counter closes it as 'countered').
--   cash_cents, cash_payer: integer US cents recorded, paid by one side; the app never handles money. The cap is only a
--     sanity bound.
--   proposer_swap_at, recipient_swap_at: each side's own Confirm swap. Neither is a state.
--   revision: advanced by every step; a step names the revision it read.
CREATE TABLE IF NOT EXISTS trade (
  id uuid PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('proposed', 'accepted', 'closed')),
  closed_reason text CHECK (closed_reason IN ('declined', 'withdrawn', 'countered', 'cancelled', 'swapped')),
  proposer_id text REFERENCES inventory_owner(user_id) ON DELETE SET NULL,
  recipient_id text REFERENCES inventory_owner(user_id) ON DELETE SET NULL,
  proposer_name text NOT NULL CHECK (char_length(proposer_name) BETWEEN 1 AND 40),
  recipient_name text NOT NULL CHECK (char_length(recipient_name) BETWEEN 1 AND 40),
  countered_from uuid REFERENCES trade(id) ON DELETE SET NULL,
  cash_cents bigint NOT NULL DEFAULT 0 CHECK (cash_cents BETWEEN 0 AND 99999999),
  cash_payer text CHECK (cash_payer IN ('proposer', 'recipient')),
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  proposer_swap_at timestamptz,
  recipient_swap_at timestamptz,
  closed_at timestamptz,
  closed_by text,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  -- Two different collectors while both are set; either id goes NULL when that account is deleted (as migration 107
  -- settled for loan).
  CONSTRAINT trade_two_collectors CHECK (proposer_id <> recipient_id),
  CONSTRAINT trade_closed_has_reason CHECK ((state = 'closed') = (closed_reason IS NOT NULL)),
  CONSTRAINT trade_cash_has_payer CHECK ((cash_cents = 0) = (cash_payer IS NULL)),
  CONSTRAINT trade_swap_after_accept CHECK (state <> 'proposed' OR (proposer_swap_at IS NULL AND recipient_swap_at IS NULL))
);
CREATE INDEX IF NOT EXISTS trade_proposer ON trade(proposer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trade_recipient ON trade(recipient_id, created_at DESC);
-- The Trades whose sides still reserve copies: trade_reserved_copies and reserving_picks (migration 142) read these.
CREATE INDEX IF NOT EXISTS trade_reserving_proposer ON trade(proposer_id)
  WHERE state IN ('proposed', 'accepted') AND proposer_swap_at IS NULL;
CREATE INDEX IF NOT EXISTS trade_reserving_recipient ON trade(recipient_id)
  WHERE state = 'accepted' AND recipient_swap_at IS NULL;

-- The cards one side gives, one line per Card Edition. side is the giver. position keeps the order the lines were
-- listed in. The steps refuse one Edition on both sides (#269); the key allows it, so the rule stays in one place.
CREATE TABLE IF NOT EXISTS trade_line (
  trade_id uuid REFERENCES trade(id) ON DELETE CASCADE,
  side text CHECK (side IN ('proposer', 'recipient')),
  edition_id uuid REFERENCES catalog_edition(id),
  position integer NOT NULL CHECK (position >= 0),
  quantity bigint NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (trade_id, side, edition_id)
);

-- The Trade Pick List: where a side's giver takes each promised copy from. owner_id is that side's collector. Ids come
-- from loan_pick's sequence, so a pick id is unique across both pick tables and code keyed by pick id
-- (loan_picks.pick_shortfalls) needs no change. A pick's source is a Location of the owner's, cleared when that
-- Location is deleted (the pick is then out of date); Deck deletion and leaf conversion move picks with the copies they
-- move (social.counts.move_picks). Picks are made when a side's copies reserve and deleted at that side's Confirm swap
-- and at every close.
CREATE TABLE IF NOT EXISTS trade_pick (
  id bigint PRIMARY KEY DEFAULT nextval('loan_pick_id_seq'),
  trade_id uuid NOT NULL,
  side text NOT NULL,
  owner_id text NOT NULL REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
  edition_id uuid NOT NULL,
  source_location_id uuid,
  quantity bigint NOT NULL CHECK (quantity > 0),
  FOREIGN KEY (trade_id, side, edition_id) REFERENCES trade_line(trade_id, side, edition_id) ON DELETE CASCADE,
  CONSTRAINT trade_pick_source FOREIGN KEY (owner_id, source_location_id) REFERENCES location(owner_id, id)
    ON DELETE SET NULL (source_location_id)
);
CREATE INDEX IF NOT EXISTS trade_pick_trade ON trade_pick(trade_id, side);
CREATE INDEX IF NOT EXISTS trade_pick_source_index ON trade_pick(owner_id, source_location_id);

-- A Display Name change reaches the names kept on the collector's Trades, as loan_names_follow_profile (migration 105)
-- does for Loans.
CREATE OR REPLACE FUNCTION trade_names_follow_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE trade SET proposer_name = NEW.display_name
    WHERE proposer_id = NEW.user_id AND proposer_name <> NEW.display_name;
  UPDATE trade SET recipient_name = NEW.display_name
    WHERE recipient_id = NEW.user_id AND recipient_name <> NEW.display_name;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trade_names_follow_profile ON collector_profile;
CREATE TRIGGER trade_names_follow_profile AFTER UPDATE OF display_name ON collector_profile
  FOR EACH ROW WHEN (OLD.display_name IS DISTINCT FROM NEW.display_name)
  EXECUTE FUNCTION trade_names_follow_profile();

-- Trade commands that reach the other collector are limited per account like Loan commands are, counted in
-- handle_lookup_event under kind 'trade_command' (#269). Widens the kind check, by whatever name it has, only when it
-- doesn't allow the kind yet, with migration 105's pattern; the new CHECK is the union of every kind known.
DO $$
DECLARE
  existing record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'handle_lookup_event'::regclass AND contype = 'c'
               AND pg_get_constraintdef(oid) LIKE '%trade_command%') THEN
    RETURN;
  END IF;
  FOR existing IN SELECT conname FROM pg_constraint
      WHERE conrelid = 'handle_lookup_event'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%' LOOP
    EXECUTE format('ALTER TABLE handle_lookup_event DROP CONSTRAINT %I', existing.conname);
  END LOOP;
  ALTER TABLE handle_lookup_event ADD CONSTRAINT handle_lookup_event_kind_check
    CHECK (kind IN ('lookup', 'handle_change', 'friend_command', 'loan_command', 'trade_command'));
END $$;
