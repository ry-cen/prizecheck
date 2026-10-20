-- Trade Wants, Will accept and Open to cash offers (Trading #268, spec "Schema changes"). Trading migrations use the
-- reserved block 140-179 (docs/planning/trading/migrations.md). Re-runnable, and it only adds objects. Nothing reads or
-- writes them yet: the Trade Wants and Will accept routes and the setting's route come in later tickets.

-- Trade Wants: copies of an exact Card Edition the collector wants to receive beyond what their Decks need. A line adds
-- to the Want List's need for the same Edition. At most 500 lines per owner (checked by the route, 422 TOO_MANY_LINES).
CREATE TABLE IF NOT EXISTS trade_want (
  owner_id text NOT NULL REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
  edition_id uuid NOT NULL REFERENCES catalog_edition(id),
  quantity bigint NOT NULL CHECK (quantity BETWEEN 1 AND 9999),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, edition_id)
);

-- Will accept: one choice per owner and Card Edition, wherever the card appears on the Want List. 'printing' accepts
-- any finish of the card's Printing, 'identity' any card with the same Card Identity. A missing row means this exact
-- Edition, the default. Rows outlive the card leaving the Want List and apply again if it returns.
CREATE TABLE IF NOT EXISTS trade_accept (
  owner_id text NOT NULL REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
  edition_id uuid NOT NULL REFERENCES catalog_edition(id),
  rule text NOT NULL CHECK (rule IN ('printing', 'identity')),
  PRIMARY KEY (owner_id, edition_id)
);

-- Open to cash offers: whether a Friend may send this collector a proposal where one side gives only cash. Off until
-- the collector turns it on. It sits in the social profile row, which goes with the account.
ALTER TABLE collector_profile ADD COLUMN IF NOT EXISTS open_to_cash_offers boolean NOT NULL DEFAULT false;
