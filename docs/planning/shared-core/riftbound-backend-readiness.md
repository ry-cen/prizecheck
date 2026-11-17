# Riftbound backend readiness

**Status:** design for owner review, for [#528](https://github.com/ry-cen/prizecheck/issues/528),
[#529](https://github.com/ry-cen/prizecheck/issues/529) and [#534](https://github.com/ry-cen/prizecheck/issues/534).
Nothing here is approved. It authorizes no implementation, migration, deployment or Riftbound code, and it adds no
accepted ADR. Items marked _proposed ADR_ would need Ryan's approval recorded in an ADR before work starts.

**Evidence:** `dev` at `3e921b0d86c81927d0167b35719d1498dcf85c17` (2026-11-08). Paths with line numbers are at that
commit. The audit is static: it read the tree and ran no database tests.

**Builds on, does not restate:**

- [#563](https://github.com/ry-cen/prizecheck/pull/563), branch `docs/backend-readiness-plan`:
  `docs/planning/shared-core/backend-readiness.md` (audit rows A, C; work items R1 to R13; decisions D1, D3, D4, D7)
  and `riftbound-catalog-acceptance.md`. Written at `434f5b7a`.
- [#564](https://github.com/ry-cen/prizecheck/pull/564), branch `docs/identity-migration-decisions`:
  `docs/planning/shared-core/identity-migration-decisions.md` (decisions IM-1 to IM-18, slices S1 to S10). Written at
  `434f5b7a`.
- The matching and inventory seam audit, slices 1 to 7, at
  `/home/t3/.t3/task-artifacts/backend-readiness-20261107/seam-audit.md`, written at `434f5b7a`.
- The Riftbound spec on the paused `riftbound` branch (`git show origin/riftbound:docs/planning/riftbound/spec.md`),
  for constraints only. Where it asks for a `GAME` setting, a registry or game interfaces,
  [ADR 0023](../../adr/0023-split-core-and-games-by-composition.md) wins.

**What moved since those were written.** One feature commit, `3e921b0d` (#569), landed seam slices 1 and 2: shared pick
ordering in `api/app/core/inventory/pick_order.py` (#565) and the allocation-needs fold in
`api/app/core/decks/needs.py:5-13` (#566), with Loans no longer importing the mixed Want List. #565 and #566 are still open
as drafts with their source unchanged. The other workers have three items in progress, which this plan does not
duplicate: removing the `api_errors` shim and extracting the Location path reader (#528, R3 and seam slice 4), porting the
six social caller scans to tooling (#528, R4 and seam slice 5), and #529's matching characterization tests with a
`card_accepts` audit.

## What "first backend slice" means here

The checklist needs a fixed target, and #534 doesn't define one yet. This plan assumes the following, and **Ryan must
confirm or replace it under D1**:

> **RB-1.** A Riftbound API, served by its own process against its own database, that mounts a Riftbound app with its
> catalog and the game-free core routes the catalog slice needs. Its catalog is filled only by the synthetic
> normaliser (#563 R12b) and accepted through #563's synthetic writer gate (R12c). It ingests no real content: real
> data is #563's R13, which comes after the data gate passes (H10). It mounts no social, Trade, Loan or Want List
> route. Pokémon's API, routes and data are unchanged.

This follows the spec's own order: catalog in its phase 5, Collection and social in phase 6, Want List in phase 7
(`spec.md:224-225`). If Ryan wants social or Want List features in RB-1, decisions 2a and 2b below become hard
prerequisites.

## 1. Readiness checklist

Status words: **Done**: the tree meets it. **In progress**: another worker has it open. **Blocked on decision**: needs
Ryan first. **Not started**: settled and nobody has it.

### Hard prerequisites for RB-1

| ID   | Condition                                                                                                                                     | Status              | Evidence at `3e921b0d`                                                                                                                                                                                                                                                                                                                                                                                                     | Issue      | What closes it                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| H1   | Riftbound's backend scope is approved, and #534 can go backend-first                                                                          | Blocked on decision | No approval is recorded. ADR 0022 exists only on `origin/riftbound`, still `proposed`. #534 still lists #532 as a blocker.                                                                                                                                                                                                                                                                                                  | #534       | #563 D1, including the RB-1 definition above                                                                                         |
| H2   | Catalog shape: a Riftbound database reuses the catalog relation names, and the write constraints that block TCGCSV-sourced Printings change | Blocked on decision | `migrations/003_catalog.sql:33` allows only `tcgdex` and `manual` sources, `:38` pairs `tcgdex` with `source_id`, and `:68` requires the Pokémon `basic_energy` column. The contract still lists `catalog_reprint_group_member` as a consumed relation (`catalog-data-contract.md:129-130`).                                                                                                                                 | #534       | #563 D4. Decision 2b below changes whether the Reprint Group relation stays on that list                                           |
| H3   | Migration tracks, and how a database selects them without `GAME`                                                                             | Blocked on decision | One flat directory and one runner. `scripts/migrate.py:23-43` holds a Pokémon Set Code check that skips silently when `catalog_set_code` is absent.                                                                                                                                                                                                                                                                       | #531, #533 | IM-11 and IM-12, then slice S3 (track-aware tools, mechanical once decided)                                                         |
| H4   | A core baseline a fresh Riftbound database can install                                                                                       | Blocked on decision | No baseline exists. IM-13 recommends cutting it only once a second game is approved.                                                                                                                                                                                                                                                                                                                                      | #531, #533 | IM-13, then slice S10 (it depends on S3, not on S5 to S9)                                                                           |
| H5   | Hosting and test topology for a second database                                                                                               | Blocked on decision | `api/app/db.py:8-9` reads one `DATABASE_URL` per process, so a separate process can point at a separate database with no code change.                                                                                                                                                                                                                                                                                      | #531       | IM-14                                                                                                                                |
| H6   | A second backend checks the gateway's signature with its own secret                                                                          | Blocked on decision | `api/app/identity.py:17` reads one `INTERNAL_AUTH_SECRET`.                                                                                                                                                                                                                                                                                                                                                                 | #531, #533 | IM-6                                                                                                                                 |
| H7 | If RB-1 has owner routes (Q-C2), such as catalog import review, a second backend can prove the owner | Blocked on decision, conditional | `require_owner` reads the singleton `owner_binding` (`api/app/identity.py:35-37`). A fresh Riftbound database has no row, so every owner route would deny. An RB-1 with no owner routes doesn't need this. See 2c on why, when it applies, this is the costliest identity item for RB-1. | #531, #533 | IM-7, then slices S2 and S6 as #564 orders them, or an interim Ryan approves (Q-C2) |
| H8   | How `main.py`, a second app and the service entry are composed                                                                               | Blocked on decision | `api/app/main.py:9`, `:13`, `:41-44` mount only Pokémon. `deploy/docker/api.Dockerfile:34` starts `app.main:app`. `api/tests/test_api_contract.py:8` pins one app's OpenAPI and route table. ADR `0023:12` says `main.py` chooses the game, while IM-12 recommends a per-game entry chosen by the service command. Neither has been reconciled.                                                                              | #534       | Decision 2d, question Q-D1                                                                                                          |
| H9   | Synthetic catalog acceptance runs before any real ingestion                                                                                  | Not started         | No Riftbound reader or writer probe exists under `api/tests`. The only Riftbound fixture in tooling tests the game-to-game import rule in one direction (`tests/tooling/test_python_boundaries.py:55-58`).                                                                                                                                                                                                                  | #534       | R12a now. R12b and R12c after H1 and H2                                                                                              |
| H11  | `main.py` imports nothing Pokémon except the Pokémon app                                                                                     | Not started         | `api/app/main.py:9` imports the Borrowed gallery router directly and `:41` mounts it outside `ROUTERS`.                                                                                                                                                                                                                                                                                                                    | #534 prep  | R2. A second mount would otherwise edit around a Pokémon router                                                                     |

### Required before any real ingestion or release (R13), not before synthetic RB-1

RB-1 as defined above uses synthetic records only, so the data gate does not block it. The gate is still mandatory
before any real content is ingested or released, which is #563's R13. Two steps are separate here: Ryan accepting the
gate as a requirement (D3), and the gate actually passing on real-source evidence.

| ID  | Condition                                                         | Status                                                                                                    | Evidence at `3e921b0d`                                                                                                                                                                                                                                                                                                | Issue | What closes it                                                                                                                                                       |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H10 | The data-rights and coverage gate passes before any real content | Accepting it: blocked on decision (D3). Satisfying it: not started, and needs evidence about the real source | Riftbound's only planned source is TCGCSV for catalog and prices (`spec.md:180`), and its images are TCGplayer CDN URLs whose caching is left open (`spec.md:204-205`). ADR 0024's context says no TCGplayer or TCGCSV terms that could be read permit storing images (`0024:5`), while its decision stores them for Pokémon (`0024:9`). | #534  | Ryan accepts the gate under #563 D3, deciding whether ADR 0024's storage decision extends to Riftbound art. Then the gate's checks pass on the real source before R13 |

- **Q-G1.** Do you want a stricter gate before synthetic RB-1 too, for example accepting the data gate (D3) before any
  synthetic writer code lands? As written, D3 is required only before R13.

### Can follow RB-1

Each row is useful clean-up or a later Riftbound slice's prerequisite, but RB-1 as defined above doesn't need it.

| ID  | Item                                                                         | Status              | Evidence at `3e921b0d`                                                                                                                                                                                                                         | Issue            | Needed before                                                    |
| --- | ---------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------- |
| F1  | R1 contract drift                                                            | Not started         | `catalog-data-contract.md:25` still says `holdings.py`. `api/tests/test_catalog_data_contract.py` never names `catalog_attribute_state`.                                                                                                       | #520 follow-up   | Nothing blocks on it, but it is small and makes H2's contract honest |
| F2  | R3 `api_errors` shim                                                         | In progress         | `api/app/api_errors.py:1-2` remains for its one caller, `api/app/location_tree.py:10`.                                                                                                                                                         | #528             | Nothing                                                          |
| F3  | Seam slice 1, pick order                                                     | Done                | `api/app/core/inventory/pick_order.py`. `copy_picks.py`, `trade_picks.py` and `deck_pick_list.py` import it (#569).                                                                                                                             | #528             | n/a                                                              |
| F4  | Seam slice 2, allocation needs                                               | Done                | `api/app/core/decks/needs.py:5-13`. `want_list.py:51` and `loan_inventory.py` import it.                                                                                                                                                      | #528             | n/a                                                              |
| F5  | Seam slice 3, pure allocation split                                          | Not started         | `copy_allocation.py` still holds both rows and reader. `WantListCounting` is still in `api/app/settings.py`.                                                                                                                                    | #528             | Optional. The seam audit calls it an opportunity, not a prerequisite |
| F6  | Seam slice 4, Location path reader                                           | In progress         | Owned by another worker.                                                                                                                                                                                                                      | #528             | Nothing                                                          |
| F7  | R4 and seam slice 5, six caller scans in tooling                             | In progress         | They are still in `api/tests/test_social_contract.py:50-67`. `scripts/python_architecture_rules.py:14` scans only `app.social`.                                                                                                                 | #528             | Seam slice 7, and any social or Trade List move                  |
| F8  | Seam slice 6, Want List capture split                                        | Blocked on decision | `api/app/want_list.py:58` imports eight names from mixed `swap_hints`. Owners mark `app.want_list` and `app.swap_hints` `mixed` (`scripts/python_module_owners.txt:48`, `:51`).                                                                  | #528, #529       | A Riftbound Want List (spec phase 7), and slice 7. Decision 2a     |
| F9  | R7 and seam slice 7, Reprint Group composition                               | Blocked on decision | Reprint Group SQL in shared matching sits only at `swap_hints.py:63-82` and `social/friend_reads.py:91-103`. #529's characterization and `card_accepts` audit are in progress.                                                                 | #529             | A Riftbound Friend read or Trade match (spec phase 6). Decision 2b |
| F10 | R5 currency default, R6 finish labels                                        | Not started         | `api/app/core/prices/cost.py:37`, `:52` default `'USD'`. `api/app/social/threads.py:377` maps `normal`, `holo`, `reverse`.                                                                                                                     | #528             | Riftbound prices (R5) and Riftbound Trade or Loan threads (R6)   |
| F11 | Name rules reserve Pokémon brands                                            | Not started         | `api/app/social/name_rules.py:33-35`. Handles are shared across games, so this is an identity question too.                                                                                                                                       | #531             | A shared Handle store (IM-3)                                     |
| F12 | `deck_list.target_format` Pokémon default and check                          | Not started         | `migrations/045_deck_list_target_format.sql:14`, `:19-21`.                                                                                                                                                                                     | #531             | The core baseline (H4) has to classify it. Riftbound Decks are spec phase 7 |
| F13 | R8 inventory relocations, R11 public records and social moves                | Not started         | Location blocks nothing: the checker forbids no edge from a game into a core-owned root module.                                                                                                                                                | #528             | Nothing. #563 D7 recommends deferring them, and this plan agrees  |
| F14 | R10 retire the price runner                                                  | Not started         | #356 is open. ADR 0019 is still `proposed` (`0019:3`).                                                                                                                                                                                         | #356             | Riftbound prices, if they follow ADR 0019                       |
| F15 | Social identity: shared Handles, Display Name, feed, mirror and first touch | Blocked on decision | `collector_profile` and `released_handle` live in the one database (`api/app/social/profile.py:214-272`).                                                                                                                                       | #531, #533       | Any Riftbound social slice. See 2c                               |

### Honest notes on #563's judgments

- **#563 judged R7 shrinkable if D1 drops social matching at first.** This plan goes further. Under RB-1, neither R7 nor
  seam slice 6 is a hard prerequisite, because RB-1 mounts none of the five modules involved. Both become hard
  prerequisites only for the Riftbound slice that adds Friend reads, Trade matches or the Want List.
- **#563 left module location as tidiness (D7).** That still holds at `3e921b0d`. Slices 1 and 2 landed because they
  remove real dependencies, not because Riftbound needs the files moved.
- **#563 withdrew D5, so the mount was "nothing to decide now".** This plan reopens the question as H8. RB-1 is exactly
  when it needs answering, and #564's IM-12 recommendation reads differently from ADR `0023:12`'s wording.
- **The identity cost of RB-1 is larger than #563's table suggests.** If RB-1 has owner routes, H7 alone pulls in #564's
  slices S2, S5 and S6 under the IM-7 recommendation (see 2c and Q-C2). An RB-1 with no owner routes avoids that cost.

## 2. Decisions for Ryan

### 2a. Want List capture shape (seam slice 6)

**Evidence.**

- One function does both captures. `capture_want_list(user_id, deck_id=None, timeout_ms=None, swaps=False)`
  (`api/app/want_list.py:173-208`) takes the owner lock once (`:182`), allocates (`:194`), and with `swaps=True` also
  reads Reprint Groups through `capture_swaps` in the same transaction (`:204`).
- Only one caller asks for swaps: the Pokémon route (`api/app/games/pokemon/decks/want_list.py:24`). Every other caller
  uses the no-swap capture: the cost (`games/pokemon/decks/want_list_cost.py:85`), the Mass Entry export
  (`games/pokemon/exports/want_list_mass_entry.py:53`), Friend reads (`social/friend_reads.py:121`) and Trade matches
  (`social/trade_matches.py:422`).
- The scoped and All Decks agreement lives inside the swap branch. When a scoped read's owner has any Will accept
  choice, it widens `needed` to every Deck's lines (`want_list.py:197-203`). That code changes only what the hints read.
- The response models carry the Pokémon-typed hint. `WantListLine.swap: SwapHint | None` (`want_list.py:93`), and
  `WantListCapture.swaps: SwapCapture` (`:153`). ADR `0023:11` puts a model with a Pokémon-typed field beside its
  Pokémon route.
- `deck_switch_candidates` (`want_list.py:256-307`) imports only `FACTS` from `swap_hints` (`:293`), and only for its
  `available` flag. `FACTS` (`swap_hints.py:91-103`) reads contract relations only, with no Reprint Group, and its
  availability predicate is the same rule as core's `AVAILABLE` (`api/app/core/trading/trade_wants.py:38-41`).
- `edition_needs` (`want_list.py:224-236`) is game-free and feeds Trade matches and Confirm swap
  (`social/trade_matches.py:421`, `games/pokemon/trading/trade_inventory.py:628`).
- Patch sites to keep working: the row-counting tests patch `app.want_list.connect`
  (`api/tests/test_want_list.py:293-294`, `api/tests/test_want_list_swap.py:279-290`). The social import map allows
  `('app.want_list', 'capture_want_list')` and `('app.want_list', 'edition_needs')`
  (`scripts/python_architecture_rules.py:56`, `:69`, `:71`).

**Options.**

| Option                                                                                                                                                                                                                                                                                                                                                                                          | For                                                                                                                                                                                                                                           | Against                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Core building block, Pokémon composes the transaction.** Core gets the in-transaction capture (owner lock, settings, Deck order, allocation) as a function of `conn`, plus today's `capture_want_list` without `swaps` wrapping it with the same timeout and lock code. The Pokémon route module opens its own transaction through the same core opener, calls the building block, then runs its swap step, including the scoped widening, in that transaction. | One lock and one transaction, as today. Core holds no hook. The swap step, `SwapCapture` and the models live where ADR `0023:10-11` puts them. No-swap callers change only an import path.                                                     | The row-counting swap test's patch moves from `app.want_list.connect` to the module that opens the swap transaction. That is a patch-string change, which ADR `0023:22` allows. Two public capture entry points.                |
| **B. Core capture takes an in-transaction step.** `capture_want_list(..., *, also=None)` runs `also(conn, ...)` under the lock and returns its result opaquely. Pokémon passes its swap step.                                                                                                                                                                                                                   | One entry point. The `connect` patch site stays where it is.                                                                                                                                                                                 | A callback slot is a small plugin point. `None` as a default is close to the "no default" rule ADR `0023:10` sets. The result type is opaque to core, so typing weakens.                                                       |
| **C. Keep `swaps=True` in core and pass the Reprint Group SQL in.**                                                                                                                                                                                                                                                                                                                                | Smallest diff.                                                                                                                                                                                                                                | `SwapHint`, Reprint Group ordering rules and hint models stay in core with Pokémon meaning. Core would need the SQL as a required argument on every call, including no-swap callers.                                            |

All three move `edition_needs`, `combined`, the no-swap capture and `deck_switch_candidates` to core, retarget the
three social import pins one for one, and keep the digest pins, the "no extra catalog read for ordinary consumers"
rule and the OpenAPI and route snapshots byte-identical. In all three, `deck_switch_candidates` keeps its
availability read as contract SQL in core, because `FACTS` names no game relation. That part needs no game argument.

**Recommendation:** A. It is the only option where core gains no hook and the Pokémon route visibly composes its own
transaction, which is ADR 0023's model. Pydantic models move with the route, class names unchanged.

**Questions for Ryan.**

- **Q-A1.** Choose A, B or C for the capture shape.
- **Q-A2.** Do `WantListLine`, `WantListSection` and `WantList` move whole to the Pokémon route, with a Riftbound Want
  List defining its own models at spec phase 7? The alternative keeps hint-free core models and has Pokémon add the
  `swap` field, which risks OpenAPI component churn.
- **Q-A3.** Confirm that "may start a new Deck List line" (`trade_wants.py:38-41`, `swap_hints.py:94-97`) is a core
  rule. If it is, Deck switches need no game input.

### 2b. Reprint Group composition (#529, R7, seam slice 7)

**Evidence.**

- Only two shared modules read Reprint Groups. In `swap_hints.py`, `GROUPS` and `MEMBERS` (`:63-82`) do. In
  `social/friend_reads.py`, the `REACH` arm gated by `%(group)s` (`:91-103`) does. The other files that name the relation
  are all under `games/pokemon/`.
- `social/trade_matches.py` names no Reprint Group relation. It is `mixed` (`python_module_owners.txt:46`) through its
  imports: `want_list` (`:89`) and three `friend_reads` names (`:96`). Its Will accept expansion uses only
  `card_accepts`' `printing` and `identity` rules (`:436`, `:573`, `:593`).
- `card_accepts.accepts` reads only `catalog_edition` and `catalog_printing` by `identity_id`
  (`api/app/card_accepts.py:24-37`). It is already contract-only SQL, which #529's audit is confirming.
- Today's seams already take equivalence as data. `friend_reads.matches(conn, user_id, reached)` receives a precomputed
  reach map (`friend_reads.py:213`), and `swap_hints.hints(capture, decks, order)` is pure over a captured
  `SwapCapture` (`swap_hints.py:171-237`). The SQL that builds those inputs is the Pokémon part.
- The choke point holds no equivalence SQL. `friend_copies` imports allocation, counts and its own SQL only
  (`social/friend_copies.py:60-68`). ADR 0015 keeps every cross-collector inventory read there (`0015:11-12`).
- Reprint Group vocabulary is in the API. The `printings` query parameter is `Literal['exact', 'reprint_group']`,
  defaulting to `reprint_group` (`friend_reads.py:57`, `:132`, `:264`), and is pinned in
  `api/tests/api_contract/openapi.json:1845`, `:2172`.
- The catalog contract lists `catalog_reprint_group_member` as a consumed relation (`catalog-data-contract.md:129-130`),
  so as written it asks a second game to supply that relation.
- **Riftbound on day one.** The spec keeps Reprint Group a Pokémon term (`spec.md:176`). It lists "card attributes and
  Reprint Groups" among the code that needs a Riftbound counterpart (`spec.md:304`), without saying what equivalence
  means there. Riftbound's alternate-art, overnumbered and signature cards are separate Printings with stripped names
  (`spec.md:190-192`), so Will accept's `identity` rule may already cover "any version of this card", but that depends on
  the Riftbound meaning of Card Identity, which the spec defers to its phase 7 (`spec.md:175`). #534 requires ReprintRules
  extraction "only where the approved game demonstrates that need".

**Options.**

| Option                                                                                                                                                                                                                                                                                                                                                                                                                                     | For                                                                                                                                                                                                                                                                                                                                                                                   | Against                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Empty relation.** Riftbound's track creates an empty `catalog_reprint_group_member`, and shared SQL runs unchanged.                                                                                                                                                                                                                                                                                                                         | No extraction. Matches today's contract wording.                                                                                                                                                                                                                                                                                                                                          | Puts a Pokémon term in Riftbound's schema against `spec.md:176`. The four mixed modules stay mixed, so R7's goal is never met. Riftbound's API would expose `printings=reprint_group` meaning nothing.                                                                                      |
| **B. Required SQL fragment.** Core holds `REACH` and the hint read with an equivalence fragment as a keyword-only argument with no default. Each game's router passes its fragment.                                                                                                                                                                                                                                                                 | One shared statement. Follows ADR `0023:10` literally.                                                                                                                                                                                                                                                                                                                                      | A SQL-fragment contract (columns, keys, bounds) has to be specified and tested for each game. Fragments are harder to review than data.                                                                                                                                                       |
| **C. Equivalence as data.** The game reads equivalence itself, with its own SQL in `games/<game>/`, and passes the result to core as two named payloads, defined below the table. Core keeps `matches`, `hints`, ranking, ties, need folds and Will accept expansion. Routers that name `printings` move whole to `games/pokemon/social/`, and `trade_matches` may become core by retargeting imports once slice 6 and the `friend_reads` split land. | Uses seams that already exist (`friend_reads.py:213`, `swap_hints.py:171`). Equivalence reads are already their own statements, so the number of round trips doesn't change. The choke point is untouched: equivalence is catalog-only. A game with no equivalence still gets today's `exact` and today's no-group hint behaviour, as defined below. Bounds stay keyed by the wanted Editions. | Router moves need the six caller scans in tooling first (F7), every new `social` directory added to `SOCIAL_PACKAGES` (`python_architecture_rules.py:14`), and byte-identical snapshots. More files move than in B. Two payloads to specify, not one. |
| **D. Defer.** Do none of it until a Riftbound slice mounts Friend reads, Trade matches or the Want List.                                                                                                                                                                                                                                                                                                                                           | Follows #534's "only where the approved game demonstrates that need". RB-1 doesn't need it. #529's characterization tests still land and pin behaviour for whichever shape comes later.                                                                                                                                                                                                         | R7 and the `mixed` lines stay open. A later social slice carries the extraction on its critical path.                                                                                                                                                                                       |

**Option C's payloads.** Friend reads and Swap hints fall back differently today, so C names one payload for each.
Neither fallback is "the Edition itself".

1. **Friend reach map**, for the Collection and card-popup reads. Its type is
   `dict[wanted Edition id, dict[reached Edition id, other_printing bool]]`. That is the shape `reach()` returns today
   (`friend_reads.py:106-116`) and `matches` takes (`:213`). With no equivalence, each wanted Edition reaches **every
   Edition of its own Card Printing**, all with `other_printing=False`. That is today's `exact`: the original Printing's
   row joined to all its Editions (`friend_reads.py:92-103`, docstring `:25-29`). Another finish of the same Printing
   is the same card under `exact` (`api/tests/test_friend_matches.py:174-176`). With Pokémon's Reprint Groups, it also
   reaches the other Printings' Editions with `other_printing=True` (`:170-173`). The Want List Friend matches read
   builds its map from Will accept, not from Reprint Groups (`friend_reads.py:246-258`), and is unchanged.
2. **Hint group rows**, for the Swap hint capture. These are the `GroupEdition` rows keyed by Edition id, each with its
   `group_id` (`swap_hints.py:116-126`, `:159`), which core's `hints` groups (`:184-187`). With no equivalence, the game
   passes **no group rows**. A Printing in no group then gets **no hint**, not even for another finish of its own
   Printing (`swap_hints.py:32-33`; `api/tests/test_want_list_swap.py:217-229`).

**Will accept stays in core, separate from equivalence.** `card_accepts.accepts` widens hints to the Editions a
`printing` or `identity` rule accepts, even for a Printing in no group (`swap_hints.py:35-42`, `:153-163`;
`api/tests/test_want_list_swap_will_accept.py:52-63`). No game payload replaces it.

**Exact-Edition semantics for Riftbound would be a new choice, not today's `exact`.** A Riftbound Friend read where a
wanted Edition reaches only that Edition, with no other finish, would change what `exact` means. It is offered only as
Q-B5.

**Acceptance for the C extraction, when it is built,** on top of #529's criteria:

- The Friend reach map regressions pass unchanged: `test_friend_matches.py:170-176`, covering other Printings of the
  group and every finish under `exact`.
- The no-group hint regression passes unchanged: `test_want_list_swap.py:217-229`, under both counting settings.
- Will accept widening of an ungrouped Printing passes unchanged: `test_want_list_swap_will_accept.py:52-63`.
- The tests #563 lists for #529 still pass (`test_friend_matches.py:183`, `test_trade_matches.py:478`, `:505`).
- `friend_copies` stays the only multi-collector inventory reader. Equivalence reads stay keyed by the wanted Editions,
  and the OpenAPI and route snapshots stay byte-identical.

**Recommendation:** D for timing and C for shape. Land #529's characterization and audit now, and leave equivalence in
Pokémon until the first Riftbound social slice. Then do C. Unless Ryan approves a Riftbound equivalence, Riftbound
passes the no-equivalence payloads above: same-Printing, all-Editions reach and no hint group rows. Reject A as a
permanent design. Remove `catalog_reprint_group_member` from the contract's
consumed list when C lands. That amends the contract, a doc change to make with C. This shrinks the work for RB-1 to zero.

**Questions for Ryan.**

- **Q-B1.** Does Riftbound need any card equivalence beyond Will accept's `printing` and `identity` rules, on day one or
  ever? If the answer is "not now", R7 leaves RB-1's critical path.
- **Q-B2.** Choose C, B or A for the shape when it is built, and D (defer) or "now" for the timing.
- **Q-B3.** Should a Riftbound Friend read take a `printings` parameter at all? If not, the Pokémon `printings` value set
  stays Pokémon's, and Riftbound's router shape is its own API decision.
- **Q-B4.** _Proposed ADR or contract amendment:_ remove `catalog_reprint_group_member` from the shared catalog
  contract once no shared module reads it.
- **Q-B5.** _Separately proposed, not today's behaviour:_ should a Riftbound Friend read reach only the wanted Edition
  (exact-Edition semantics), rather than every Edition of its Printing? A yes is a Riftbound API choice of its own.

### 2c. Identity, auth and migration (#564)

#564's IM items are not reopened here. Under RB-1, they split like this:

| When needed                           | IM items                               | Why                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Blocks RB-1**                       | IM-11, IM-12, IM-13                    | A Riftbound database needs its own track, an entry that selects it and a core baseline (H3, H4). Slices S3 and S10. #564 notes S10 depends on S3 only.                                                                                                                                                                                                                                                                     |
| **Blocks RB-1**                       | IM-14                                  | Same server or not, and whether tests stay co-located (H5).                                                                                                                                                                                                                                                                                                                                                               |
| **Blocks RB-1**                       | IM-6                                   | A second backend verifying gateway signatures needs its secret decided (H6).                                                                                                                                                                                                                                                                                                                                             |
| **Blocks RB-1 if it has owner routes** | IM-7, and IM-1 through S2              | Catalog import review is an owner screen. Under IM-7's recommendation (a local owner replica), the replica arrives in S6, which #564 orders after S5's feed. Unless Ryan approves an interim, RB-1's owner routes wait for S2, S5 and S6.                                                                                                                                                                                  |
| **Blocks RB-1 if it creates owner rows** | IM-5, IM-17 (first touch)            | Today `"user"` inserts create `inventory_owner` by trigger in one database. A Riftbound database receives no such insert. RB-1 as defined needs no collector inventory, so it can avoid this.                                                                                                                                                                                                                            |
| **Before any Riftbound social slice** | IM-3, IM-4, IM-16, plus IM-5 and IM-17 | Shared Handles and Display Names, the feed and the mirror. F11 joins here.                                                                                                                                                                                                                                                                                                                                                |
| **Before a Riftbound operations panel** | IM-2                                 | Gateway counters in a second panel.                                                                                                                                                                                                                                                                                                                                                                                      |
| **Before launch, not RB-1**           | IM-8, IM-9, IM-10, IM-18               | Account deletion across games. IM-8 asks whether deletion must exist before a second game launches.                                                                                                                                                                                                                                                                                                                      |
| **Before an auth split, not RB-1**    | IM-15, S4, S7 to S9                    | RB-1 can leave sign-in in the Pokémon database, co-located as S4's default allows, and never read auth tables. A cutover is only needed when auth moves out.                                                                                                                                                                                                                                                             |

**Questions for Ryan.**

- **Q-C1.** Decide IM-6, IM-7, IM-11 to IM-14 before the rest, since they are the ones RB-1 waits on.
- **Q-C2.** Does RB-1 include owner routes? If yes, choose between waiting for S6 and approving an interim for a
  Riftbound database with no collectors. Any interim is a security decision, so it needs its own review and is not
  designed here.
- **Q-C3.** May RB-1 run with sign-in left in the Pokémon database, so the auth split (S4, S7 to S9, IM-15) waits for
  social slices?

### 2d. Second-game architecture

#563's D1 (scope), D3 (data gate) and D4 (catalog shape) and ADR `0023:12`, `:24` stand. These are the composition
questions that neither #563 nor #564 answers:

- **Q-D1. Who chooses the game, `main.py` or the service entry?** ADR `0023:12` says `main.py` chooses which game's app
  to mount. IM-12 recommends a per-game entry chosen by the service's command. Today `main.py` also holds game-free
  pieces: health (`:36-38`), the lifespan runner (`:20-30`), the operation counter writer (`:46`) and the counting
  middleware (`:49-63`).

  | Option                                                                                                                       | For                                                                                                       | Against                                                                                                         |
  | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
  | A. Extract those pieces into a core app builder that takes routers and hooks. `app.main:app` stays Pokémon. A Riftbound entry calls the same builder | Extracts only existing game-free code. No variable. `api.Dockerfile:34` and the snapshot test are unchanged | Its wording departs from ADR `0023:12`, so it needs an ADR amendment                                            |
  | B. Copy `main.py` per game                                                                                                   | No core change                                                                                            | Two copies of middleware and lifespan code drift                                                                 |
  | C. One process mounts both apps under path prefixes                                                                         | One container                                                                                             | `app.db.connect` reads one `DATABASE_URL` (`db.py:8-9`), so separate databases need new plumbing. Breaks isolation |

  **Recommendation:** A, recorded as a _proposed ADR amendment_ to ADR 0023, alongside IM-12's track entries.

  If Ryan picks A, #563's wording that `main.py` chooses the game (`backend-readiness.md:33` A6, `:186` R13) would be
  superseded together with that ADR 0023 amendment. #563's R13 already names one entry per game as an ADR amendment for
  Ryan. This is a proposal, and #563 is not edited here.

- **Q-D2. Which core-owned routers does a Riftbound app mount, in what order?** Pokémon's `ROUTERS` interleaves core and
  Pokémon routers in one order (`games/pokemon/app.py:67-89`). Riftbound needs its own tuple, its own OpenAPI and route
  snapshots, and a test like `api/tests/test_api_contract.py:21-27` for its app. **Recommendation:** RB-1 mounts the
  smallest set its catalog needs, each router added later with its snapshot. Mixed routers such as `friend_reads` stay out
  until 2b is done.
- **Q-D3. Where does the Riftbound OpenAPI go, and is a client generated?** One generated web client follows one
  document today. This overlaps #532 and is listed so it isn't lost. **Recommendation:** check a Riftbound snapshot in with
  RB-1, and generate no client until #532 decides.
- **Q-D4. Jobs and entry points.** Pokémon's dotted-path entries (`app.catalog_import`, `app.catalog_refresh`,
  `app.price_runner`, `app.host_readiness`, ADR `0023:13`) and its startup hooks, `start_rule_rollout` and
  `rebuild_format_standing` (`games/pokemon/app.py:92`), are Pokémon's. **Recommendation:** Riftbound jobs live under
  `games/riftbound/` as their own `-m` entries, with no root shims, since nothing old names them.
- **Q-D5. Boundary checker coverage.** The game-to-game fixture covers Pokémon importing Riftbound only
  (`tests/tooling/test_python_boundaries.py:55-58`). **Recommendation:** add the reverse fixture, and an owners rule for
  `games/riftbound`, in RB-1's first change. That is mechanical.

## 3. Safe work before the decisions, in dependency order

Each item is settled now and needs the usual review and Ryan's approval to merge. None touches identity, migrations,
API shapes or Riftbound code.

| Order | Item                                                                                                                                         | Depends on        | Owner today        |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------ |
| 1     | R3 `api_errors` shim; seam slice 4 Location path reader                                                                                      | None              | In progress, #528  |
| 2     | R4 and seam slice 5: six caller scans to tooling with planted violations                                                                     | None              | In progress, #528  |
| 3     | #529 characterization tests and the `card_accepts` audit                                                                                     | None              | In progress, #529  |
| 4     | R1 contract path and `catalog_attribute_state` in the schema test                                                                            | None              | Not started        |
| 5     | R2 (H11) Borrowed gallery into Pokémon's `ROUTERS`, snapshots byte-identical                                                                 | None              | Not started        |
| 6     | R12a (H9) synthetic reader probes against today's shared readers                                                                             | 4                 | Not started        |
| 7     | Q-D5's reverse game-to-game fixture                                                                                                          | None              | Not started        |
| 8 | Move `edition_needs` alone to core beside `needs.py`. Retarget its one social pin, `app.social.trade_matches -> app.want_list.edition_needs` (`python_architecture_rules.py:71`), and its two callers (`social/trade_matches.py:89`, `games/pokemon/trading/trade_inventory.py:36`) | None | Not started |
| 9     | IM-1's checker widening (S1), if Ryan answers #564's IM-1 question yes. It changes no runtime file                                           | Ryan's IM-1 answer | Not started        |

Item 8 is safe because `edition_needs` (`want_list.py:224-236`) reads only core-owned modules (`settings`,
`copy_allocation`, `core/decks/needs.py`) and takes no capture type. `combined` stays with the 2a split: it takes
`WantListCapture` (`want_list.py:211`), which still holds the mixed `SwapCapture` (`:153`), so moving it now would make
core import a mixed module. If Ryan wants slice 6 reviewed as one unit, drop item 8.

**What each decision unblocks:**

| Decision                     | Unblocks                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| D1 with the RB-1 definition  | R12b, all Riftbound slice planning, and the #534 amendment                                       |
| D4                           | R12b's schema, the contract's write-side clauses and part of the core baseline (H4)              |
| D3 accepted, then the gate passing | R13, real ingestion and release, plus Riftbound art and prices. RB-1 and R12c stay synthetic and don't wait on it unless Ryan answers Q-G1 yes |
| IM-11, IM-12, IM-13          | S3, then S10: a fresh Riftbound database                                                         |
| IM-6, IM-14                  | A second backend process that verifies signed requests                                           |
| IM-7 with Q-C2               | Owner routes on Riftbound                                                                        |
| Q-D1                         | The Riftbound entry, its snapshot test, compose service and Dockerfile command                   |
| 2a                           | Seam slice 6, then a Riftbound Want List, and the `trade_matches` part of slice 7                |
| 2b                           | Seam slice 7 and R7, then Riftbound Friend reads and Trade matches                               |
| IM-3, IM-4, IM-5, IM-16, IM-17 | Any Riftbound social slice                                                                     |

## Proposed ADR-worthy items

None is accepted. Each needs Ryan's decision recorded in an ADR before work starts:

1. Riftbound backend scope and the RB-1 definition (#563 D1).
2. An amendment to ADR 0023's composition wording for per-game entries and a core app builder (Q-D1, with IM-12). If
   adopted, it supersedes #563's A6 and R13 wording that `main.py` chooses the game.
3. The migration tracks ADR that #564 already proposes (IM-11 to IM-13).
4. Removing Reprint Group membership from the shared catalog contract, when 2b's option C lands (Q-B4).

## Not verified

- No database, API or browser test ran. Line references were read, not executed.
- The Riftbound spec's data claims are from 2026-10-29 on one group and are hypotheses.
- Whether Riftbound's Card Identity groups alternate-art, overnumbered and signature Printings is unconfirmed. Q-B1
  depends on it.
- Work in progress by other workers was not inspected beyond `dev`.
