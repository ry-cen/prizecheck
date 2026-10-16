# Social network migration numbers

Migrations apply in file-name order (`scripts/migrate.py`), each once, recorded by name in `schema_migration`. Release and deploy checks compare sets of names only: a candidate's migrations must all be applied, and an existing migration may never change or disappear (`scripts/release.py` `compatible`, `scripts/release_runtime.py`, `deploy/unraid/prizecheck-deploy.sh`). Nothing refuses a gap or a file that sorts before one already applied.

So the social network takes its own block, **100 to 139**, and leaves **052 to 099** to `dev` and collection import (#226 to #234). Each ticket's numbers are fixed now, so parallel branches never collide:

| Numbers | Ticket |
| --- | --- |
| 100 | #246 Handles, Display Names and the Invite Link (`100_collector_profile.sql`) |
| 101 | #249 Hidden Locations (`101_hidden_locations.sql`) |
| 102 | #247 Friends |
| 103 | #248 Blocks |
| 104 | #250 Browse a Friend's Collection, if it needs one |
| 105 to 109 | #252 Borrow Requests and the Loans tab |
| 110 to 114 | #253 Handover |
| 115 to 119 | #254 Borrowed Copies across the app |
| 120 to 124 | #255 Returns |
| 125 to 129 | #256 Return-by date and overdue, #257 Write-off and #258 Lend Offers (`125_loan_return_by.sql`; `126_loan_notice_kinds.sql` from the wave E review fixes) |
| 130 to 134 | #259 Inbox |
| 135 to 139 | #260 Ending a friendship with open Loans, then spare |

#245 has no migration. A ticket that needs more files than its range asks for the spare numbers first. A migration may be renumbered only before it reaches `dev`.

Because existing databases apply new `05x` files after `10x` ones while a fresh database applies them in number order, no social migration may depend on a `05x` migration that isn't on `dev` yet, and no later `05x` migration may depend on a social one. Whoever merges second checks any function both sides redefine (for example the Deck List trigger functions of migration 047): the last one applied wins, and the two orders must leave the same definition.
