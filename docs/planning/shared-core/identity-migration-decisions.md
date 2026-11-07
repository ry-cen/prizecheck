# Identity and migration decisions

**Status:** proposal for owner review, for [#531](https://github.com/ry-cen/prizecheck/issues/531) and
[#533](https://github.com/ry-cen/prizecheck/issues/533). Nothing here is approved. It authorizes no migration, security
change, cutover or deployment, and it adds no accepted ADR. Every recommendation is an input to Ryan's decision.

**Evidence:** `dev` at `434f5b7adfac925c833a64e1e5e53b243bef7a81`. Paths with line numbers are at that commit. Counts are
`grep` file counts on that commit. No database was touched, so schema statements come from reading migration text. What
could not be checked is listed under [Not verified](#not-verified). Short forms: `100:8-14` means lines 8 to 14 of the
migration numbered 100, and `deploy.sh`, `server.ts` and `auth.ts` are `deploy/host/prizecheck-deploy.sh`,
`auth/src/server.ts` and `auth/src/auth.ts`.

**Fixed inputs:**

- ADR 0023's explicit composition wins. There is no `GAME` setting, registry or game protocol, and core holds no game
  values. The Riftbound spec's `GAME` wording is obsolete.
- Riftbound is the intended second backend, with its own game data and social graph, and shared sign-in and Handles. Its
  spec and ADR 0022 are proposals on the paused `riftbound` branch. They are read here for constraints only, and #531
  excludes any assumed Riftbound product approval.
- Old WP-A, C, D, E and split-map Design B are historical options, not approved architecture (#531).

## Decisions Ryan must make

Decide IM-3, IM-7 and IM-11 first. Most of the others follow from them.

| ID    | Question                                                       | Recommendation                                                          | ADR                 |
| ----- | -------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------- |
| IM-1  | Route all identity SQL through one seam before any split?      | Yes, and widen the checker first                                        | no                  |
| IM-2  | How do gateway counters reach the operations panel?            | A signed internal gateway read; the panel still answers without it      | with identity       |
| IM-3  | Who writes Handles?                                            | The gateway owns the store; the API keeps the rules and calls it        | proposed: identity  |
| IM-4  | Is Display Name shared or per game?                            | Shared, stored with the Handle                                          | proposed: identity  |
| IM-5  | How do backends receive identity, and what is first touch?     | An ordered change feed each backend pulls; first touch reads identity   | proposed: identity  |
| IM-6  | One signing secret, or one per backend?                        | One per backend; Pokémon keeps its current secret                       | proposed: identity  |
| IM-7  | How does a backend prove the owner?                            | A local owner replica; no signed claim for now. Reverses an earlier answer | proposed: identity  |
| IM-8  | Is account deletion part of #533?                              | No. Keep the path open and ticket it as a product feature               | proposed: deletion  |
| IM-9  | What order does deletion run in?                               | Auth first, with a tombstone in the feed                                | proposed: deletion  |
| IM-10 | How long can a game hold data, and how is a restore repaired?  | Ryan sets the limit; keep tombstones for now                            | proposed: deletion  |
| IM-11 | One migration track, or core and per-game tracks?              | Core, per-game and auth tracks; Pokémon's files stay put                | proposed: tracks    |
| IM-12 | How does a database select its tracks without `GAME`?          | One explicit entry script per database                                  | proposed: tracks    |
| IM-13 | How is the core baseline built, and when?                      | Curated from a schema dump, with proof, only when a second game is approved | proposed: tracks    |
| IM-14 | Same PostgreSQL server? Co-located test harness?               | Same server, separate database; co-located by default, plus split tests | proposed: identity  |
| IM-15 | What is the rollback window, and when do legacy tables go?     | Keep them through the backup window; dropping is a separate approval    | proposed: tracks    |

Three proposed ADRs would come out of these answers: shared identity, account deletion across games, and migration
tracks with a baseline. The tracks ADR changes ADR 0023's "Migrations are not split" consequence, so it should say so.

## Current state

This section covers #531's first acceptance criterion.

| Concern               | Today                                                                                                                       | Evidence                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| One database          | Gateway and API use the same `DATABASE_URL`, role and database                                                              | `compose.deploy.yml:24,97`, `auth/src/auth.ts:15`                                        |
| Sign-in tables        | `"user"`, `session`, `account`, `verification`                                                                              | `migrations/002_auth.sql`                                                                |
| Gateway tables        | `auth_send_event`, `auth_rate_event`, and three names in `operations_counter`                                               | `001:21-28`, `040:5-16`, `019:20`                                                        |
| Owner                 | Singleton `owner_binding`, foreign key to `inventory_owner`, not to `"user"`                                                | `001:16-20`                                                                              |
| Handle, Display Name  | `collector_profile` columns beside game-only `open_to_cash_offers`, `trader_id`, `suspended_at`                             | `100:8-14`, `143:27`, `145:14,17`                                                        |
| Released Handles      | `released_handle`, held 30 days                                                                                             | `100:18-21`, `api/app/social/profile.py:255-263`                                         |
| Handle writes         | Only `set_handle`, in one game transaction under the owner lock                                                             | `profile.py:214-272`, writes at `:236` and `:264`                                        |
| Display Name writes   | Only `set_display_name`; triggers copy it into Invite records and later tables                                              | `profile.py:191`, `100:121-122`                                                          |
| Cross-table sign-up   | `"user"` insert fires a trigger that inserts `inventory_owner` and Unsorted, which fires a trigger that makes the profile   | `020:1-12`, `100:87-96`                                                                  |
| Foreign keys          | Only `session` and `account` reference `"user"`; no API table does                                                          | `002:3,5`                                                                                |
| Backups               | One `pg_dump` is one consistent snapshot of sign-in and game data                                                           | `deploy/host/prizecheck-deploy.sh:708`                                                   |

The single transaction is the dependency that matters most. Migration 020 says so outright: failed onboarding cannot
leave an account. A split removes that guarantee, along with the one consistent backup.

## 1. The seven identity SQL exceptions

### Where they are

They are the `[sql]` section of `scripts/python_boundary_allowlist.txt:8-14`. `scripts/check_python_boundaries.py:38`
defines the identity tables, and `:201-204` fails a new hit or a stale line. `scripts/python_architecture_rules.py` has
no identity-table rule. It does pin who may import `app.identity`'s `verified_user` and `require_owner`, so moving those
names means editing those pins, which needs owner approval.

| # | Allow-list line                                       | Site                         | What it does                                                                                                                    | What it needs to go                                                                                                                       |
| - | ----------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | `app.host_readiness: owner_binding`                   | `api/app/host_readiness.py:24` | Reports whether an owner is bound. The check is already passed into `core.ops.readiness.run`                                    | IM-7. The root shim calls the seam's owner read                                                                                           |
| 2 | `app.host_readiness: user`                            | `api/app/host_readiness.py:30` | Not a query. An operator hint that prints a `psql` command, repeated in `docs/deployment-oracle.md:643` and `deployment-unraid.md:430` | Replace the hint with a tool or wording that needs no table name. After a split the printed command would name the wrong database anyway |
| 3 | `app.identity: owner_binding`                         | `api/app/identity.py:37`     | `require_owner`: 35 calls in 10 modules                                                                                         | IM-7                                                                                                                                      |
| 4 | `app.operations: auth_rate_event`                     | `api/app/operations.py:76`   | Sign-ups in 24 hours, a subselect in a statement that also reads game tables                                                    | IM-2. Split the statement                                                                                                                 |
| 5 | `app.operations: auth_send_event`                     | `api/app/operations.py:75`   | Sign-in requests in 24 hours, same statement                                                                                    | IM-2                                                                                                                                      |
| 6 | `app.games.pokemon.catalog.rule_rollout: owner_binding` | `rule_rollout.py:186,426`    | A startup job and a restore need the owner's id as `reviewer_id`. Neither runs inside a request                                 | IM-7. A signed claim cannot serve this line, because there is no request to carry it                                                      |
| 7 | `app.social.profile: released_handle`                 | `profile.py:255,260,263`     | The 30-day hold check, the release and the prune                                                                                | IM-3                                                                                                                                      |

Exception 2 is a text hit, not SQL. Exception 6 is the one to weigh hardest, because it decides whether IM-7 can be a
claim alone.

### The seven are not the whole surface

Emptying the list would not make identity movable. The checker misses these:

- **`collector_profile`** is not in the table regex. It appears in 13 API modules, and the Handle and Display Name
  columns are the core of the split.
- **`operations_counter`** is not in the regex. `operations.py:77` reads gateway-written names from it.
- **Only `api/app` is scanned.** `scripts/bind_owner.py:11-15` and `scripts/operations_mail.py:27` join `"user"` and
  `owner_binding`. The gateway reads `owner_binding` to gate sign-up (`auth/src/auth.ts:134-148`).
- **The exemption is a base name.** `SQL_EXEMPT` matches any file called `identity_store.py` at any path (`:37`, `:186`),
  and no such file exists yet. A future file with that name in a game would be exempt too.

### IM-1: seam and checker

| Option                                               | For                                                              | Against                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| A. One seam, same SQL, same database, before a split | Useful alone; empties the list; every later change has one place | A little indirection with one backend                   |
| B. Move each line during the split                   | No interim step                                                  | Security and topology changes land in one large diff    |

**Recommendation:** A. Widen the checker first: add `collector_profile` and `operations_counter`, scan `scripts/`, and
exempt one exact path. Because `collector_profile` is read in 13 modules, its reads get their own allow-list section,
since game-local mirror reads stay legitimate under IM-5.

**Ryan decides:** whether to land the checker and the seam now, ahead of Riftbound approval. They are the only slices
that pay for themselves with one game.

### IM-2: gateway counters

The panel reads two event tables and three `operations_counter` names that the gateway writes (`server.ts:237`,
`rateLimits.ts:34`). `scripts/release.py:47` writes `release_failed`. After a split the table's rows have two homes.

| Option                                              | For                                           | Against                                       |
| --------------------------------------------------- | --------------------------------------------- | --------------------------------------------- |
| A. API calls a signed internal gateway read         | No auth credentials in the API; one source    | Panel depends on the gateway answering        |
| B. API reads the auth database                      | Simple SQL                                    | Puts auth credentials in every backend        |
| C. Gateway pushes rollups into each game            | Panel stays local                             | Fans out sign-in data no game needs           |

**Recommendation:** A, per panel rather than per game, with a short timeout. The response shape must not change, so the
fields read as "unverified" or null when the gateway does not answer. `sign_in_delivery` already has an `'unverified'`
state (`operations.py:81`), but the two 24-hour counts do not, so this needs checking against the API contract snapshot.

**Ryan decides:** whether a game's operations panel shows sign-in numbers at all, or whether they belong on one panel.

## 2. Ownership of shared identity, Handle and Display Name

Identity is neither core nor game. **Auth owns it.** Core holds a game-free client and the code that applies identity to
a game database. A game composes both as it does today and holds no identity values, which is ADR 0023's rule and needs
no new mechanism. `collector_profile` stays in each game database, because its game-only columns and every social join
live there. Its identity columns become a read-only mirror. This part of the design brief (D3) holds up: a read per lookup
would rewrite joins in 13 modules and make every social read depend on the gateway.

### IM-3: who writes Handles

The 2026-10-29 record conflicts. The design brief's Q3 says the API runs claims against the auth database. The Riftbound
spec, from the same day, says a claim goes through the gateway. #531 voids both as approved architecture.

| Option                                                                      | For                                                                                     | Against                                                                                                        |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A. Gateway owns store and rules (split-map Design B)                        | One writer; matches ADR 0022                                                            | Ports `social/name_rules.py` and the word filter to TypeScript; two rule sets risk drift; moves 11 API test files' coverage |
| B. API writes through a narrow auth role (brief D4)                         | Smallest diff; check order unchanged                                                    | Auth credentials in every backend; several writers                     |
| C. Gateway owns the store behind a signed internal route; API keeps the rules | One writer; no auth credentials in backends; no rule port; `PUT /api/profile/*` unchanged | A network call inside the game transaction, under the owner lock; a new internal route to secure               |
| D. Per-game Handles                                                         | No shared write                                                                         | Excluded: Handles are shared                                                                                   |

**Recommendation:** C. `set_handle`'s order stays. The format, filter, same-Handle and attempt-limit steps stay local.
The 30-day check runs from the mirror and again in the auth transaction, so a stale mirror cannot pass it. The claim
takes a request key and is idempotent in auth. If the game commit fails after auth commits, a retry with the same
idempotency key gets the same answer, and the feed repairs the mirror if the client never retries. The call needs a hard
timeout, because the owner lock is held across it.

**Accept with C:** the hourly attempt limit stays per game (`handle_lookup_event`), so a collector using both sides gets
10 an hour on each. The 30-day limit and the hold are global.

**Ryan decides:** A, B or C.

### IM-4: Display Name

| Option                                  | For                                                                                                | Against                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A. Shared, stored with the Handle       | A collector sets it once (Riftbound user story 4); adds one column to a path the Handle already needs | Changes without limit, so more feed traffic; triggers fire on every apply |
| B. Per game, stays in `collector_profile` | No migration; no cross-database write                                                              | New side shows the placeholder `Collector`; shared Handle beside a per-game name reads oddly |

**Recommendation:** A. `"user".name` is Better Auth's provider name (`auth/src/auth.ts:213-214`) and is not the Display
Name, so the two should stay separate.

**Ryan decides:** A or B. Design-brief Q1 defaulted to moving it, with an easy revert.

### Consequences to accept for shared identity

These are product results, not technical limits:

- **A Block stays per game.** Someone Blocked on Pokémon can still find the same Handle on Riftbound, because Friends and
  Blocks are per side and the Handle is not.
- **A Suspension stays per game.** `suspended_at` is a game column. A collector suspended on one side is not suspended on
  the other. Neither spec says what should happen.
- **A Handle is findable only where a collector has a profile.** A lookup on a side they never opened answers like an
  unknown Handle.

### IM-5: how backends receive identity, and first touch

| Option                                                  | For                                                                                            | Against                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A. Ordered change feed; each backend pulls and keeps its cursor in its own database | Survives absence and restore with one mechanism; auth holds no per-backend delivery state      | A poller per backend; lag on other games; feed retention                    |
| B. Gateway outbox pushes to each backend (split-map)    | Lower latency                                                                                  | Auth tracks every backend's delivery; a restore needs a separate resend     |
| C. Read per lookup                                      | No mirror                                                                                      | Rewrites 13 modules; every social read depends on the gateway               |
| D. Sign the Handle into requests                        | No store                                                                                       | Covers the caller only, not the Friends shown to them                       |

**Recommendation:** A. The change made in one game shows at once there, because the claim's answer updates its mirror.
Other games catch up on their next pull. Applying in feed order also deals with the non-deferrable `handle_key` UNIQUE
(`100:11`) after a long absence.

**Two hazards to carry into acceptance:**

- A sequence value is not commit order. A pull that passes a value can miss a lower one that commits later. Feed appends
  must be serialized in auth.
- A restored auth database rewinds the feed. See [IM-10](#im-10-absence-retention-and-restore).

**First touch.** A game creates `inventory_owner` lazily at 10 API sites, and the insert fires a trigger that generates a
**local** random Handle (`100:89-96`). In a split that Handle would be unknown to auth. Every one of those sites must go
through one helper, in the game transaction, that reads the identity and overwrites the placeholder. The design brief's
D6 proposed this as `adopt_new_owner`, and the site list has since moved. Sign-up must also create the auth identity
atomically, replacing what `020` and `100` give today. `auth/tests/signup.test.ts:81-84` currently asserts that a new
account has an owner row and Unsorted, so a split topology changes when those rows appear.

**Ryan decides:** A or B, and an acceptable lag for a Handle change to reach the other game.

## 3. Signed-owner checks

### How it works today

- **Identity:** the gateway finds the session, then signs `METHOD\npath\nsha256(body)\nuser\nstamp` with
  `INTERNAL_AUTH_SECRET` (`auth/src/server.ts:602-613`). `verified_user` recomputes it, allows 30 seconds of skew, and
  compares in constant time (`api/app/identity.py:10-32`).
- **Forgery from outside:** nginx blanks the `X-Internal-*` identity headers (`deploy/docker/nginx.conf:41-44`), the
  gateway builds a fresh header map, and in `compose.deploy.yml` only `web` publishes ports.
- **Owner:** the signature carries no owner fact. `require_owner` reads `owner_binding` on the game connection.
- **Gateway's own owner logic** is separate and only gates sign-up: the verified `OWNER_EMAIL` until a binding exists,
  then the bound user (`auth.ts:134-148`).
- **Binding** is a plain `INSERT` on a singleton (`scripts/bind_owner.py:15`), so a second binding fails. The product has
  no owner transfer.

The message has properties a second game makes important. It has no audience, the query string is not signed, and there
is no nonce, so a captured request is valid for 30 seconds. The separately signed budget headers show a working pattern
for adding a fact without touching the main message: their own prefixed message and signature (`server.ts:627-637`).

### What a second game needs

- A second upstream. `apiOrigin` is a single value (`server.ts:38,646`).
- Prefix handling before signing and before the `/api/public/` test, `BUDGETED_ROUTES` and the import limit
  (`server.ts:41,70,109,562`), all of which match today's paths literally. The spec's rule that the signature covers the
  path the backend receives keeps `identity.py` unchanged.
- An `inventory_owner` row for the owner in that database, because review tables require `reviewer_id` to reference one.
- Its own readiness line, and the answers to IM-6 and IM-7.

### IM-6: signing secrets

With one shared secret, a compromised container on either side could forge any collector, and the owner, on the other.
With a path-stripping gateway, the same signed request is also valid on either backend.

| Option                                       | For                                                                                                    | Against                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| A. One secret per backend                    | Isolation and audience in one change; signed message unchanged, so 13 API test files are untouched     | Gateway holds a small map; one more secret to manage   |
| B. Shared secret, audience in the message    | One secret                                                                                             | Changes the message and tests; no containment at all   |
| C. Keep sharing                              | No work                                                                                                | Compromise of either backend is compromise of both     |

**Recommendation:** A, with Pokémon keeping its current value. The same secret also keys cursors and tokens
(`core/inventory/cursors.py:17`, `core/decks/index.py:16` and others), so rotating Pokémon's would invalidate them;
leaving it alone avoids that entirely. This is security-sensitive, and the recommendation changes nothing until a second
backend exists. Internal routes from IM-2, IM-3 and IM-5 need a signing scheme of their own, with a prefix as the budget
signature has, so no response or internal call can be replayed as a user request.

**Ryan decides:** A, B or C.

### IM-7: how a backend proves the owner

The record conflicts here too. Design-brief Q2 says the API reads an auth `owner_binding` and "not a signed flag". The
Riftbound spec and ADR 0022 say a flag on the user, signed by the gateway, with backends reading no table. All are dated
2026-10-29.

| Option                                                        | Revocation                    | API credentials | Jobs (`rule_rollout`, readiness)  | Tests                                                 |
| ------------------------------------------------------------- | ----------------------------- | --------------- | --------------------------------- | ----------------------------------------------------- |
| A. Local replica: `owner_binding` per game, auth authoritative | On next apply, or by tool     | None            | Work unchanged                    | None change                                           |
| B. Signed claim (ADR 0022), plus a replica for jobs           | Immediate for routes          | None            | Still need the replica            | 19 API files seed `owner_binding`; some must change   |
| C. API reads auth `owner_binding`                             | Immediate                     | Auth role       | Read auth too                     | Few                                                   |

**Recommendation:** A, which **reverses the 2026-10-29 signed-flag answer**, so it needs Ryan's explicit choice. The
reasoning:

- Exception 6 means B cannot remove a game-side owner read. Jobs have no request. So both A and B keep an owner copy per game,
  and B adds a new signed fact on top.
- B's real advantage is immediate revocation when the owner changes, and the product has no way to change the owner.
  Ending the owner's sessions already works at once in auth under either option.
- A keeps `require_owner`, its 35 calls and today's failure behaviour exactly. That matches "no security change".
- A compromised game can fake owner on that game alone in either design, given IM-6.
- B is additive later, through a prefixed second signature, if owner transfer ever becomes a feature.

A's risk is a stale replica after an owner change, and it fails open for the former owner. If a transfer is ever built, it
must rebind every game and include disabled ones when they return. Auth keeps its own owner record for the sign-up gate
under every option. `bind_owner.py` gets a defined per-database behaviour, and its `"user"` check moves to auth.

**Ryan decides:** A, B or C, and if the signed flag stands, that the replica for jobs is accepted alongside it.

## 4. Deletion and replay when a game is unavailable

### What exists today

**There is no account deletion.** No gateway or API route deletes an account, and the planning docs record it as unbuilt
(`docs/planning/social-network/wayfinder/resolutions/decide-social-module-boundary.md:100`). Everything below would be new
behaviour, and a split is not the only reason to build it. Facts a design must meet:

- **Deleting `"user"` reaches nothing in the game.** There is no foreign key, and `020`'s trigger fires on insert only.
- **`DELETE FROM inventory_owner` would fail for many collectors.** Of 48 foreign key lines naming it, 20 cascade, 13 set
  null and 15 have no action, including `015_publications.sql:4,15`, `007_missing_card_reports.sql:41` and the reviewer
  columns. This is a text scan.
- **Deletion is a domain command, not a cascade.** Loans not yet handed over are cancelled with reservations released,
  handed-over Loans stay open for the remaining side, unconfirmed Trades close first, and Trade Wants, picks and inbox
  updates go (`decide-loan-steps.md:44`, trading spec stories 177 to 181, social spec stories 133 to 138). `migrations/107`
  already expects both sides of a Loan to be able to go.
- **Idempotency receipts die with the collector.** `location_command` cascades from `inventory_owner` (`004:7`), so the
  normal receipt cannot prove a deletion ran.
- **A deleted collector can come back.** The 10 lazy insert sites would recreate `inventory_owner` for a signed request in
  flight. Signatures stay valid for 30 seconds.
- **Names outlive deletion by design.** Display Names stay on Loans and Trades, and `trade_report` keeps both Handles as
  `NOT NULL` text (`149:15-16`).
- **Public records need a drain.** Invite records go through `invite_projection_outbox`, and Published Decks are
  separately public.

### IM-8: scope

**Recommendation:** leave deletion out of #533 and ticket it as a product feature. The feed in IM-5 reserves a tombstone
entry, and no slice may foreclose it. The spec's phase 1 lists deletion as passing on split databases, but nothing exists
to pass.

**Ryan decides:** in or out of #533, and whether deletion must exist before a second game launches. If a second side
ships first, the gap covers two databases.

### IM-9: order

| Option                                                        | When a game is down                                                                 | Trade-off                                                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A. Synchronous fan-out                                        | Deletion fails or half-applies, and a disabled game has no route to call            | Simple; conflicts with switching a game off on its own                                          |
| B. Auth first; tombstone in the feed in the same transaction  | Sign-in, email and sessions go at once; the game applies it on return               | Game data outlives sign-in for the length of the outage                                         |
| C. Games first, auth last                                     | Sign-in and email stay until the game returns, which may be never                   | Strongest "all gone" moment; a disabled game can block deletion indefinitely                    |

The spec's "calls each enabled backend's deletion route" is a form of A, with a separate rule for disabled backends.

**Recommendation:** B. In one auth transaction: delete `"user"` (which cascades `session` and `account`), remove the
identity, hold the Handle in `released_handle`, append a tombstone, and redact that user's earlier feed rows. A game
applies a tombstone in one local transaction:

1. Record the id in a table outside the owner cascade. This is the idempotency proof.
2. Run the closing rules.
3. Remove the collector's rows.
4. Queue public removals.
5. Advance the cursor.

Lazy creation checks that table first, which closes the in-flight case.

**Open under B:** one tombstone that cannot apply would stall every later identity change for that game. Parking it with
an owner alert needs designing, because ordering matters only per collector. The owner's own account must be refused.

**Ryan decides:** A, B or C.

### IM-10: absence, retention and restore

With the recommended feed:

| Scenario                                       | Result                                                                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Game down for minutes                          | It pulls from its cursor on return                                                                                                            |
| Duplicate delivery                             | The tombstone table and the cursor make it a no-op                                                                                            |
| Game disabled for weeks                        | It must drain the feed before taking traffic, so "switching back on needs no migration step" gains a readiness gate                          |
| Handle released, reused while a game is stale  | Feed order applies the release first, so the mirror's UNIQUE holds. The 30-day hold narrows this but does not close it                        |
| Game wiped                                     | Nothing to apply; its cursor no longer holds retention back                                                                                   |
| Game restored from an older dump               | The cursor rewinds with the data, so deletions after the dump apply again. Push needs a manual resend here                                    |
| Auth restored from an older dump               | **Not solved by the feed.** Deleted accounts return, and game cursors run ahead of the feed. Needs a feed epoch that makes a game refuse to pull, and a repair from game tombstone tables |
| In-flight signed request after deletion        | Refused by the tombstone check at lazy creation                                                                                               |

**Backups stop being one snapshot.** `backup_database` dumps one database (`deploy.sh:708`), `scripts/recovery.py:65`
walks one database's tables, and the guides warn that anything after a dump is lost (`docs/deployment-oracle.md:889`).
After a split, a restore of either database means reconciling against the other. This is a new operating cost whatever is
chosen here.

**Recommendation:** keep tombstones with no pruning for now, because `KEEP_BACKUPS=10` (`deploy.sh:59`) and manual dumps
set how far a restore can rewind. A tombstone holds an opaque id only. Write the restore procedure for both directions
before any production split.

**Ryan decides:** how long a disabled game may keep a deleted collector's data, and whether backups of deleted data are
acceptable until they age out. Riftbound's spec says "when it is re-enabled or wiped", which has no upper limit. Whether a
limit is legally required, and whether an opaque id counts as personal data, is **not assessed here**.

## 5. Migration tracks and a fresh baseline

### What the tools assume

- **One flat directory, applied in file-name order, recorded by bare name** (`scripts/migrate.py:15-21`). The whole
  pending batch is one transaction.
- **There are 86 files, numbered 001 to 162, not a contiguous sequence.** 77 numbers are unused, because blocks were
  reserved (`docs/planning/social-network/migrations.md`), and **`161` appears twice**
  (`161_likely_reprint_dismissals.sql`, `161_tcgplayer_large_art.sql`). Nothing rejects a duplicate, and the name sort
  makes it deterministic.
- **Ten non-recursive `*.sql` globs in eight files:** `migrate.py:15`, `deploy.sh:692,763`, `release.py:106-107`,
  `release_runtime.py:59`, `check_guardrails.py:393`, `api/tests/test_catalog_references.py:88`,
  `api/tests/test_card_identity.py:32` and `tests/tooling/test_set_code_guardrail.py:54`. 27 files reference the
  migrations path, and 19 name `migrate.py`.
- **A Pokémon check sits in the shared runner.** `migrate.py:23-43` compares `catalog_set_code` with
  `games/pokemon/catalog/set_codes.tsv`, guarded by `to_regclass`, so it silently skips elsewhere.

**A trap for any new track.** The deploy runs `migrate.py` only when `migration_state` lists a pending file
(`deploy.sh:874`), and that list comes from the flat glob. A release whose only new file is under `migrations/core/`
would log "No pending migrations", skip the backup and skip the migration. The smoke check, using the same glob, would
pass. Tracks need these tools changed in the same slice that adds the first track file.

### IM-11: track layout

| Option                                                                                                                | Fresh Riftbound                                                                                            | Pokémon history                                                  | Trade-off                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. One track, every database applies everything                                                                       | Gets empty and seeded Pokémon relations, including Set Code rows                                           | Untouched                                                        | No tool change and it trivially meets ADR 0023's "same relation names" consequence, but puts Pokémon data in a Riftbound database, against "separate game data", and every game file ships to every game |
| B. `migrations/core/`, `migrations/auth/` and `migrations/<game>/`, with Pokémon's existing files staying at the root | Core baseline, then core tail, then its own track                                                          | Untouched; baseline recorded, not run                            | Tool changes and a proof obligation, but the only option with real separation and no rewrite                                                                                                              |
| C. Move Pokémon's files into `migrations/pokemon/` and rewrite the ledger                                             | As B                                                                                                       | Rewrites `schema_migration` on every database                    | Tidier tree; breaks `compatible()`, smoke and rollback (section 6)                                                                                                                                        |

**Recommendation:** B. The root directory is the Pokémon track, with an unbroken history. New tracks record
path-qualified names, such as `core/001_x.sql`, so old releases simply see extra rows. Each track numbers itself, and the
root continues from 163. Nothing is renumbered, including the `161` pair. Add a guardrail against new duplicates.

**Ordering rules:**

- Core migrations never reference a game's tables. Game migrations may depend on core.
- In a release, pending core files apply before pending game files.
- The auth track touches only the auth database. Nothing else touches it.
- Every core migration must work on both shapes: Pokémon's tables have foreign keys into `catalog_*`, and a new game's
  may differ.

**How each database installs:**

| Database                | Order                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Pokémon, populated      | Pending root files to the cutoff; record the baseline after a precondition check; then pending core, then pending root              |
| Pokémon, fresh          | The same path, so fresh and populated never diverge. There is no Pokémon squash                                                     |
| New game, fresh         | Core baseline, core tail, then that game's track, which creates `catalog_*` and adds its foreign keys                               |
| Auth, fresh             | Auth baseline, then auth tail                                                                                                       |
| Auth at cutover         | Auth baseline on an empty database, then a verified copy. This is a data step and needs its own approval                            |

**Ryan decides:** A, B or C. It amends ADR 0023's "Migrations are not split" and the catalog contract's "Migrations remain
one track".

### IM-12: selecting tracks without `GAME`

D10's `--game none` and the spec's "game setting" both lean on the rejected idea. ADR 0023 says `main.py` chooses the game
and does not say how one image serves two. That gap needs closing too.

**Recommendation:** one explicit composition entry per database. `scripts/migrate.py` stays the Pokémon entry at its
pinned path, naming its tracks and its Set Code check. An auth entry and a future game entry sit beside it, over a small
shared runner that takes the tracks and checks as arguments. Compose names the entry per service. The API image can follow
the same shape: a per-game ASGI entry that imports that game's `app`, chosen by the service's command. No variable, and no
lookup by name.

**Ryan decides:** this shape, or an alternative that keeps ADR 0023 intact. A value that selects a game at run time would
amend the ADR.

### IM-13: building the baseline

| Option                                                                    | For                                       | Against                                                                                 |
| ------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| A. Curated `core/000_baseline.sql` from a fresh schema dump, with a proof | Reviewable; one file; true end state      | Hand work; needs a drift check                                                          |
| B. Copy the core historical files verbatim                                | Keeps history                             | Files are mixed, and carry foreign keys into `catalog_*`, so they cannot run alone      |
| C. Build by running Pokémon's history, then dropping Pokémon objects      | Automatic                                 | Slow, fragile, and passes through Pokémon data on every install                         |

**Recommendation:** A, cut only when a second game is approved, because ADR 0023 says to invent nothing for a game that
does not exist. Known inputs:

- **The split-map's table is stale.** It covers 82 files and stops at 159, with 160 marked planned. `160`, both `161`s and
  `162` need classifying. `162_trade_loan_threads.sql` is the largest non-seed file and reads as core.
- **`146_zip_centroids.sql` is 1.7 MB of seed data** that Open discovery needs. It should stay a separate core file,
  recorded not run on Pokémon, rather than swell the baseline.
- **No `CREATE EXTENSION`** appears in any migration.
- **A sample of core function bodies** (11 files, including 148 and 162) names no `catalog_*` relation, and the core view
  `open_discovery` (`145:37-40`) reads only core tables. A view or a SQL-language function that read `catalog_*` would stop
  the baseline installing before a game track. Later replacements still need a full audit.
- **A core-only database cannot serve.** Core SQL reads `catalog_*` relations ([catalog contract](catalog-data-contract.md)),
  so a game track must supply them.

**The proof**, in CI on disposable databases: build Pokémon's full history, build the baseline with a stub of the catalog,
and compare normalized schema dumps of core-owned objects, with the omitted foreign keys as an explicit list. Compare seed
rows by digest. The runner refuses to record the baseline if the objects are absent.

**Ryan decides:** A, B or C, and whether the cutoff waits for Riftbound approval.

### IM-14: hosting and test topology

Design-brief Q4 to Q7 sit under a heading that says all questions are answered, but Q4 to Q6 are phrased as open questions
with no recorded answer. Treat them as open.

- **Hosting (Q6):** same PostgreSQL server as a separate database, or its own? **Recommendation:** same server, separate
  database and role. It costs less, though the server stays a shared failure point, so the separation is logical only.
- **Test topology (Q4):** one URL for everything by default, so harnesses stay unchanged, with dedicated split tests.
  **Recommendation:** accept, because 18 web and 19 API test files seed `owner_binding` through one URL. Co-located tests
  cannot catch a split bug, so split tests and the widened checker are the guard, and they must be required.
- **Narrower core (Q7):** ADR 0023 has effectively settled this.

**Ryan decides:** Q4 and Q6.

## 6. Immutable Pokémon history and rollback

### What stays immutable

`compatible()` refuses a release that removes or changes any previous migration (`scripts/release.py:105-109`). The smoke
check needs every shipped file name in `schema_migration` (`deploy.sh:763-765`), as does the runtime adapter
(`release_runtime.py:59-61`). So the name and the bytes are both fixed.

Rollback restarts the previous images and does not reverse migrations (`deploy.sh:1429`,
`docs/deployment-oracle.md:883`). A previous release is expected to run on the newer schema, but that already has an
exception: `162_trade_loan_threads.sql:3` says rollback requires restoring the pre-release dump. That dump is the only
real undo, and anything written after it is lost.

### Why these options leave history alone

- **New tracks** add new files in new directories. No existing byte or name changes.
- **A baseline** is a new file. A Pokémon database records it without running it, so no old file is rewritten.
- **Renumbering** changes names, which `compatible()` and the smoke check both treat as a removal. This is why option C
  is out.

### Rollback by option

| Option                              | Roll back to a release before the change                                                                                                 | Failure mode                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| One track (A)                       | As today                                                                                                                                 | None new                                                                               |
| Tracks with baseline (B)            | Old image ignores subdirectories; its files are all still recorded, so smoke passes. Extra `core/` rows are harmless                     | Core migrations must stay compatible with the previous release, as today               |
| Move and rewrite (C)                | Old image finds its names missing, so smoke fails. Needs a second ledger rewrite under pressure                                          | Rollback is broken unless a dual-name ledger is built                                  |
| Pokémon squash (rejected)           | `compatible()` refuses the release outright                                                                                              | Not shippable                                                                          |
| Split, before a second game         | Stop new release; copy changed identity back; start old release (brief 3.5). Legacy tables must still exist                              | Lost writes if the copy-back is skipped                                                |
| Split, after second-game users      | Copy-back also carries users who never opened Pokémon                                                                                    | See below                                                                              |

**Copy-back has a trap.** An upsert into legacy `"user"` fires `onboard_auth_account` (`020:11-12`), which creates
`inventory_owner`, Unsorted and a profile with a fresh generated Handle, for anyone new since the cutover. The copy must
order its work so that profile takes the auth Handle, and must decide what to do about Riftbound-only users. `identity_cutover.py`
in the brief does not exist and has not been designed against this.

**The real point of no return** is not a migration. It is any of: dropping legacy tables, a second game holding users or
Handles that Pokémon's old schema cannot represent, or the first account deletion under the new path, since a copy-back
cannot restore a deleted collector's sign-in.

### IM-15: rollback window and legacy tables

**Recommendation:**

- Legacy identity tables stay in the Pokémon database, unused, through at least one full `KEEP_BACKUPS` cycle after
  cutover and until the second game opens.
- A read-only reconcile between auth and the legacy tables runs before the window closes.
- Any drop is a new root migration under a separate, later approval. It is never in the cutover release, and it ends the
  copy-back path, so it needs an explicit sign-off.
- Rehearse copy, verify, copy-back and rollback on a disposable database built from a sanitized copy before production.
  Dev's existing data is not a substitute unless Ryan says it is.

**Ryan decides:** the window length, and whether `162`'s dump-only rollback must have left the rollback range before a
cutover. A cutover release should not stack on another dump-only release.

## Implementation slices for #533

These can start only after the matching decisions are recorded in an accepted ADR. **Each slice is a separate reviewed PR,
and #531's "separately scoped tickets" should mirror them.** Independent security review applies to S2 and to S5 onward.
S1 and S2 stand alone with one game. S3 onward need Riftbound approval, or Ryan's choice to split anyway. There are two
chains: S3 leads to both S4 and S10, and S10 does not depend on S5 to S9.

### S1. Widen the identity checker (IM-1)

- Acceptance: `collector_profile`, `operations_counter` and `scripts/` are covered; the exemption is one exact path;
  fixture tests prove a new hit fails; no runtime file changes.
- Rollback: revert. Nothing is deployed.

### S2. Identity seam, same database (IM-1, and the shape of IM-3 and IM-7)

- Acceptance: all seven lines leave the allow-list; exception 2's hint is reworded; the 10 lazy sites go through one helper; SQL,
  order, locks and transactions are unchanged; OpenAPI and route snapshots are byte-identical; `npm run guardrails` and
  the touched API tests pass.
- Rollback: revert. No schema or data change.

### S3. Track-aware tools with no track files (IM-11, IM-12)

- Acceptance: the `deploy.sh`, `release.py`, `release_runtime.py` and guardrail globs see tracks; `migrate.py` stays at its
  path; on today's tree it applies the same files in the same order with the same ledger names; a fixture with a
  core-only pending file proves the deploy no longer skips it; a duplicate-number guardrail covers new files.
- Rollback: revert. No ledger rows exist yet.

### S4. Auth track and gateway `AUTH_DATABASE_URL`, co-located (IM-14)

- Acceptance: auth baseline files are no-ops on a populated co-located database; with the setting unset, behaviour is
  unchanged; all existing suites pass unchanged; empty-database installs of each track pass in CI.
- Rollback: unset the setting. Extra ledger rows are harmless to older releases.

### S5. Internal identity API and feed, on a disposable split stack (IM-3, IM-4, IM-5, IM-6)

- Acceptance: claims are idempotent; the check order and error codes match `set_handle`; feed appends are serialized with
  a test that holds a lower sequence open; internal routes refuse bad signatures, stale stamps, another backend's secret
  and edge traffic; a killed game transaction after an auth commit converges; split tests are required in CI.
- Rollback: co-located default remains; disable by configuration. Nothing in production uses it.

### S6. Mirror apply, first touch and owner replica (IM-5, IM-7)

- Acceptance: social reads are unchanged; first touch never publishes a local random Handle; `require_owner` denies by
  default with no replica row; all 35 `require_owner` calls keep their behaviour; `rule_rollout` still applies and
  restores; readiness reports an unbound game.
- Rollback: co-located mode makes the apply a no-op; revert the code. Replica rows are harmless.

### S7. Operations panel and multi-database operations (IM-2, IM-10)

- Acceptance: the panel's response shape is unchanged, and it answers when the gateway is down; deploy backs up every
  database; `recovery.py` covers each; the restore procedure for each direction is written and rehearsed on disposable
  databases.
- Rollback: revert code; added backups are harmless.

### S8. Cutover tooling and rehearsal (IM-15)

- Acceptance: copy, verify and copy-back are idempotent and tested against a populated sanitized copy, including sessions,
  `released_handle` and the `020` trigger trap; a rehearsal records timings; **no production run**.
- Rollback: tooling only.

### S9. Production cutover (separate approval, outside #533 as written)

- #533 excludes production cutover. It needs its own owner approval, window and runbook.
- Rollback: copy-back, then the previous release, inside the IM-15 window.

### S10. Core baseline and second-game install proof (IM-13, Riftbound approval)

- Acceptance: an empty database reaches the baseline with no Pokémon relations; the schema proof passes; Pokémon's fresh and
  populated paths record it without running it; a stub game track proves the install order; no Riftbound product code ships.
- Rollback: revert. A recorded ledger row is harmless; Pokémon's schema is untouched.

### Separate ticket: account deletion (IM-8, IM-9, IM-10)

Depends on S5 and S6. It is a collector-facing feature with its own spec, and it must resolve the 15 no-action foreign keys.

## Validation summary

This covers #531's fourth criterion. No check here has been run.

- **Compatibility:** OpenAPI and route-order snapshots byte-identical; existing suites pass in co-located mode; the previous
  release's fixed CI passes against the candidate schema (`docs/operations/release.md`).
- **Fresh and populated:** every track installs on an empty database; Pokémon's fresh and populated schemas match;
  rehearsals use disposable databases only.
- **Security:** the owner check denies by default; a signature from one backend fails on another; internal routes are
  unreachable from the edge, where nginx proxies only `/api` and `/auth` (`nginx.conf:30`), so any internal path must stay
  outside both; the API holds no auth credentials under the recommended options.
- **Failure:** kill each side of a two-database write; take a game down during identity changes; restore each database from
  an older dump.

## #531 acceptance status

| Criterion                                                                 | Status                                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Document identity tables, writes, owner auth, counters, cross-DB ties     | Done here, subject to review                                                         |
| Compare approaches; resolve owner questions with approval in an ADR       | Compared. **Open:** needs Ryan's answers and an accepted ADR                         |
| Design tracks, immutability, baseline, upgrade, cutover check, rollback   | Designed. **Open:** needs the same approval, and a cutover design beyond the outline |
| Define validation and gated tickets                                       | Slices defined. Tickets not filed                                                    |

## Older documents that no longer match

| Document                     | Says                                       | At this commit                                                    |
| ---------------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| split-map section 4          | 82 files, table ending at 159              | 86 files, ending at 162, with two `161`s                          |
| design-brief 3.1             | 11 API files sign requests                 | 13 name `x-internal-signature`                                    |
| design-brief 3.1             | 18 API files seed `owner_binding`          | 19                                                                |
| design-brief 3.1             | 7 API files call the profile routes        | 11                                                                |
| design-brief heading         | All owner questions answered               | Q4 to Q6 have no recorded answer                                  |
| Riftbound spec, ADR 0022     | `GAME` setting, game interfaces            | Superseded by ADR 0023                                            |
| ADR 0022                     | "Backends read neither from a table"       | `rule_rollout.py:186,426` needs an owner read outside any request |

## Not verified

- **Production state.** `schema_migration` order on production was not read. Numbered blocks mean production's applied order
  may differ from fresh-install order, and that matters for the IM-13 proof. A batch shares one `applied_at`, so only the
  order across batches can be recovered. This needs a read-only query by Ryan.
- **Live schema.** The foreign key counts and the core-function sample come from migration text, not a catalog.
- **Better Auth behaviour.** Delete hooks and cascade behaviour were not traced in the library.
- **Signature behaviour under a real path-stripping gateway.** It is not built.
- **Compose beyond the deploy file.** Port exposure was read from `compose.deploy.yml` only.
- **Legal retention.** No legal assessment of deletion, backups or opaque ids was made.
- **Feed volume, poll cost and latency.** No measurement. The designs above are untested.
- **Riftbound facts.** The spec's claims are unconfirmed and it is behind `dev`.
