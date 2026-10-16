-- What open Loans promise, and the invariant that keeps a lender owning at least that (social network #252, spec
-- "Lender-side data: Loan lines and picks"). Social network migrations use the reserved block 100-139
-- (docs/planning/social-network/migrations.md). Re-runnable.

-- The copies each lender has promised and not yet handed over, per Card Edition: the lines of sent Lend Offers and
-- accepted Loans the lender hasn't confirmed a handover for. The one definition of "reserved": the inventory reads
-- (social.counts.reserved_counts and reserved_by_owner) and the invariant below agree with it. NULL editions: every
-- Edition. Batched over lenders, like friends_of and hidden_locations.
CREATE OR REPLACE FUNCTION reserved_copies(owners text[], editions uuid[])
RETURNS TABLE(owner_id text, edition_id uuid, reserved bigint) LANGUAGE sql STABLE AS $$
  SELECT o.lender_id, l.edition_id, sum(l.promised)::bigint
  FROM loan o JOIN loan_line l ON l.loan_id = o.id
  WHERE o.lender_id = ANY(owners) AND o.state IN ('offered', 'accepted') AND o.lender_handover_at IS NULL
    AND l.promised > 0 AND (editions IS NULL OR l.edition_id = ANY(editions))
  GROUP BY o.lender_id, l.edition_id
$$;

-- The invariant, per lender and Card Edition: the copies reserved never exceed the copies the lender holds, wherever
-- they are (Location doesn't matter, because lent copies sit in none). Picks are left out on purpose: they may go out
-- of date. Writers check first and refuse with PROMISED_TO_LOAN; this is the backstop, checked at commit.
-- It needs no lock of its own: every writer that lowers a lender's Holdings (Moves, Removal, Undo, reassignment, Deck
-- deletion, leaf conversion, the lender's handover) and every step that raises what the lender has reserved (accept,
-- the lender's take-back) holds the lender's inventory_owner row lock, FOR UPDATE or FOR NO KEY UPDATE, which conflict,
-- from before its first read until its commit. Two such writers for one lender therefore commit one after the other,
-- and the check at the second commit reads the first's committed rows.
CREATE OR REPLACE FUNCTION check_loan_promises(owner text, edition uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  promised bigint;
  held bigint;
BEGIN
  IF owner IS NULL OR edition IS NULL THEN
    RETURN;
  END IF;
  SELECT coalesce(sum(r.reserved), 0) INTO promised FROM reserved_copies(ARRAY[owner], ARRAY[edition]) r;
  IF promised = 0 THEN
    RETURN;
  END IF;
  SELECT coalesce(sum(h.quantity), 0) INTO held FROM holding h WHERE h.owner_id = owner AND h.edition_id = edition;
  IF promised > held THEN
    RAISE EXCEPTION 'Open Loans promise % copies of a Card Edition its lender holds % of', promised, held
      USING ERRCODE = '23514', CONSTRAINT = 'loan_promises_owned';
  END IF;
END $$;

-- A Holding that loses copies (deleted, lowered, or turned into another Edition) checks its old Edition.
CREATE OR REPLACE FUNCTION holding_promise_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM check_loan_promises(OLD.owner_id, OLD.edition_id);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS holding_promise_guard_delete ON holding;
CREATE CONSTRAINT TRIGGER holding_promise_guard_delete AFTER DELETE ON holding DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION holding_promise_guard();
DROP TRIGGER IF EXISTS holding_promise_guard_update ON holding;
CREATE CONSTRAINT TRIGGER holding_promise_guard_update AFTER UPDATE ON holding DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.quantity < OLD.quantity OR NEW.edition_id IS DISTINCT FROM OLD.edition_id
                     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id)
  EXECUTE FUNCTION holding_promise_guard();

-- A Loan that starts reserving (accepted, an offer sent, or a lender's handover taken back) checks its lines.
CREATE OR REPLACE FUNCTION loan_promise_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line record;
BEGIN
  IF NEW.state IN ('offered', 'accepted') AND NEW.lender_handover_at IS NULL THEN
    FOR line IN SELECT l.edition_id FROM loan_line l WHERE l.loan_id = NEW.id AND l.promised > 0 LOOP
      PERFORM check_loan_promises(NEW.lender_id, line.edition_id);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS loan_promise_guard_trigger ON loan;
CREATE CONSTRAINT TRIGGER loan_promise_guard_trigger AFTER INSERT OR UPDATE OF state, lender_handover_at, lender_id
  ON loan DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION loan_promise_guard();

-- A line whose promise rises checks its Edition.
CREATE OR REPLACE FUNCTION loan_line_promise_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM check_loan_promises((SELECT o.lender_id FROM loan o WHERE o.id = NEW.loan_id), NEW.edition_id);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS loan_line_promise_guard_trigger ON loan_line;
CREATE CONSTRAINT TRIGGER loan_line_promise_guard_trigger AFTER INSERT OR UPDATE OF promised, edition_id
  ON loan_line DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION loan_line_promise_guard();
