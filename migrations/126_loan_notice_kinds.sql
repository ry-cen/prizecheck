-- Two kinds of 14-day nudge (social network #256, spec "Return-by date and overdue", story 89). Social network
-- migrations use the reserved block 100-139 (docs/planning/social-network/migrations.md). Re-runnable.
--
-- Migration 125 recorded one kind, 'nudge', for both an unanswered Borrow Request or Lend Offer and an accepted Loan
-- nobody confirmed a handover for, so a side that saw the first never saw the second. They become 'nudge_answer' and
-- 'nudge_handover'. A 'nudge' row is classified by when it was seen: before the Loan was accepted (or on a Loan never
-- accepted) it was the answer nudge, else the handover nudge. The CHECK still accepts 'nudge', so an API build from
-- before this migration keeps working while it deploys; the API from this migration on never writes it.
DO $$
DECLARE
  found text;
BEGIN
  FOR found IN SELECT conname FROM pg_constraint
      WHERE conrelid = 'loan_notice_seen'::regclass AND contype = 'c' AND conname <> 'loan_notice_seen_kind' LOOP
    EXECUTE format('ALTER TABLE loan_notice_seen DROP CONSTRAINT %I', found);
  END LOOP;
END $$;

UPDATE loan_notice_seen s
SET kind = CASE WHEN o.accepted_at IS NULL OR s.seen_at < o.accepted_at THEN 'nudge_answer' ELSE 'nudge_handover' END
FROM loan o
WHERE o.id = s.loan_id AND s.kind = 'nudge';

ALTER TABLE loan_notice_seen DROP CONSTRAINT IF EXISTS loan_notice_seen_kind;
ALTER TABLE loan_notice_seen ADD CONSTRAINT loan_notice_seen_kind
  CHECK (kind IN ('overdue', 'nudge_answer', 'nudge_handover', 'nudge'));
