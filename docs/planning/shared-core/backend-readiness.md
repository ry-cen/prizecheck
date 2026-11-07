# Backend readiness plan

**Status:** audit of `dev` at `434f5b7a` on 2026-11-07, for [#528](https://github.com/ry-cen/prizecheck/issues/528), [#529](https://github.com/ry-cen/prizecheck/issues/529), [#531](https://github.com/ry-cen/prizecheck/issues/531), [#533](https://github.com/ry-cen/prizecheck/issues/533) and [#534](https://github.com/ry-cen/prizecheck/issues/534). It authorizes no implementation, migration or deployment. Line references are to that commit.

**Measured against:** [ADR 0023](../../adr/0023-split-core-and-games-by-composition.md), the [catalog data contract](catalog-data-contract.md) and `scripts/python_module_owners.txt`. The tree is the evidence. Open pull requests #549 to #560 were superseded by #562 and are not counted. The Riftbound spec (`git show origin/riftbound:docs/planning/riftbound/spec.md`) gives constraints only. Where it asks for a `GAME` setting, a registry or interfaces that a game implements, ADR 0023 wins.

**Companion:** [Riftbound catalog acceptance](riftbound-catalog-acceptance.md) holds the synthetic cases that run before any real ingestion.

**Parallel tracks.** The identity and migration decision package owns #531 and #533. This plan lists their gaps and designs nothing for them. A separate track audits the matching and inventory seams and picks the slices, so this plan states that area's gap at plan level only. [#530](https://github.com/ry-cen/prizecheck/issues/530) found no useful Card Reports extraction ([assessment](card-reports-assessment.md)) and is not reopened.

**Status words.** Completed: the tree meets the requirement. Partial: some of it does, and the gap is named. Remaining: not started.

## Conclusion

The import boundary is finished for what exists. `scripts/check_python_boundaries.py` exits 0 on this tree, `[edges]` in `scripts/python_boundary_allowlist.txt` is empty, and no core module imports a game, a root module or a mixed module.

That boundary is no longer what stands between this tree and a second backend:

1. **Module location blocks nothing.** The checker forbids core reaching a game or a root module, and one game reaching another. It does not forbid a game importing a core-owned module that still sits at `app.<name>`. A `games/riftbound` package could import `app.location_tree` today. The remaining #528 moves are tidiness, not readiness, and most of them can wait.
2. **SQL is the real coupling.** `swap_hints` and `social.friend_reads` read the Pokémon-only `catalog_reprint_group_member`. The Friend reads router fails where that relation is missing, and `social.trade_matches` imports it (R7).
3. **The catalog schema has Pokémon write constraints.** The contract lists consumed columns, so it does not show that `catalog_printing.source` allows only `tcgdex` and `manual`, or that `catalog_generation_printing.basic_energy` is a required Pokémon column. Under today's constraints a Printing cannot record TCGCSV as its source or carry a TCGCSV source key (`migrations/003_catalog.sql:33-38`, `:68`).
4. **Four approvals are missing.** Product scope, the identity and migration decisions, the catalog shape, and data rights. No code can stand in for them.

## Audit: ADR 0023

| ID | Requirement | Status | Evidence | Gap |
| --- | --- | --- | --- | --- |
| A1 | Core never imports a game, a root module or a mixed module (`0023:9`) | Completed | Checker exit 0. Core's non-core imports are only core-owned modules: `api/app/core/decks/contents.py`, `core/inventory/holdings.py` and others reach `app.db`, `app.identity`, `app.location_tree`, `app.social.counts`. | None. |
| A2 | Core holds no game literals (`0023:9`) | Partial | `api/app/core/prices/cost.py:37`, `:52` default `currency` to `'USD'`. `api/app/social/name_rules.py:33-35` reserves `pokemon`, `nintendo`, `tcgplayer`, `thepokemoncompany`. `api/app/social/threads.py:373-377` maps `normal`, `holo` and `reverse` to labels. | Three literal sites remain (R5, R6). ADR `0023:23` expects some until their package lands. |
| A3 | A core function needing a game value takes a keyword-only parameter with no default (`0023:10`) | Partial | Done for art (`core/art/store.py:75`, `:230`), quotes (`core/prices/quote_contract.py:565`), the runner (`core/prices/runner.py:134`), Collection (`core/inventory/collection.py:124`, `:210`) and publishing (`core/publications/publish.py:118`). | The `cost.py` model default in A2 is the one exception found. |
| A4 | A route that needs a Pokémon value moves whole to the game (`0023:11`) | Partial | Done for Decks, Collection, the Borrowed gallery, publishing and imports. `api/app/social/friend_reads.py` and `api/app/social/trade_matches.py` keep routers in `mixed` modules. | Matching track (R7). |
| A5 | `main.py` mounts the Pokémon app: `ROUTERS` and `LIFESPAN_HOOKS` (`0023:12`) | Partial | `api/app/main.py:13`, `:43-44`, but `api/app/main.py:9`, `:41` also import and mount the Borrowed gallery router outside `ROUTERS`. | A second mount would have to edit around a Pokémon router (R2). |
| A6 | `main.py` chooses which game to mount, with no `GAME` setting and no registry (`0023:12`) | Remaining | One game is hard-wired at `api/app/main.py:13`. No mechanism exists, and any choice inside one module needs an input the ADR rejects. | Decision D5. |
| A7 | No registry, no `GAME` setting, no protocols (`0023:12`) | Completed | `games/pokemon/app.py:67-95` is plain tuples. The Riftbound spec's `GAME` setting and interface list are obsolete. | None. |
| A8 | Root shims only for named entry points and old import names (`0023:13`) | Partial | `app.catalog_import`, `catalog_refresh`, `catalog_targets`, `public_catalog`, `public_prices`, `price_runner`, `quote_contract` and `host_readiness` are thin. `api/app/api_errors.py` remains for one caller, `api/app/location_tree.py:10`. | `host_readiness.py:24` holds identity SQL (#531 gap). `api_errors` can go (R3). |
| A9 | Phasing: Now packages (`0023:14`) | Completed | Split-map section 10 records WP-S1 to WP-D2. The owners file has no `pokemon` line left outside `games/`. | None. |
| A10 | Phasing: Later packages (`0023:14`) | Partial | Pure-module moves are part done (see Module owners). `host_readiness` is composed: `core/ops/readiness.py` and `games/pokemon/ops/readiness.py`. | Reprint rules, migration tracks and identity remain. |
| A11 | `/api` paths, shapes and router order unchanged, proved by snapshots (`0023:15`) | Completed | `api/tests/test_api_contract.py:22-27` against `api/tests/api_contract/`. Not rerun for this audit. | None. |
| A12 | The boundary is checked and the allow-list only shrinks (`0023:16`) | Completed | `[edges]` is empty and seven `[sql]` lines remain (Identity gaps). | None. |
| A13 | A second game provides relations with these names and shapes, or a later phase puts a contract in front (`0023:23`) | Remaining | The contract says it "defines neither an adapter nor a schema for another game" (`catalog-data-contract.md:6`). | Decision D4. |
| A14 | Migrations are not split until the second game (`0023:25`) | Remaining | One flat `migrations/` directory. | #531 (parallel track). |

## Audit: catalog data contract

| ID | Item | Status | Evidence | Gap |
| --- | --- | --- | --- | --- |
| C1 | Inventory matches the tree | Completed | A scan of the 75 core and mixed modules found catalog relations only in the sources the contract lists. New Trade and Loan code reads catalog facts through `card_facts`. | None. |
| C2 | Contract paths are current | Partial | The table headed "Source under `api/app/`" still says `holdings.py` (`catalog-data-contract.md:25`). The file is `core/inventory/holdings.py`. | R1. |
| C3 | Schema test covers each relation | Partial | `api/tests/test_catalog_data_contract.py:78-104` omits `catalog_attribute_state`, which the contract requires (`catalog-data-contract.md:55`). | R1. |
| C4 | Real shared readers are exercised | Partial | The test runs `CARD_FACTS`, `card_facts`, `Card.order`, `AVAILABLE`, `accepts`, `resolve` and Deck capture (`api/tests/test_catalog_data_contract.py:117-247`). Holdings and Collection rest on separate suites, as the contract says. | Accepted limit. Riftbound-shaped coverage is the acceptance spec. |
| C5 | Write-side requirements | Remaining | Contract columns are consumed columns only. Unlisted requirements include `catalog_printing.source` and its pairing check (`migrations/003_catalog.sql:33`, `:38`), `identity_key` (`:28`), `descriptor_key` (`:43`), and `basic_energy` and `source_fingerprint` in generation rows (`:67-68`). | Decision D4. Blocks a Printing that records its TCGCSV source. |
| C6 | Second-game contract | Remaining | Ruled out of scope by the contract itself (`catalog-data-contract.md:6`, `:159`). | Decision D4. |
| C7 | Set-code view has a row for every Printing | Partial | The contract calls this essential (`catalog-data-contract.md:62`). Design brief lines 810-811 say no Riftbound filling is planned, which holds for `catalog_set_code` but not for the view that core inner joins. | Case RB-REF-03 pins this. |
| C8 | Generation promotion is reusable | Remaining | It exists only in `api/app/games/pokemon/catalog/catalog.py:605-790` and includes Pokémon steps at `:777-783`. | Do not extract now: ADR `0023:12` says invent nothing for a second game. Revisit at slice planning under #534. |

## Audit: module owners

`scripts/python_module_owners.txt` matches the tree: the checker fails otherwise. Eleven #527 and #528 modules have moved into core with their rows removed: `api_errors` (a shim stays), `bounded_work`, `idempotency`, `locations`, `operation_counts`, `deck_list_capture`, `price_reads`, `moves`, `art_storage`, `price_budget` and `holdings`.

What still sits at the root, grouped by what governs it:

| Group | Modules (lines) | Status | Governed by |
| --- | --- | --- | --- |
| Matching | `card_accepts` (48, `core`), `want_list` (318, `mixed`), `swap_hints` (247, `mixed`), `social.friend_reads` (274, `mixed`), `social.trade_matches` (878, `mixed`) | Remaining | #529, matching track |
| Inventory | `inventory_core` (166), `location_tree` (493), `copy_allocation` (516), `borrowed_copies` (67), `copy_picks` (50), `deck_pick_list` (338), `deck_deletion` (133), `loan_inventory` (1,433), `loan_picks` (52), `trade_list` (197), `trade_picks` (132), `settings` (79) | Remaining | #528, inventory track |
| Social | `social.conversations`, `friends`, `loans`, `threads`, `trades` (3,544, one import cycle), `social.discovery`, `friend_copies`, `hidden_locations`, `inbox`, `name_rules`, `owners`, `profile`, `reports`, `counts` | Remaining | #528 scan port first (R4) |
| Prices | `price_launcher` (356), `price_refresh` (681) | Remaining: removal, not a move | [#356](https://github.com/ry-cen/prizecheck/issues/356) removes them; #528 excludes them |
| Public records | `public_projection` (248), `public_records` (1,055, one import cycle) | Remaining | After #356, which changes quote records |
| Identity-bearing | `operations` (81), `identity` (39) | Remaining | #531: SQL exceptions |
| Base | `db` (9), `api_errors` (2) | Partial | R3 for `api_errors`. Moving `db` touches 60 importers for no readiness gain. |

Two facts shape any batching. A strongly connected scan of these modules finds two cycles: the five `social` modules above, and `public_projection` with `public_records`. Each must move as a unit. Everything else can move in any order, because core may import a core-owned root module; `holdings` moved while `inventory_core` stayed.

## Audit: issue acceptance criteria

### #528 relocate remaining game-free root modules

| Criterion | Status | Evidence and gap |
| --- | --- | --- |
| Verify `inventory_core`, Holdings, moves and locations | Partial | Holdings, moves and locations are in `core/inventory/`. `inventory_core.py` is not: its only non-core import is `app.social.counts`. Inventory track. |
| Keep operations identity SQL a separate decision | Completed | `api/app/operations.py:75-76` unchanged and still allow-listed. |
| Preserve the six caller scans before social or `trade_list` moves | Remaining | `api/tests/test_social_contract.py:50-67` keys them on `social/…` and `trade_list.py` paths. No planted-violation test exists for them under `tests/tooling`. R4. |
| Update owners, paths, docs and pins without weakening them | Partial | Met for every landed batch: owners and pins match, and split-map section 10 dates each one. Applies again to each later batch. |
| Coordinate with #478 and #356 | Partial | #478 landed through #562 but stays open until `main`, and `location_tree.py` was reserved for it. Decision D6. #356 is open. |
| Each batch has focused validation and independent review | Partial | The issue records this for two batches. Later moves landed together in #562, with validation on the combination. |

### #529 complete ReprintRules composition

| Criterion | Status | Evidence and gap |
| --- | --- | --- |
| Characterize acceptance, equivalence, quantities, ranking, ties and privacy | Remaining | Matching track. |
| Pokémon supplies policy; core has no Pokémon SQL or defaults | Remaining | `api/app/swap_hints.py:64`, `:76` and `api/app/social/friend_reads.py:98-99` read `catalog_reprint_group_member`. |
| Audit `card_accepts` | Partial | `api/app/card_accepts.py:24-37` reads only contract relations through `identity_id`, so its SQL is game-free. Whether its three rules are reusable policy has not been judged. Matching track. |
| Preserve the choke point, bounds, ordering and snapshots | Remaining | Nothing has been extracted yet. |

### #531 decide identity, migration tracks and baseline

All four criteria are Remaining here and owned by the parallel track.

Gaps it must close, listed only as gaps: the seven `[sql]` exceptions in `scripts/python_boundary_allowlist.txt`.

| Module | Identity table | Evidence |
| --- | --- | --- |
| `app.host_readiness` | `owner_binding` | `api/app/host_readiness.py:24` |
| `app.host_readiness` | `user` | `api/app/host_readiness.py:30` |
| `app.identity` | `owner_binding` | `api/app/identity.py:37` |
| `app.operations` | `auth_rate_event` | `api/app/operations.py:76` |
| `app.operations` | `auth_send_event` | `api/app/operations.py:75` |
| `app.games.pokemon.catalog.rule_rollout` | `owner_binding` | `api/app/games/pokemon/catalog/rule_rollout.py:186`, `:426` |
| `app.social.profile` | `released_handle` | `api/app/social/profile.py:255-263` |

Findings from this audit that its baseline will meet, offered as inputs and not as design:

- `deck_list.target_format` is a Pokémon column in a core table: `DEFAULT 'standard'` and `CHECK` on three Pokémon Formats (`migrations/045_deck_list_target_format.sql:14`, `:21`).
- Decision D4 decides whether catalog migrations belong in a shared baseline, so D4 and #531 cannot close separately.
- Handles are shared across games, so `RESERVED` in `api/app/social/name_rules.py:31` is an identity question too.

### #533 implement approved identity and migration slices

All three criteria are Remaining. The issue is blocked by #531 and Ryan's approval. Nothing here can start.

### #534 integrate an approved second game

| Criterion | Status | Evidence and gap |
| --- | --- | --- |
| Record approval of scope, catalog contract, data sources and collector flows | Remaining | Riftbound is the intended second backend game. ADR 0022 is `proposed`, exists only on the paused `riftbound` branch and is not on `dev`. No approval is recorded. Decision D1. |
| Link identity, migration and client routing decisions, then split into slices | Remaining | Blocked by #531 and #532. Frontend work is deferred, which conflicts with #532 being a blocker. Decision D1. |
| Prove separate policy, sign-in and data isolation, and unchanged Pokémon behaviour | Remaining | Needs a built game. The synthetic cases are a precondition, not this proof: the issue requires real approved requirements. |

## Remaining work, in dependency order

Kind is **Mechanical** when the requirement is settled, or **Decision** when someone must choose first. Mechanical work still needs the usual review and Ryan's approval to merge. The Ryan column means a decision from Ryan before the work starts.

| Order | Item | Issue | Depends on | Kind | Ryan |
| --- | --- | --- | --- | --- | --- |
| 1 | R1 Contract drift and schema test gap | #520 follow-up | None | Mechanical | No |
| 2 | R2 Mount the Borrowed gallery from the Pokémon app | #534 prep | None | Mechanical | No |
| 3 | D1, D3, D4, D5 Approvals | #534 | Evidence in this plan | Decision | **Yes** |
| 4 | D2 Identity and migration package | #531 | Parallel track | Decision | **Yes** |
| 5 | D6 Lift the #478 reservation | #528 | #562 on `dev` | Decision | **Yes** |
| 6 | R3 Remove the `api_errors` shim | #528 | D6 | Mechanical | No |
| 7 | R4 Port six caller scans | #528 | D6 | Mechanical | No |
| 8 | R5 Currency literal in core cost | #528 | None | Decision | Only if OpenAPI changes |
| 9 | R6 Finish labels in core threads | #528 | D6 | Decision | No |
| 10 | R7 Matching seam | #529 | Matching track, D6 | Decision | Slice scope |
| 11 | R8 Inventory relocation | #528 | Inventory track, D6 | Mechanical | No |
| 12 | R9 Identity and migration slices | #533 | D2 | Mechanical once approved | **Yes** |
| 13 | R10 Retire the price runner | #356 | Production cutover plus 7 days | Mechanical | **Yes** (issue requires it) |
| 14 | R11 Public records and social moves | #528 | R4, R10 | Mechanical | No |
| 15 | R12 Run the synthetic catalog cases | #534 | D3 scope, D4 | Mechanical | No |
| 16 | R13 Riftbound backend slices | #534 | D1 to D5, R7, R9, R12 | Decision | **Yes** |

Items 1 and 2 can run now. R8 and R11 are not prerequisites for R13 and can be deferred without blocking Riftbound. Decision D7 asks whether to defer them.

### Acceptance criteria

**R1.** The contract names `core/inventory/holdings.py`. `required` in `test_catalog_data_contract.py` includes `catalog_attribute_state` (`singleton boolean`, `revision bigint`). No behaviour, snapshot or allow-list change.

**R2.** `api/app/main.py` imports nothing from `app.games.pokemon` except `app.games.pokemon.app`. The Borrowed gallery router leads `ROUTERS`. The route table snapshot and OpenAPI document stay byte-identical, and `npm run guardrails` passes.

**R3.** `location_tree.py` imports `app.core.ops.api_errors`. `api/app/api_errors.py` and its owners row are gone. A repository-wide scan, including patch strings, finds no old path.

**R4.** All six scans run as named rules in `scripts/python_architecture_rules.py`, or are otherwise independent of `app.social` paths, at least as strict as `test_social_contract.py:454-495`. Each has a planted-violation test in `tests/tooling`. Behaviour tests stay in `api/tests`.

**R5.** Core defines no default `'USD'`. The OpenAPI snapshot stays byte-identical. If that can't be met, stop and ask Ryan: a snapshot change is an API contract change.

**R6.** The finish-to-label mapping in `public_variant_label` comes from the game at the call site, or Ryan accepts it as shared display vocabulary. Trade and Loan event labels are unchanged for every existing descriptor.

**R7.** Set by the matching track. At plan level: no core-owned or shared module names `catalog_reprint_group_member`, the four `mixed` modules are reclassified, and `python_module_owners.txt` has no `mixed` line. Pokémon matching results are unchanged, as #529 lists. If R13 needs no social matching on Riftbound at first, D1 can shrink this.

**R8.** Set by the inventory track, within #528's exclusions.

**R9.** Set by the approved #531 package.

**R10.** As #356 lists. `app.price_launcher` and `app.price_refresh` leave the owners file by deletion, not relocation.

**R11.** Each cycle moves as one batch. Owners, pins and scans follow in the same change, with cursor bytes, OpenAPI and route order unchanged.

**R12.** Every case in [Riftbound catalog acceptance](riftbound-catalog-acceptance.md) has a recorded result on synthetic data. Each case that the spec marks as red under today's constraints either passes under the D4 outcome or carries a recorded decision.

**R13.** Set by #534 after approval. At minimum: the data gate in the companion spec is passed, Pokémon's OpenAPI and route snapshots are unchanged, and the checker forbids `games/riftbound` from reaching `games/pokemon`. The checker's existing game-to-game rule already covers this and needs a fixture for the new package.

## Decisions for Ryan

| ID | Decision | Why it matters | Recommendation |
| --- | --- | --- | --- |
| D1 | Approve Riftbound's backend scope, and may #534 go backend-first while #532 is deferred? | #534 forbids starting without recorded approval, and names #532 as a blocker while frontend work is deferred. | Record approval in a new ADR on `dev`. Amend #534 so #532 blocks only client-facing slices. |
| D2 | Identity and migration package | Everything game-facing depends on it. | Parallel track. |
| D3 | Accept the data-rights and coverage gate | Real content is blocked until it passes. | Adopt the gate in the companion spec as written. |
| D4 | Does a Riftbound database reuse catalog relation names and write constraints, or does a contract go in front? | Shared SQL names these relations. Today's constraints reject a Printing with a TCGCSV source. Must align with D2. | Reuse the names ADR `0023:23` already expects, and change only what the red cases prove. Add write-side clauses to the contract. |
| D5 | How does a container pick its game with no `GAME` setting? | `0023:12` says `main.py` chooses, but a choice in one module needs an input, and the rejected setting is that input. | One ASGI entry per game, chosen by the deployed command. Shared assembly takes the game's `ROUTERS` and `LIFESPAN_HOOKS` as arguments, once the second game exists. This amends the ADR's wording. |
| D6 | Is #478's reservation on Trade, social, pins and `location_tree.py` lifted now that #562 is on `dev`? | R3, R4, R6, R7, R8 and R11 all touch it. | Lift it, since the issue stays open only for the release. |
| D7 | Keep relocating root modules before Riftbound, or defer? | Location blocks nothing, and each batch costs review. | Defer R8 and R11 until a slice needs them. |

## Risks

- **Riftbound constraints are dated.** The spec's data checks are from 2026-10-29, on one group. They are hypotheses, not facts about the source.
- **#534's approval gate may reshape this order.** If D1 narrows scope to Collection without social features, R7 shrinks. If D1 is refused, R12 and R13 fall away while the rest stays useful clean-up.
- **The audit is static.** It read the tree and ran the import checker and module scans. It ran no database tests.
