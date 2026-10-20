-- What open Trades promise, joined to what open Loans promise in the one definition of "reserved", and the one listable
-- rule (Trading #268, spec "The shared promise invariant", ADR 0015). Trading migrations use the reserved block 140-179
-- (docs/planning/trading/migrations.md). Re-runnable. With no trade rows every function below answers exactly what
-- migration 106's did, so every figure stays the same.
--
-- Merge order: this file redefines reserved_copies and check_loan_promises from 106_loan_promises.sql, so it is not
-- purely additive. Whoever merges second checks any branch that redefines either: the last definition applied must be
-- the union of the Loan part and the Trade part (docs/planning/trading/migrations.md, "Migration 142 redefines two
-- functions from migration 106").

-- The copies each collector's open Trades promise and that collector hasn't swapped yet, per Card Edition: the
-- proposer's lines while the row is proposed or accepted and the proposer hasn't confirmed the swap, and the recipient's
-- lines once it is accepted, until the recipient confirms. NULL editions: every Edition.
CREATE OR REPLACE FUNCTION trade_reserved_copies(owners text[], editions uuid[])
RETURNS TABLE(owner_id text, edition_id uuid, reserved bigint) LANGUAGE sql STABLE AS $$
  SELECT x.owner_id, x.edition_id, sum(x.quantity)::bigint FROM (
    SELECT t.proposer_id AS owner_id, l.edition_id, l.quantity FROM trade t JOIN trade_line l ON l.trade_id = t.id
      WHERE l.side = 'proposer' AND t.proposer_id = ANY(owners)
        AND t.state IN ('proposed', 'accepted') AND t.proposer_swap_at IS NULL
    UNION ALL
    SELECT t.recipient_id, l.edition_id, l.quantity FROM trade t JOIN trade_line l ON l.trade_id = t.id
      WHERE l.side = 'recipient' AND t.recipient_id = ANY(owners)
        AND t.state = 'accepted' AND t.recipient_swap_at IS NULL
  ) x WHERE editions IS NULL OR x.edition_id = ANY(editions)
  GROUP BY x.owner_id, x.edition_id
$$;

-- Still the one definition of "reserved" (migration 106): migration 106's Loan statement, unchanged, plus the Trade
-- part, summed per owner and Edition. Same signature, so social.counts.reserved_counts, reserved_by_owner, the invariant
-- below and every Python caller cover Trades with no change.
CREATE OR REPLACE FUNCTION reserved_copies(owners text[], editions uuid[])
RETURNS TABLE(owner_id text, edition_id uuid, reserved bigint) LANGUAGE sql STABLE AS $$
  SELECT x.owner_id, x.edition_id, sum(x.reserved)::bigint FROM (
    SELECT o.lender_id AS owner_id, l.edition_id, sum(l.promised)::bigint AS reserved
    FROM loan o JOIN loan_line l ON l.loan_id = o.id
    WHERE o.lender_id = ANY(owners) AND o.state IN ('offered', 'accepted') AND o.lender_handover_at IS NULL
      AND l.promised > 0 AND (editions IS NULL OR l.edition_id = ANY(editions))
    GROUP BY o.lender_id, l.edition_id
    UNION ALL
    SELECT t.owner_id, t.edition_id, t.reserved FROM trade_reserved_copies(owners, editions) t
  ) x
  GROUP BY x.owner_id, x.edition_id
$$;

-- The invariant, per collector and Card Edition: the copies open Loans and Trades reserve never exceed the copies held,
-- wherever they are. Same name, constraint name and SQLSTATE as migration 106's, so every caller and test that matches
-- them is unchanged; only the message names Trades too. Writers check first and refuse with PROMISED_TO_LOAN or
-- PROMISED_TO_TRADE (moves.check_promises); this is the backstop, checked at commit. A Trade step that raises what a
-- collector reserves takes that collector's inventory_owner lock first (social.owners.lock_owners), as Loan steps do.
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
    RAISE EXCEPTION 'Open Loans and Trades promise % copies of a Card Edition its owner holds % of', promised, held
      USING ERRCODE = '23514', CONSTRAINT = 'loan_promises_owned';
  END IF;
END $$;

-- Where reserved copies sit: every reserving Loan pick and Trade pick of the owners, with two sort keys that keep
-- today's Loan pick order exactly (loan_picks.pick_shortfalls sorted o.accepted_at NULLS LAST, o.created_at, o.id,
-- p.id). A Loan sorts by (accepted_at, created_at); a Trade's proposer side by (accepted_at, created_at); its recipient
-- side by (accepted_at, accepted_at). Unaccepted rows sort last, so an offered Lend Offer still sorts after every
-- accepted Loan. Python reads it for one owner only, through social.counts.reserving_pick_rows and reserved_picks.
CREATE OR REPLACE FUNCTION reserving_picks(owners text[], editions uuid[])
RETURNS TABLE(kind text, loan_id uuid, trade_id uuid, pick_id bigint, owner_id text, edition_id uuid,
              source_location_id uuid, quantity bigint, sort_accepted_at timestamptz, sort_created_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT 'loan'::text, p.loan_id, NULL::uuid, p.id, p.owner_id, p.edition_id, p.source_location_id, p.quantity::bigint,
         o.accepted_at, o.created_at
    FROM loan_pick p JOIN loan o ON o.id = p.loan_id
    WHERE p.owner_id = ANY(owners) AND o.lender_id = p.owner_id AND p.state = 'reserved'
      AND o.state IN ('offered', 'accepted') AND o.lender_handover_at IS NULL
      AND (editions IS NULL OR p.edition_id = ANY(editions))
  UNION ALL
  SELECT 'trade'::text, NULL::uuid, p.trade_id, p.id, p.owner_id, p.edition_id, p.source_location_id, p.quantity,
         t.accepted_at, CASE WHEN p.side = 'proposer' THEN t.created_at ELSE t.accepted_at END
    FROM trade_pick p JOIN trade t ON t.id = p.trade_id
    WHERE p.owner_id = ANY(owners) AND (editions IS NULL OR p.edition_id = ANY(editions))
      AND ((p.side = 'proposer' AND t.proposer_id = p.owner_id
            AND t.state IN ('proposed', 'accepted') AND t.proposer_swap_at IS NULL)
        OR (p.side = 'recipient' AND t.recipient_id = p.owner_id
            AND t.state = 'accepted' AND t.recipient_swap_at IS NULL))
$$;

-- How many copies each owner lists for trade, per Card Edition: the one listable rule, called by the collector's own
-- Trade List (trade_list.py) and the Friend read (social/friend_copies.py), and by nothing else. ft_held is the copies
-- held in For trade Locations (for_trade_locations, migration 140: never a Deck); ft_picked is, per For trade Location,
-- the reserving picks there up to the copies held there; listable is ft_held - ft_picked, bounded by every copy held
-- less every copy reserved, never below 0. So reserved copies picked from a Deck don't shrink the Trade List, and an out
-- of date pick never over-lists. Lent copies are not in holding and Borrowed Copies are in borrowed_holding, which is
-- never read. Hidden doesn't matter here. Only Editions with listable > 0 are returned.
CREATE OR REPLACE FUNCTION trade_listable(owners text[], editions uuid[])
RETURNS TABLE(owner_id text, edition_id uuid, listable bigint) LANGUAGE sql STABLE AS $$
  WITH ft AS (SELECT DISTINCT f.owner_id, f.location_id FROM for_trade_locations(owners) f),
  picked AS (
    SELECT p.owner_id, p.edition_id, p.source_location_id AS location_id, sum(p.quantity)::bigint AS quantity
    FROM reserving_picks(owners, editions) p WHERE p.source_location_id IS NOT NULL GROUP BY 1, 2, 3),
  per AS (
    SELECT h.owner_id, h.edition_id, sum(h.quantity)::bigint AS total_held,
      coalesce(sum(h.quantity) FILTER (WHERE ft.location_id IS NOT NULL), 0)::bigint AS ft_held,
      coalesce(sum(least(coalesce(pk.quantity, 0), h.quantity)) FILTER (WHERE ft.location_id IS NOT NULL), 0)::bigint
        AS ft_picked
    FROM holding h
    LEFT JOIN ft ON ft.owner_id = h.owner_id AND ft.location_id = h.location_id
    LEFT JOIN picked pk ON pk.owner_id = h.owner_id AND pk.edition_id = h.edition_id AND pk.location_id = h.location_id
    WHERE h.owner_id = ANY(owners) AND (editions IS NULL OR h.edition_id = ANY(editions))
    GROUP BY h.owner_id, h.edition_id),
  listed AS (
    SELECT per.owner_id, per.edition_id,
      greatest(0, least(per.ft_held - per.ft_picked, per.total_held - coalesce(r.reserved, 0)))::bigint AS listable
    FROM per LEFT JOIN reserved_copies(owners, editions) r
      ON r.owner_id = per.owner_id AND r.edition_id = per.edition_id)
  SELECT listed.owner_id, listed.edition_id, listed.listable FROM listed WHERE listed.listable > 0
$$;

-- A Trade side that starts reserving checks its lines: the proposer's when a row is inserted (a send or a Counter),
-- the recipient's when it becomes accepted, and either side again when a direct write clears its swap time (which
-- re-reserves copies) or changes its owner. Closing a row or confirming a swap leaves that side not reserving and checks
-- nothing. Mirrors loan_promise_guard (migration 106).
CREATE OR REPLACE FUNCTION trade_promise_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line record;
  proposer_rises boolean := false;
  recipient_rises boolean := false;
BEGIN
  IF NEW.state IN ('proposed', 'accepted') AND NEW.proposer_swap_at IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      proposer_rises := true;
    ELSIF NOT (OLD.state IN ('proposed', 'accepted') AND OLD.proposer_swap_at IS NULL)
          OR NEW.proposer_id IS DISTINCT FROM OLD.proposer_id THEN
      proposer_rises := true;
    END IF;
  END IF;
  IF NEW.state = 'accepted' AND NEW.recipient_swap_at IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      recipient_rises := true;
    ELSIF NOT (OLD.state = 'accepted' AND OLD.recipient_swap_at IS NULL)
          OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id THEN
      recipient_rises := true;
    END IF;
  END IF;
  IF proposer_rises THEN
    FOR line IN SELECT l.edition_id FROM trade_line l WHERE l.trade_id = NEW.id AND l.side = 'proposer' LOOP
      PERFORM check_loan_promises(NEW.proposer_id, line.edition_id);
    END LOOP;
  END IF;
  IF recipient_rises THEN
    FOR line IN SELECT l.edition_id FROM trade_line l WHERE l.trade_id = NEW.id AND l.side = 'recipient' LOOP
      PERFORM check_loan_promises(NEW.recipient_id, line.edition_id);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trade_promise_guard ON trade;
CREATE CONSTRAINT TRIGGER trade_promise_guard
  AFTER INSERT OR UPDATE OF state, proposer_swap_at, recipient_swap_at, proposer_id, recipient_id
  ON trade DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trade_promise_guard();

-- A line inserted or changed while its side reserves checks its Edition, for that side's collector.
CREATE OR REPLACE FUNCTION trade_line_promise_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  giver text;
BEGIN
  SELECT CASE NEW.side WHEN 'proposer' THEN t.proposer_id ELSE t.recipient_id END INTO giver
  FROM trade t
  WHERE t.id = NEW.trade_id
    AND ((NEW.side = 'proposer' AND t.state IN ('proposed', 'accepted') AND t.proposer_swap_at IS NULL)
      OR (NEW.side = 'recipient' AND t.state = 'accepted' AND t.recipient_swap_at IS NULL));
  PERFORM check_loan_promises(giver, NEW.edition_id);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trade_line_promise_guard ON trade_line;
CREATE CONSTRAINT TRIGGER trade_line_promise_guard AFTER INSERT OR UPDATE OF quantity, edition_id, side
  ON trade_line DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trade_line_promise_guard();
