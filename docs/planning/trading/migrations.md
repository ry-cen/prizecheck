# Trading migration numbers

Migrations apply in file-name order (`scripts/migrate.py`), each once, recorded by name in `schema_migration`. Release and deploy checks compare sets of names only: a candidate's migrations must all be applied, and an existing migration may never change or disappear (`scripts/release.py` `compatible`, `scripts/release_runtime.py`, `deploy/unraid/prizecheck-deploy.sh`). Nothing refuses a gap or a file that sorts before one already applied.

So Trading takes its own block, **140 to 179**, after the social network's block (**100 to 139**, see the [social migrations note](../social-network/migrations.md), where 131 is the last used) and clear of `dev` and collection import. Each file's number is fixed now, so parallel branches never collide:

| File | Contents |
| --- | --- |
| `140_for_trade_locations.sql` | the `location.for_trade` column, its index, the constraint that a Deck cannot be marked (added in a DO block that skips an existing constraint), and `for_trade_locations` |
| `141_trades.sql` | `trade`, `trade_line`, `trade_pick`, the names trigger (after `DROP TRIGGER IF EXISTS`) and the `handle_lookup_event` kind `'trade_command'` (widened with migration 105's DO-block pattern, the CHECK rebuilt from the union of every known kind) |
| `142_trade_promises.sql` | `trade_reserved_copies`, the redefined `reserved_copies` and `check_loan_promises`, `reserving_picks`, `trade_listable` and the Trade guard triggers (after `DROP TRIGGER IF EXISTS`) |
| `143_trade_wants.sql` | `trade_want`, `trade_accept` and `collector_profile.open_to_cash_offers` |
| `144_trade_inbox.sql` | `inbox_update.trade_id`, the nullable `loan_id`, the one-subject constraint (added in a DO block) and the `'swapped'` kind (widened with migration 105's DO-block pattern, the CHECK rebuilt from the union of every known kind) |
| 145 to 179 | spare |

All of them are re-runnable: each `ADD CONSTRAINT` sits in a DO block that skips an existing constraint, each trigger is created after `DROP TRIGGER IF EXISTS`, functions use `CREATE OR REPLACE`, and tables and indexes use `IF NOT EXISTS`. Migrations 140, 141 and 143 only add objects. Migration 142 redefines two functions, and migration 144 makes `inbox_update.loan_id` nullable and widens a CHECK, so neither is purely additive. See [the plumbing resolution](wayfinder/resolutions/decide-trading-plumbing.md) for the contents and [ADR 0015](../../adr/0015-trades-share-the-promise-invariant-and-friend-reads.md) for why.

**Migration 142 redefines two functions from migration 106:** `reserved_copies` and `check_loan_promises`. The rule from the social migrations note applies: whoever merges second checks any function both sides redefine. The last definition applied wins, and the two orders must leave the same definition, which must be the union of the Loan part and the Trade part. Migration 142 sorts after every social migration, so a fresh database applies it after 106.

**Two kind CHECKs are widened, and the same rule applies to them.** Migration 141 widens `handle_lookup_event.kind` with `'trade_command'` (last widened in `105_loans.sql`), and migration 144 widens `inbox_update.kind` with `'swapped'` (created in `130_inbox.sql`). Each uses migration 105's DO-block pattern: skip when a CHECK already allows the new kind, otherwise drop every CHECK on the table that mentions `kind` and add one CHECK listing the union of every kind already allowed and the new one. Whoever merges second checks both CHECKs against every branch that widened them, and the last CHECK applied must allow the union, or a kind another branch writes would be refused.

A file in the 140 to 179 range sorts after 131, the last social migration used. A migration may be renumbered only before it reaches `dev`.
