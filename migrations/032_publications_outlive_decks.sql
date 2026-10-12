-- A Published Deck outlives its Deck (ADR 0009): deleting a Deck clears its publications' link to it, and an active
-- publication stays live, managed through owner routes keyed by its public token until the owner revokes it. The
-- foreign key clears the link itself, so every writer that deletes a Deck unlinks its publications in the same statement.
--
-- one_active_deck_publication (015) stays as it is. Its key is deck_id and unique-index NULLs are distinct, so it still
-- allows at most one active publication per existing Deck while any number of unlinked publications stay active.
--
-- Rollback: an older runtime never deletes a Deck, always writes deck_id, and finds publications only by
-- deck_id = <a Deck>, which never matches NULL. It reads and writes as before; it cannot reach an unlinked publication,
-- which stays live and unmanageable until the application is rolled forward (docs/public-projections.md).
ALTER TABLE deck_publication ALTER COLUMN deck_id DROP NOT NULL;

DO $$
DECLARE constraint_name text;
BEGIN
  SELECT c.conname INTO STRICT constraint_name FROM pg_constraint c
    WHERE c.conrelid = 'deck_publication'::regclass AND c.contype = 'f' AND c.confrelid = 'location'::regclass;
  EXECUTE format('ALTER TABLE deck_publication DROP CONSTRAINT %I', constraint_name);
END $$;

ALTER TABLE deck_publication ADD CONSTRAINT deck_publication_deck_id_fkey
  FOREIGN KEY (deck_id) REFERENCES location(id) ON DELETE SET NULL;

-- The SET NULL action finds a deleted Deck's publications, revoked ones included, through this index; the owner's list
-- of active publications reads the second.
CREATE INDEX deck_publication_deck ON deck_publication(deck_id);
CREATE INDEX deck_publication_owner_active ON deck_publication(owner_id, created_at, token) WHERE NOT revoked;
