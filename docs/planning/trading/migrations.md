# Trading migration numbers

Migrations apply in file-name order (`scripts/migrate.py`), each once, recorded by name in `schema_migration`. Release and deploy checks compare sets of names only: a candidate's migrations must all be applied, and an existing migration may never change or disappear (`scripts/release.py` `compatible`, `scripts/release_runtime.py`, `deploy/unraid/prizecheck-deploy.sh`). Nothing refuses a gap or a file that sorts before one already applied.

So Trading takes its own block, **140 to 179**, after the social network's block (**100 to 139**, see the [social migrations note](../social-network/migrations.md), where 131 is the last used) and clear of `dev` and collection import. Each file's number is fixed now, so parallel branches never collide:

| File | Contents |
| --- | --- |
| `140_for_trade_locations.sql` | the `location.for_trade` column, its index, the constraint that a Deck cannot be marked, and `for_trade_locations` |
| `141_trades.sql` | `trade`, `trade_line`, `trade_pick`, the names trigger and the `handle_lookup_event` kind `'trade_command'` (widened with migration 105's DO-block pattern) |
| `142_trade_promises.sql` | `trade_reserved_copies`, the redefined `reserved_copies` and `check_loan_promises`, `reserving_picks` and the Trade guard triggers |
| `143_trade_wants.sql` | `trade_want`, `trade_accept` and `collector_profile.open_to_cash_offers` |
| `144_trade_inbox.sql` | `inbox_update.trade_id`, the nullable `loan_id`, the one-subject constraint and the `'swapped'` kind |
| 145 to 179 | spare |

All of them are additive and re-runnable. See [the plumbing resolution](wayfinder/resolutions/decide-trading-plumbing.md) for the contents and [ADR 0015](../../adr/0015-trades-share-the-promise-invariant-and-friend-reads.md) for why.

**Migration 142 redefines two functions from migration 106:** `reserved_copies` and `check_loan_promises`. The rule from the social migrations note applies: whoever merges second checks any function both sides redefine. The last definition applied wins, and the two orders must leave the same definition, which must be the union of the Loan part and the Trade part. Migration 142 sorts after every social migration, so a fresh database applies it after 106.

A file in the 140 to 179 range sorts after 131, the last social migration used. A migration may be renumbered only before it reaches `dev`.
