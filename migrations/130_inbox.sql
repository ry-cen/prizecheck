-- The inbox (social network #259, spec "Inbox derivation"). Social network migrations use the reserved block 100-139
-- (docs/planning/social-network/migrations.md). Re-runnable.
--
-- What waits on a collector is worked out from Loan, return and Write-off state on every read, and nothing about it is
-- stored. Updates are: event updates a step stores here for the other side (a request or offer accepted, partly
-- accepted or declined, a Loan cancelled, the return-by date changed), and the time-based ones (overdue, the 14-day
-- nudge) worked out on read, whose read and dismissed state is loan_notice_seen's (migration 125).
--
-- inbox_update: other_name is the Display Name of the collector who took the step, as it was. A cancel records only
-- that the Loan was cancelled and by whom, never why. read_at is set when the inbox shows it, dismissed_at by Clear;
-- rows read more than 90 days ago are deleted lazily, when the recipient next marks updates read or clears them.
-- recipient_id has no foreign key on purpose: a step writes the other collector's update holding only its own owner
-- lock (or none), and a key check on the other collector's inventory_owner row would wait on their own inventory
-- commands, which hold it FOR UPDATE and cascade into this Loan's row (social/owners.py, "Keep this mode"). The Loan
-- row is the step's own lock, so the loan_id key check never waits.
CREATE TABLE IF NOT EXISTS inbox_update (
  id uuid PRIMARY KEY,
  recipient_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('accepted', 'partly_accepted', 'declined', 'cancelled', 'return_by_changed')),
  loan_id uuid NOT NULL REFERENCES loan(id) ON DELETE CASCADE,
  other_name text NOT NULL CHECK (char_length(other_name) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  dismissed_at timestamptz
);
CREATE INDEX IF NOT EXISTS inbox_update_recipient ON inbox_update(recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inbox_update_loan ON inbox_update(loan_id);

-- A time-based update the collector cleared from the inbox: it doesn't show there again. A row without it is one the
-- collector was shown (read), on the Loan's screen or in the inbox.
ALTER TABLE loan_notice_seen ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;
