-- The Want List counting setting (decklist import #207, spec "Settings"). It is stored on the account, on the owner row,
-- so phone and desktop agree:
--   want_list_counting: 'all_at_once' (Every Deck built at once, the default) or 'one_at_a_time' (One Deck at a time);
--   settings_revision: advanced by every settings command, which names the revision it read (api/app/settings.py).
-- Every existing account, and every account created from now on, counts Every Deck built at once through the column
-- default. Settings commands never touch inventory_owner.revision, the inventory revision, so the inventory Undo cleanup
-- trigger (migration 012, AFTER UPDATE OF revision) never fires for them.
--
-- Constant defaults make this a catalog-only change: no row is rewritten and no revision moves. Expand-only: an older
-- release ignores both columns. Safe to run again: the columns and the check are added only if missing.

ALTER TABLE inventory_owner
  ADD COLUMN IF NOT EXISTS want_list_counting text NOT NULL DEFAULT 'all_at_once',
  ADD COLUMN IF NOT EXISTS settings_revision bigint NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'inventory_owner'::regclass AND conname = 'inventory_owner_want_list_counting_check') THEN
    ALTER TABLE inventory_owner ADD CONSTRAINT inventory_owner_want_list_counting_check
      CHECK (want_list_counting IN ('all_at_once', 'one_at_a_time'));
  END IF;
END $$;
