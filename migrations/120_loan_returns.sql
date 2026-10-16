-- Returns (social network #255, spec "Loans, requests and the state model"). Social network migrations use the
-- reserved block 100-139 (docs/planning/social-network/migrations.md). Re-runnable.
--
-- A return carries some of a Loan's copies back. The side that starts it confirms it then, the other side confirms it
-- later, and each confirmation moves only that side's own inventory. completed_at is set when both have confirmed, or
-- at once when the other side's account no longer exists; a Loan has at most one return not yet complete. The lender's
-- copies go back to their picks' source Locations (Unsorted when a source is gone), so a line names no destination.
CREATE TABLE IF NOT EXISTS loan_return (
  id uuid PRIMARY KEY,
  loan_id uuid NOT NULL REFERENCES loan(id) ON DELETE CASCADE,
  started_by text NOT NULL CHECK (started_by IN ('lender', 'borrower')),
  lender_confirmed_at timestamptz,
  borrower_confirmed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loan_return_starter_confirmed CHECK (
    (started_by = 'lender' AND lender_confirmed_at IS NOT NULL)
    OR (started_by = 'borrower' AND borrower_confirmed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS loan_return_pending ON loan_return(loan_id) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS loan_return_loan ON loan_return(loan_id, created_at);

CREATE TABLE IF NOT EXISTS loan_return_line (
  return_id uuid NOT NULL REFERENCES loan_return(id) ON DELETE CASCADE,
  loan_id uuid NOT NULL,
  edition_id uuid NOT NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (return_id, edition_id),
  FOREIGN KEY (loan_id, edition_id) REFERENCES loan_line(loan_id, edition_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS loan_return_line_loan ON loan_return_line(loan_id, edition_id);
