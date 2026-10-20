-- Trade updates in the inbox (Trading #270, spec "Inbox"; docs/planning/trading/migrations.md). Trading migrations use
-- the reserved block 140-179. Re-runnable. Not purely additive: loan_id becomes nullable and the kind CHECK is widened.
--
-- A Trade step stores an update for the other side as a Loan step does (migration 130): the row names its Trade in
-- trade_id instead of a Loan, and exactly one of the two is set. An older API build reads event updates with an inner
-- join on loan, so it never sees a Trade row, and deploying in either order is safe.
--
-- Merge order: this file widens the inbox_update kind CHECK (created in 130_inbox.sql). Whoever merges second checks the
-- CHECK against every branch that widened it: the last CHECK applied must allow the union of every kind any branch
-- writes (docs/planning/trading/migrations.md, "Two kind CHECKs are widened").
ALTER TABLE inbox_update ALTER COLUMN loan_id DROP NOT NULL;
ALTER TABLE inbox_update ADD COLUMN IF NOT EXISTS trade_id uuid REFERENCES trade(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS inbox_update_trade ON inbox_update(trade_id);

-- Each update is about one Loan or one Trade, never both and never neither.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'inbox_update'::regclass AND conname = 'inbox_update_one_subject') THEN
    ALTER TABLE inbox_update ADD CONSTRAINT inbox_update_one_subject CHECK (num_nonnulls(loan_id, trade_id) = 1);
  END IF;
END $$;

-- 'swapped' goes to the side that confirmed a swap first, when the second confirms (Trading #272 writes it). Widens the
-- kind check, by whatever name it has, only when it doesn't allow the kind yet, with migration 105's pattern; the new
-- CHECK is the union of every kind known.
DO $$
DECLARE
  existing record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'inbox_update'::regclass AND contype = 'c'
               AND pg_get_constraintdef(oid) LIKE '%swapped%') THEN
    RETURN;
  END IF;
  FOR existing IN SELECT conname FROM pg_constraint
      WHERE conrelid = 'inbox_update'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%' LOOP
    EXECUTE format('ALTER TABLE inbox_update DROP CONSTRAINT %I', existing.conname);
  END LOOP;
  ALTER TABLE inbox_update ADD CONSTRAINT inbox_update_kind_check
    CHECK (kind IN ('accepted', 'partly_accepted', 'declined', 'cancelled', 'return_by_changed', 'swapped'));
END $$;
