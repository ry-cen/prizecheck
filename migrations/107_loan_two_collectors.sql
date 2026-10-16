-- A Loan outlives both of its collectors' accounts (social network #252). Deleting an account sets that side's id on
-- its Loans to NULL, and migration 105 first checked the two ids with IS DISTINCT FROM, which refuses NULL and NULL, so
-- the second side's account deletion failed. Databases that applied that 105 get the check every database now has:
-- the ids differ while both are set. Social network migrations use the reserved block 100-139
-- (docs/planning/social-network/migrations.md). Re-runnable: it changes nothing where the check already reads so.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'loan'::regclass AND conname = 'loan_two_collectors'
               AND pg_get_constraintdef(oid) LIKE '%IS DISTINCT FROM%') THEN
    ALTER TABLE loan DROP CONSTRAINT loan_two_collectors;
    ALTER TABLE loan ADD CONSTRAINT loan_two_collectors CHECK (lender_id <> borrower_id);
  END IF;
END $$;
