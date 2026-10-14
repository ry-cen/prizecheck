-- Target Format (app redesign #178, ADR 0011). Every Deck List has one Target Format: the one Format its advisory check
-- runs against and whose `legal` result publishing needs. Existing Deck Lists become Standard through the column default,
-- and so does every Deck List the location trigger (migration 029) creates from now on.
--
-- A constant default makes this a catalog-only change: no row is rewritten and no Deck List revision moves. Saved format
-- results (migration 034) stay keyed as they were; the next read recomputes them anyway, because the code that evaluates
-- changed with this release (deck_format_checks.CODE_SHA256).
--
-- Published Deck snapshots live in the public projection, not here. A snapshot published before this release has no
-- `target_format` and reads as Standard (publications.PublicSnapshot), so nothing public is rewritten.
--
-- An older release ignores the column. Safe to run again: the column and its check are added only if missing.

ALTER TABLE deck_list ADD COLUMN IF NOT EXISTS target_format text NOT NULL DEFAULT 'standard';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'deck_list'::regclass AND conname = 'deck_list_target_format_check') THEN
    ALTER TABLE deck_list ADD CONSTRAINT deck_list_target_format_check
      CHECK (target_format IN ('standard', 'expanded', 'glc'));
  END IF;
END $$;
