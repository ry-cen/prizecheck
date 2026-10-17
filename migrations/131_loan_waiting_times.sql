-- When a Loan began to wait on a collector, for the inbox's "Waiting on you" lines (social network #259, owner's
-- decision 2026-10-16). Social network migrations use the reserved block 100-139
-- (docs/planning/social-network/migrations.md). Re-runnable.
--
-- Most waiting steps have a stored time already (the Loan's created_at and handover times, a return's created_at); two
-- have a fallback, since nothing records when out-of-date picks began or when the other side's account went. Two had
-- no time at all:
--   written_off_at: when the newest Write-off was made, set by the Write-off step; the borrower's keep-or-remove
--     choice waits from then.
--   extension_asked_at: when the borrower asked for more time, set by that step; read only while extension_to is set.
-- Rows from before this migration have neither, and the inbox falls back to the Loan's accepted_at.
ALTER TABLE loan ADD COLUMN IF NOT EXISTS written_off_at timestamptz;
ALTER TABLE loan ADD COLUMN IF NOT EXISTS extension_asked_at timestamptz;
