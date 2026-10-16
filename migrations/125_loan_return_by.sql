-- Return-by date and overdue (social network #256, spec "Return-by date and overdue" and "Inbox derivation"). Social
-- network migrations use the reserved block 100-139 (docs/planning/social-network/migrations.md). Re-runnable.
--
-- extension_to is the later date the borrower asked for and the lender hasn't answered. Overdue and the 14-day nudge
-- are worked out when a Loan is read, with no scheduler; loan_notice_seen records each notice a side was shown, so it
-- shows once per side.
ALTER TABLE loan ADD COLUMN IF NOT EXISTS extension_to date;

CREATE TABLE IF NOT EXISTS loan_notice_seen (
  loan_id uuid NOT NULL REFERENCES loan(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('overdue', 'nudge')),
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (loan_id, user_id, kind)
);
