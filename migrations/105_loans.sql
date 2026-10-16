-- Loans: Borrow Requests, Lend Offers and the Loans they become (social network #252, spec "Loans, requests and the
-- state model" and "Lender-side data: Loan lines and picks"). Social network migrations use the reserved block 100-139
-- (docs/planning/social-network/migrations.md). Re-runnable.

-- One row per Borrow Request or Lend Offer and the Loan it becomes.
--   kind: 'borrow_request' (the borrower asked) or 'lend_offer' (the lender offered, #258).
--   state: 'requested' or 'offered' until the other side answers; 'accepted' once the lender has promised copies;
--     'handed_over' once both sides have confirmed the handover (#253); 'closed' at the end, with closed_reason.
--   lender_handover_at, borrower_handover_at: each side's own handover confirmation (#253). Neither is a state.
--   lender_name, borrower_name: each side's Display Name, kept so a Loan still reads after an account is deleted. A
--     Display Name change refreshes them (collector_profile_loan_names below).
--   deck_id: the borrower's Deck the cards go to, or NULL for Unsorted. Deleting the Deck clears only this column.
--   closed_by: who declined, withdrew or cancelled, so the other side reads "<name> cancelled this Loan".
--   revision: advanced by every step; a step names the revision it read, so a stale screen can't act on a changed Loan.
CREATE TABLE IF NOT EXISTS loan (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('borrow_request', 'lend_offer')),
  state text NOT NULL CHECK (state IN ('requested', 'offered', 'accepted', 'handed_over', 'closed')),
  closed_reason text CHECK (closed_reason IN ('declined', 'withdrawn', 'cancelled', 'returned', 'written_off')),
  lender_id text REFERENCES inventory_owner(user_id) ON DELETE SET NULL,
  borrower_id text REFERENCES inventory_owner(user_id) ON DELETE SET NULL,
  lender_name text NOT NULL CHECK (char_length(lender_name) BETWEEN 1 AND 40),
  borrower_name text NOT NULL CHECK (char_length(borrower_name) BETWEEN 1 AND 40),
  deck_id uuid,
  return_by date,
  lender_handover_at timestamptz,
  borrower_handover_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  closed_at timestamptz,
  closed_by text,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  -- Two different collectors; either id goes NULL when that account is deleted, and both may (migration 107).
  CONSTRAINT loan_two_collectors CHECK (lender_id <> borrower_id),
  CONSTRAINT loan_closed_has_reason CHECK ((state = 'closed') = (closed_reason IS NOT NULL)),
  CONSTRAINT loan_borrower_deck FOREIGN KEY (borrower_id, deck_id) REFERENCES location(owner_id, id)
    ON DELETE SET NULL (deck_id)
);
CREATE INDEX IF NOT EXISTS loan_lender ON loan(lender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS loan_borrower ON loan(borrower_id, created_at DESC);
-- The Loans whose promised copies are still reserved: the reserved counts and the invariant (migration 106) read these.
CREATE INDEX IF NOT EXISTS loan_reserving ON loan(lender_id)
  WHERE state IN ('offered', 'accepted') AND lender_handover_at IS NULL;

-- One line per Card Edition: what the borrower asked for, what the lender promised (0 until accepted, and 0 for a
-- line the lender left out), and how many promised copies were written off (#257). position keeps the order the
-- lines were asked in.
CREATE TABLE IF NOT EXISTS loan_line (
  loan_id uuid NOT NULL REFERENCES loan(id) ON DELETE CASCADE,
  edition_id uuid NOT NULL REFERENCES catalog_edition(id),
  position integer NOT NULL CHECK (position >= 0),
  requested bigint NOT NULL CHECK (requested >= 0),
  promised bigint NOT NULL DEFAULT 0 CHECK (promised >= 0),
  written_off bigint NOT NULL DEFAULT 0 CHECK (written_off >= 0 AND written_off <= promised),
  PRIMARY KEY (loan_id, edition_id)
);
CREATE INDEX IF NOT EXISTS loan_line_edition ON loan_line(edition_id);

-- The Loan Pick List: where the lender takes each promised copy from. owner_id is the lender. A pick's source is a
-- Location of the lender's, cleared when that Location is deleted (its copies then return to Unsorted); Deck deletion
-- and leaf conversion move picks with the copies they move. state: 'reserved' until the lender confirms the handover,
-- then 'lent' (#253), when the copies have left the source and the pick remembers where they go back to.
CREATE TABLE IF NOT EXISTS loan_pick (
  id bigserial PRIMARY KEY,
  loan_id uuid NOT NULL,
  owner_id text NOT NULL REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
  edition_id uuid NOT NULL,
  source_location_id uuid,
  quantity bigint NOT NULL CHECK (quantity > 0),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'lent')),
  FOREIGN KEY (loan_id, edition_id) REFERENCES loan_line(loan_id, edition_id) ON DELETE CASCADE,
  CONSTRAINT loan_pick_source FOREIGN KEY (owner_id, source_location_id) REFERENCES location(owner_id, id)
    ON DELETE SET NULL (source_location_id)
);
CREATE INDEX IF NOT EXISTS loan_pick_loan ON loan_pick(loan_id, edition_id);
CREATE INDEX IF NOT EXISTS loan_pick_source_index ON loan_pick(owner_id, source_location_id);

-- A Display Name change reaches the names kept on the collector's Loans, so both sides read the name as it is now.
CREATE OR REPLACE FUNCTION loan_names_follow_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE loan SET lender_name = NEW.display_name WHERE lender_id = NEW.user_id AND lender_name <> NEW.display_name;
  UPDATE loan SET borrower_name = NEW.display_name WHERE borrower_id = NEW.user_id AND borrower_name <> NEW.display_name;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS collector_profile_loan_names ON collector_profile;
CREATE TRIGGER collector_profile_loan_names AFTER UPDATE OF display_name ON collector_profile
  FOR EACH ROW WHEN (OLD.display_name IS DISTINCT FROM NEW.display_name)
  EXECUTE FUNCTION loan_names_follow_profile();

-- Loan commands that reach the other collector (send, accept, decline, withdraw, cancel) are limited per account like
-- Friend commands are, counted in handle_lookup_event under kind 'loan_command' (social.loans). Widens the kind check,
-- by whatever name it has, only when it doesn't allow the kind yet.
DO $$
DECLARE
  existing record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'handle_lookup_event'::regclass AND contype = 'c'
               AND pg_get_constraintdef(oid) LIKE '%loan_command%') THEN
    RETURN;
  END IF;
  FOR existing IN SELECT conname FROM pg_constraint
      WHERE conrelid = 'handle_lookup_event'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%' LOOP
    EXECUTE format('ALTER TABLE handle_lookup_event DROP CONSTRAINT %I', existing.conname);
  END LOOP;
  ALTER TABLE handle_lookup_event ADD CONSTRAINT handle_lookup_event_kind_check
    CHECK (kind IN ('lookup', 'handle_change', 'friend_command', 'loan_command'));
END $$;
