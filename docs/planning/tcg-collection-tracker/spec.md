# Pokémon TCG Collection Tracker MVP

**Status:** complete

**Label:** ready-for-agent

## Problem Statement

Collectors need to know which physical Pokémon cards they own, how many copies they have, and where those copies are stored. A list that loses the distinction between a Card Printing and its physical Card Editions can overstate ownership. A virtual deck list can also claim copies that are still in a binder. Collectors need reliable inventory movement, useful basic Deck checks, and a way to share a Deck without exposing private Locations or the rest of their Collection.

The available catalog is incomplete. Images and variant classifications may be missing, and source data cannot establish every identity or legality rule. The product must show that uncertainty rather than silently assigning a physical variant, claiming tournament legality, or blocking all inventory entry. The owner needs a simple way to refresh the English catalog and review missing entries. The first deployment must fit the agreed low-idle-cost envelope while keeping data private and recoverable.

## Solution

Provide an English-only web application with three authenticated views: Locations, Collection, and Decks. Locations act like a physical file browser. A Storage Leaf contains fungible quantity Holdings for exact Card Editions; an Organizational Location contains children and no Holdings. A Deck is a specialized Storage Leaf, so moving copies into it moves physical inventory. Collection derives totals from all current Holdings. Collectors can Add, Move, and remove copies, with atomic unrestricted bulk Moves and short-lived Undo for Moves and Inventory Removals.

The app searches an owner-controlled local catalog populated by a manual full English TCGdex pull. Search shows source images when available, placeholders when absent, and the last successful pull time. Collectors can privately report missing English records; the owner can approve evidence-backed shared Catalog Overrides. Decks show basic 60-card and four-copy checks without claiming Standard legality. Owners can publish revocable, sanitized Deck snapshots as Unlisted or Listed pages.

The first production release is owner-only. The application uses React, TypeScript, and Vite, a Python/FastAPI API, PostgreSQL, and Better Auth email codes; deployment and service providers will be chosen later. Public signup opens only after a sending domain is verified and a real-recipient email test succeeds. Production releases are manual after CI. Backups, restores, usage warnings, and owner-visible operational status are part of the MVP.

## User Stories

1. As a new collector, I want an email code to create my account, so that I do not need a password.
2. As a returning collector, I want to sign in with a fresh email code, so that I can regain access to my private inventory.
3. As a collector, I want my browser to remain signed in while I use it, so that routine visits do not require repeated codes.
4. As a collector, I want to sign out, so that another person using my device cannot access my Collection.
5. As a collector following a protected link, I want to return to that page after signing in, so that I can continue my task.
6. As a collector, I want code requests and errors to protect whether an account exists, so that my email address is not exposed through the sign-in flow.
7. As a collector, I want invalid or expired codes rejected with clear retry guidance, so that I know how to recover.
8. As a collector, I want my Locations and Holdings isolated from other accounts, so that my physical storage stays private.
9. As the owner, I want the first deployment limited to my account, so that I can test it before inviting others.
10. As the owner, I want sensitive catalog identity approvals to require a fresh code, so that a long-lived session alone cannot make those changes.
11. As a collector, I want to search English card names by prefix, so that I can find the card in front of me.
12. As a collector, I want to search by set and collector number, so that I can distinguish similarly named Printings.
13. As a collector, I want each result to distinguish Card Printing and Card Edition, so that I record the physical version I own.
14. As a collector, I want uncertain variants labeled Unspecified Variant, so that I do not mistake an unknown finish for normal.
15. As a collector, I want images in search results and details when TCGdex provides them, so that I can recognize a Printing.
16. As a collector, I want an image placeholder when artwork is absent or fails to load, so that I can still add the card.
17. As a collector, I want to see the last successful TCGdex pull time, so that I understand the catalog's freshness.
18. As a collector, I want catalog results paginated, so that broad searches remain usable.
19. As a collector, I want a clear unavailable state before the first successful import, so that I do not mistake an empty catalog for no matching cards.
20. As a collector, I want an owned Edition to remain identifiable when the source removes it, so that my inventory is not silently reassigned.
21. As a collector, I want to report a missing English Printing or Edition privately, so that the owner can investigate it.
22. As a reporter, I want to see the review state of my report, so that I know whether it was handled.
23. As the owner, I want to start a full English catalog pull from my control panel, so that I choose when the catalog refreshes.
24. As the owner, I want to see pull progress, failures, and the review queue after closing the browser, so that I can return later.
25. As the owner, I want incomplete imports to leave the prior searchable catalog intact, so that source outages do not break collectors' searches.
26. As the owner, I want ambiguous names and variants held for review, so that a pull does not silently change Card Identity or existing Holdings.
27. As the owner, I want to approve an evidenced missing English record, so that all collectors can select it immediately.
28. As the owner, I want later TCGdex matches reviewed before linking to manual records, so that physical identities are not merged by guesswork.
29. As a new collector, I want an Unsorted Storage Leaf created with my account, so that I can add cards immediately.
30. As a collector, I want to create named top-level Locations, so that I can model binders, boxes, and shelves.
31. As a collector, I want to nest ordinary Locations, so that the tree reflects my physical organization.
32. As a collector, I want to rename a Location, so that the tree can change without moving Holdings.
33. As a collector, I want to reparent a Location with its descendants, so that I can reorganize storage efficiently.
34. As a collector, I want duplicate sibling names prevented, so that the tree remains understandable.
35. As a collector, I want cycles and excessive nesting rejected, so that navigation remains valid.
36. As a collector, I want guided choices when adding a child under a stocked leaf, so that existing Holdings move safely into a child.
37. As a collector, I want reparenting beneath a stocked leaf to preserve its existing Holdings in an Unsorted child, so that nothing disappears.
38. As a collector, I want a Deck to remain a leaf, so that it has a clear physical meaning.
39. As a collector, I want deletion blocked while a Location has children or Holdings, so that I cannot orphan inventory.
40. As a collector, I want the Locations view to browse a tree and the selected leaf's contents, so that I can find physical cards quickly.
41. As a mobile collector, I want breadcrumbs and a Locations drawer, so that I can navigate the same tree on a small screen.
42. As a collector, I want compact thumbnail stacks with visible quantity, so that I can scan a dense leaf.
43. As a collector, I want card details on focus or open, so that I can confirm name, Printing, Edition, and Location.
44. As a collector, I want to fan out a stack into temporary copy handles, so that I can select a few of its copies.
45. As a collector, I want to select stacks, fanned copies, multiple Editions, or every Holding in a leaf, so that bulk operations match my physical task.
46. As a collector, I want selected copy and Edition counts, so that I can check a Move before acting.
47. As a collector, I want to Add a positive quantity of one Edition to a leaf, so that new acquisitions enter my Collection.
48. As a collector, I want repeated Adds to increase one Holding, so that quantities are not fragmented.
49. As a collector, I want to Move a selection to another Storage Leaf with one destination choice, so that the operation is quick.
50. As a desktop collector, I want a valid drag destination to perform the same Move, so that I can reorganize visually.
51. As a keyboard or touch collector, I want visible controls for every operation, so that drag and hover are optional.
52. As a collector, I want a large Move to succeed wholly or fail wholly, so that physical inventory never splits unexpectedly.
53. As a collector, I want stale or insufficient-quantity Moves to preserve my selection, so that I can recover without reselecting cards.
54. As a collector, I want to move copies into and out of a Deck, so that its Holdings match the physical deck box.
55. As a collector, I want Inventory Removal to require a short confirmation, so that I do not accidentally discard tracked copies.
56. As a collector, I want to undo my recent Moves or Inventory Removals, so that I can correct a mistake promptly.
57. As a collector, I want an incompatible Undo to fail without changing anything, so that it cannot overwrite later edits.
58. As a collector, I want simultaneous tabs to detect stale selected Holdings, so that one tab does not silently overwrite another.
59. As a collector, I want zero balances removed and negative balances prevented, so that every Holding reflects a possible physical quantity.
60. As a collector, I want an aggregate Collection view, so that I can see what I own without visiting each leaf.
61. As a collector, I want each Edition shown once with total owned quantity, so that duplicates across Locations are clear.
62. As a collector, I want an Edition's leaf distribution, so that I can find all physical copies.
63. As a collector, I want Organizational Location rollups to include descendants, so that I can see what a binder or shelf contains.
64. As a heavy collector, I want indexed search, filters, sorting, and pagination, so that a 25,000-Holding Collection remains usable.
65. As a collector, I want a refresh notice when inventory changes between pages, so that I never see a mixed revision.
66. As a deck builder, I want Decks indexed separately, so that I can find a physical deck and its status quickly.
67. As a deck builder, I want an exact total card count, so that I know whether the Deck has 60 copies.
68. As a deck builder, I want a clear shortage or excess issue at 59 or 61 copies, so that I know what to fix.
69. As a deck builder, I want the four-copy check across English Printings and Editions with the same Card Identity, so that cosmetic differences cannot bypass it.
70. As a deck builder, I want supported Basic Energy classified as exempt, so that ordinary energy quantities are not falsely flagged.
71. As a deck builder, I want uncertain Basic Energy classification shown as unresolved, so that the app does not assert a false result.
72. As a deck builder, I want clear wording that Standard legality is not evaluated, so that I do not mistake basic checks for tournament approval.
73. As a Deck owner, I want a separate public title, so that sharing does not reveal my private Deck name.
74. As a Deck owner, I want to publish a sanitized snapshot at an unguessable URL, so that others can view only the version I chose.
75. As a Deck owner, I want private Deck edits to stay unpublished, so that unfinished changes do not leak.
76. As a Deck owner, I want to republish at the same URL, so that recipients see an intentional update.
77. As a Deck owner, I want to revoke a URL permanently, so that future app requests cannot open it.
78. As a Deck owner, I want a new token after revocation, so that an old link never becomes valid again.
79. As a Deck owner, I want Unlisted sharing by default, so that a new snapshot is absent from public discovery.
80. As a Deck owner, I want to opt into Listed discovery, so that other visitors can find my published list.
81. As an anonymous visitor, I want a Published Deck's public title, grouped cards, details, images, and supported check results, so that the shared list is useful.
82. As an anonymous visitor, I want Listed search by public title or included Card Identity, so that I can discover published lists.
83. As a Deck owner, I want public responses to exclude my account, private Location, and non-Deck Collection data, so that sharing stays private.
84. As the owner, I want backup age, restore checks, catalog runs, sign-in delivery, and quota warnings visible in one control panel, so that I can operate the app.
85. As the owner, I want daily backups and verified disposable restores, so that I can recover private data.
86. As the owner, I want an independent stale-backup check, so that a backup job that never ran becomes visible.
87. As the owner, I want a manual release after CI passes, so that I choose when production changes.
88. As the owner, I want a rollback procedure and a smoke test, so that a failed release can be contained.
89. As the owner, I want 70% allowance warnings and usage measurements, so that a free-tier cap does not surprise me.
90. As the owner, I want to test the core flow on desktop and mobile before public signup, so that collectors receive a proven interaction.
91. As a prospective public collector, I want signup to open only after real-recipient code delivery works, so that I can access my account.

## Implementation Decisions

### Domain and interaction

- Use the glossary's Card Identity → Card Printing → Card Edition hierarchy. Card Identity is an application-owned English rules-relevant name group. A Card Printing is one language-specific set-and-collector-number release. A Card Edition is a physically distinguishable variant and the immutable identity referenced by Holdings. English only is in scope; language remains part of the model for future expansion.
- Normalize Card Identity names conservatively: Unicode and insignificant whitespace only. Retain capitalization, punctuation, possessives, owner and regional modifiers, and suffixes. Use an extensible Variant Descriptor. When physical variant evidence is insufficient, expose Unspecified Variant without implying normal finish.
- The collector workspace, Collection, and Decks are the authenticated top-level views. The workspace opens by default and replaced the original Locations file-browser view; the [collector workspace spec](../collector-workspace/spec.md) defines its gallery, selection, Add, Move, drag, keyboard, touch and mobile behavior.
- An ordinary Location with children is an Organizational Location and has no Holdings; without children it is a Storage Leaf. A Deck is always a Storage Leaf and cannot have children. Account creation atomically creates the ordinary Unsorted root leaf. The user may rename, move, or delete it once empty.
- Creating the first child under a stocked leaf offers the approved atomic choices: move existing Holdings to the named child; create a separate Unsorted child for existing Holdings and the named child; or cancel. Reparenting an existing Location beneath a stocked leaf offers atomic creation of an Unsorted child for destination Holdings before moving the subtree, or cancel. A failed conversion leaves the original tree intact.
- A tree has at most 12 nodes along a path, counting the root. Sibling names are unique after trim and case-insensitive comparison; the same name may occur in different branches. Reject cycles, Deck parents, cross-owner references, and depth overflow. Delete only an empty childless Location, with named confirmation. Removing the final child turns its former parent into an empty Storage Leaf.
- Selection may include whole stacks, arbitrary fanned copies, multiple Editions, or all Holdings in one leaf. Add increments a positive quantity in a leaf. Move transfers a selection from one leaf to a distinct destination leaf with no product-level Edition count limit; a transfer is one all-or-nothing operation. Inventory Removal subtracts a selection from the Collection with concise confirmation. Inline quantity editing is outside the MVP. Failures preserve the user's selection.
- Offer Undo for the newest of the last five Moves or Inventory Removals. Each inverse record becomes unusable exactly ten minutes after its action. Expired payloads are deleted on the next inventory action or daily maintenance. Undo is atomic, validates available inverse quantities and Location state, and never overwrites incompatible intervening changes. An incompatible newest Undo can be dismissed to reach an older one. There is no permanent movement history. One Undo restores every source of a multi-source Move or Removal, as the collector workspace spec's [Multi-source Move, Removal and Undo](../collector-workspace/spec.md#multi-source-move-removal-and-undo-resolves-49) decisions define.

### Catalog, search, and review

- The owner starts a full English TCGdex pull from an owner-only frontend panel. Each explicit start launches one background import process for the durable run ID; that process exits on completion or failure. There is no permanently running catalog worker polling for work, and no schedule or timer starts a catalog run. The import continues after the browser closes and, in the local implementation, after an API-process restart. The panel shows one active run, progress, result, last success, and pending review items. Search is unavailable until the first complete import succeeds. See [on-demand import requirements](proposals/manual-catalog-import.md), [ticket 19](https://github.com/ry-cen/prizecheck/issues/34), and [ADR 0003](../../adr/0003-on-demand-catalog-imports.md).
- Enumerate the complete English source ID set, fetch records with bounded concurrency, re-enumerate, normalize, validate, and promote a complete generation atomically in PostgreSQL. A failed fetch, mismatched enumeration, source-ID drop greater than 1% from the last successful pull, or projected database size above the chosen provider's safe capacity gate fails validation and preserves the prior catalog. Source IDs absent from two agreeing complete enumerations are tombstoned. Each enumeration leaves out the digital-only Pokémon TCG Pocket series (TCGdex series `tcgp`, read from its series and set listings; a doubtful listing fails the run), and withdrawing those previously imported IDs does not count toward the 1% drop. Owned Editions retain their identities and display metadata; tombstoned Editions cannot receive new Adds. Keep the current and prior compressed raw generation privately for diagnosis; remove older or failed staging artifacts after seven days.
- Source names that would change Card Identity and ambiguous Variant Descriptors are held for owner review while other valid changes may promote. A reviewed decision creates a versioned Catalog Override. No source change silently rewrites a Holding. Corrections deprecate an incorrect Edition, link its replacement, and require an explicit collector reassignment.
- Signed-in collectors may file private missing-English-Printing or Edition reports and see their state. The owner may approve, reject, or request more information. Approval of a Printing requires verified set, collector number, exact English name, and evidence link. Approval of a distinct Edition requires evidence for its physical Variant Descriptor. Approved manual records have immutable application IDs and manual provenance, become searchable in the same catalog-revision transaction, and do not claim a fabricated TCGdex ID or image. Later source matches require owner reconciliation, not automatic merging.
- Search the local PostgreSQL catalog only. Support case-insensitive English name-prefix lookup and set/collector-number lookup, with no typo tolerance or mid-name substring search. Return Printings with available Editions, set, number, image, and provenance. Show a low-resolution source image in results and a high-resolution image in details when available; a placeholder handles absent or failed images. The image depicts a Printing and does not prove an Edition's physical finish. Display last successful TCGdex pull time separately from manual-entry provenance.
- Catalog search starts with a nonempty name prefix or set/number filter, returns at most 30 Printings per page, and uses indexed keyset pagination. An opaque cursor binds filters, unique ordering, and catalog revision; a catalog revision change asks the UI to restart from page one. Escape wildcard input and bind parameters.

### Inventory, Decks, and public views

- Use PostgreSQL `inventory_owner`, `location`, `deck_detail`, `holding`, selection-manifest/item, short-lived Undo, and item-free mutation-request records as described by the approved relational model. Holdings are current fungible positive 64-bit quantities, unique per owner, leaf, and Edition. A zero result deletes the Holding. Collection totals and Organizational Location rollups derive from current indexed Holdings; there is no Collection summary table. All tenant-scoped references and queries include owner identity from the authenticated session.
- Serialize each owner's inventory mutations through the owner row lock; different owners do not share that lock. Every committed inventory mutation advances its owner revision. Location structural changes require displayed Location version; Move and Removal require the selected source-Holding versions. Add is an atomic increment. Commands carry idempotency keys; an applied key and command digest is retained without item details for 24 hours to make uncertain retries safe.
- Bulk Move and Removal stage selection in bounded HTTP batches, with one live manifest per owner, unique positive-quantity items, expected source versions, and one-hour staging expiry. Final validation and set-based Holding changes occur in one PostgreSQL transaction. A crash, conflict, or disconnection cannot partially mutate inventory. A 25,000-Edition fixture is a launch proof, not a product selection limit. A manifest's selection may span several source Storage Leaves: each staged item names its source, and the collector workspace spec's [Multi-source Move, Removal and Undo](../collector-workspace/spec.md#multi-source-move-removal-and-undo-resolves-49) decisions supersede this specification's single-source manifest, commit, result and Undo rules.
- Location and Holding reads use indexed keyset pagination. Leaf grids default to 48 Holdings per page; Collection and Deck lists default to 30 entries. Cursors bind owner, filter, sort, inventory revision, and catalog revision when relevant. An intervening revision returns a refresh signal; the UI restarts from page one. Collection distributions list direct quantities by Storage Leaf; parent rollups sum descendants.
- A Deck's physical Holdings supply its basic construction result. Check exactly 60 cards and a four-copy limit by English Card Identity across Printings and Editions. Exempt Basic Energy only with supported classification or a reviewed override; otherwise report unresolved. Always show that Standard eligibility, rotation, bans, and special card rules are not evaluated. An incomplete or invalid Deck may still be published with its issues visible.
- A Published Deck is a sanitized current-version snapshot with owner-chosen public title, timestamp/version, total, Card Identity groups, expandable Edition details, images, and supported checks. Public title is escaped plain text limited to 120 characters. The projection excludes owner/email, private Deck and Location identifiers/names/paths, Collection totals, non-Deck Holdings, and operational fields.
- First publish creates a random token with at least 192 bits of entropy and version one. Private edits do not alter the snapshot. Republish atomically replaces the active snapshot at the stable URL; superseded public versions are removed. Revocation permanently burns the token, and unknown or revoked tokens have one not-found response. A later publish uses a new token. Current snapshot/discovery changes affect the next request; snapshot JSON is not stored by browsers or shared caches.
- Published Decks are Unlisted by default, excluded from search and sitemaps and marked `noindex, nofollow`. Owners may opt into Listed discovery and later change visibility without changing snapshot version. Listed search matches public title and included Card Identity, returns bounded pages sorted by recent publication, and exposes only public summary fields. Anonymous reads use sanitized public object projections without waking PostgreSQL.

### Authentication, hosting, and operations

- Build the frontend with React, TypeScript, and Vite and the application API with Python/FastAPI. Better Auth email-code sign-in runs in a TypeScript server module or service behind the same public origin. The Python API validates sessions and sensitive fresh-code proofs through an internal authenticated boundary, then derives the immutable user ID server-side. Use PostgreSQL and standard migrations. Keep auth, email, background job, object storage, and logging behind narrow interfaces; select deployment and service providers later. Local development and CI must work without a production account. Plan for one production environment; a persistent staging environment is optional.
- The first deployment is owner-only. An explicit setup step binds owner privileges to its immutable application user ID, never email text or first signup. Every admin API independently verifies that ID. Open public signup only after a sending domain is registered/verified and a real-recipient OTP test succeeds.
- OTP codes are six digits, hashed in storage, valid for five minutes, invalid after three wrong attempts, and rotated on resend. Apply durable limits of one send per normalized email per 60 seconds, five per email per rolling day, and 20 per trusted client IP per rolling hour. Configure an application-wide daily send cap below the selected email provider's allowance. Code-request responses do not reveal account existence. Sessions use a same-origin Secure, HttpOnly, SameSite=Lax cookie, last 30 days, roll while active, and end on sign-out. Protected routes restore safe same-origin destinations. Sensitive owner catalog identity approvals require a fresh single-use code bound to that approval.
- Run daily logical PostgreSQL backups of user/auth, inventory, Deck, transfer, and publication data to private object storage, excluding rebuildable TCGdex data and expired manifests/Undo payloads. Retain seven daily and four weekly copies; verify restoration into a disposable database monthly. Target a 24-hour recovery point. An hourly watchdog independent of the backup scheduler checks the last successful backup marker and warns when it exceeds 25 hours. Before sender-domain verification, the owner panel is the alert fallback; afterward email the owner as well.
- Use bounded structured logs without OTPs, emails, tokens, private Location names, or card payloads. The owner panel shows sign-in, API, catalog, backup/restore, projection, and quota status. CI/job failure notifications cover eligible release and scheduled jobs. After domain verification, email catalog failures and otherwise show them in the panel.
- Production releases are manual after Python and TypeScript checks, tests, application and asset builds, generated OpenAPI and schema compatibility checks, and required CI on the exact main commit. A credential-free gate verifies that commit before a dependent secret-bearing deploy job runs. Serialize releases, apply backward-compatible migrations first, deploy compatible auth/API/assets, smoke-test production, and retain a prior compatible release for rollback. Document deployment, restore, catalog pull, review, and rollback procedures.
- Target under $10/month in idle hosting cost, excluding domain and separately itemized request/email use. Measure the full English catalog, indexes, auth data, 25,000 representative Holdings, and five worst-case Undo payloads against the selected database and runtime allowances before launch. Warn at 70% of applicable provider quotas. Preserve backup retention and atomic transfers when upgrading.

### External contracts and failures

- Python Pydantic models and OpenAPI define runtime-validated application request, response, and error contracts for catalog search and reports, owner catalog runs/reviews, Locations, Holdings, bulk manifests/commit, Undo, Collection, Deck checks, publication, and public discovery. Generate TypeScript client types from the committed OpenAPI schema for React; check schema generation in CI. Better Auth's browser and internal session-validation contract is separately tested at its HTTP boundary. Browser, API, background job, and object projection use the same domain identifiers and serialization rules. Client-supplied owner IDs never determine ownership.
- The minimum operation shapes are:

  | Operation | Input contract | Result contract |
  | --- | --- | --- |
  | Catalog search | English name prefix or set/collector filter, optional cursor | Ordered Printings with Editions, image/placeholder data, provenance, last successful pull, catalog revision, next cursor |
  | Missing-card report and owner review | Report kind and evidence; owner decision, reason, and fresh code for sensitive approval | Private review state or approved immutable record and new catalog revision |
  | Catalog pull | Owner session and idempotent start request | Existing or new run ID, phase/counts, outcome, last success, review items |
  | Location commands | Name, kind, optional parent, displayed Location version for edits, idempotency key | Owned Location, updated depth/version, owner inventory revision; structured conversion choices when a stocked leaf is targeted |
  | Add | Owned leaf ID, active Edition ID, positive decimal-string quantity, idempotency key | Resulting Holding quantity/version and owner revision |
  | Move or Inventory Removal | Optional default source leaf, action and destination when moving, staged source/Edition/quantity/source-version items, commit key (see [Multi-source Move, Removal and Undo](../collector-workspace/spec.md#multi-source-move-removal-and-undo-resolves-49)) | Atomic affected counts (Card Editions, copies, sources, already-at-destination copies), owner revision, and Undo identity/expiry; stable all-or-nothing conflict response naming the affected source and Card Edition |
  | Undo | Owned Undo identity and idempotency key | Applied inverse and owner revision, or expired/incompatible result without a partial change |
  | Collection and leaf read | Normalized filter, sort, and opaque cursor | Current totals or direct Holdings, distribution/rollups, revision, next cursor or explicit refresh signal |
  | Deck check and publication | Owned Deck ID; public title and visibility for publish; explicit republish/revoke/visibility commands | Count and structured supported issues; sanitized current public snapshot or uniform not-found response |

- Protected commands use idempotency keys and authenticated user identity. Cross-owner and nonexistent resources return the same not-found result. Malformed payloads/cursors return `400`; invalid names or nonpositive quantities return `422`; stale versions, insufficient quantities, invalid target/cycle/depth, name conflict, invalidated cursor, or incompatible Undo return stable `409` codes; an expired Undo still present returns `410`; transient database failure returns `503` and can be retried with the same idempotency key. A physically deleted Undo is not found. Errors disclose no other user's private metadata.
- Catalog run dispatch is owner-only and idempotent: a second start while one healthy run is active returns that run without launching another process. Serialize reservation/dispatch in PostgreSQL, allow a two-minute startup window, and hold runner session-lock ownership through fetch and publication. Launch failure returns `503` with `CATALOG_DISPATCH_FAILED`. After the startup window, an explicit Start may recover an abandoned run only when exclusive runner ownership can be established; stale heartbeat alone never permits overlap. Status reads never launch jobs. Catalog and inventory cursors bind revisions and produce explicit `CATALOG_CHANGED` or `INVENTORY_CHANGED` recovery states. Public snapshot lookup returns one uniform not-found result for unknown and revoked tokens.

## Testing Decisions

- Test observable behavior through the highest useful seam. The primary seam is the browser journey across sign-in, catalog search, Location creation, Add, Move, Collection totals, Deck checks, publish, anonymous view, republish, and revoke. API-level contract tests cover error/authorization/privacy behavior that browser tests cannot isolate. A real PostgreSQL integration seam covers transactions, constraints, failures, and concurrency. Background catalog, backup, release, and object-projection workflows need integration/smoke tests at their external boundaries. Avoid tests that assert private helpers, component state, SQL spelling, or implementation-specific keys.
- There is no application test suite or runtime code in this repository yet. The previous spec and the approved interactive prototype are planning prior art. The first implementation ticket establishes test names, fixtures, Pydantic/OpenAPI validation and generated TypeScript client checks, and browser-test conventions; later tickets extend them.
- The implementation-handoff gate requires this spec and dependency-ordered tickets to trace every approved decision to an acceptance check. Include worked fixtures for variant ambiguity, source renames, missing and later-matched manual records, Basic Energy uncertainty, 59/60/61-card Decks, leaf conversion, stale two-tab edits, failed 25,000-Edition Moves, multi-step ten-minute Undo, catalog and inventory cursor invalidation, Listed/Unlisted/revoked snapshots, and cross-owner not-found behavior. It requires test plans and pass criteria, not results from an app that has not been built.
- The owner-only launch gate requires the exact CI-passing release commit, real owner OTP delivery, first full English pull, PostgreSQL/browser/HTTP contract suites, privacy serialization assertions, a failed-transfer rollback drill, a real disposable backup restore, release rollback and alert drills, and the agreed capacity/cost measurements. A public-signup gate additionally requires a verified sender domain, a successful real-recipient OTP delivery, and the owner's desktop/mobile walkthrough of search, Add, Move, Undo, Deck check, and publish/revoke.
- The reproducible load fixture includes 1,000 registered accounts, 200 monthly active users, one 25,000-Holding collector, full English catalog/indexes/auth, five worst-case Undo payloads, and 10,000 anonymous Published Deck views/month. Measure cold starts separately. At fixture scale, 95% of warmed Collection/Location pages complete within two seconds and ordinary inventory actions within five seconds. A 25,000-Edition Move, including selection staging from the user's Move action, completes within two minutes with progress and no partial change; this is a maximum, not an expected duration or selection cap. Measure actual query plans, latency, transaction duration, database bytes, runtime/database/storage/email/CI usage, and public-view database wakeups. Improve slow paths and upgrade constrained components rather than weaken correctness.
- Record each launch proof with fixture, environment, reproducible procedure, expected and actual result, date, and private location for sanitized artifacts. Privacy, authorization, atomicity, data integrity, backup recovery, and agreed capacity/performance failures block launch. Other deviations require an explicit documented decision.

## Out of Scope

- Japanese and other non-English catalog records, cross-language Card Identity mapping, and mixed-language deck checks.
- Full Standard or other format legality, including rotation, reprint equivalence, banned cards, and special card-specific rules.
- Import/export, image recognition, valuation, grading, purchase/sale history, a permanent movement/audit ledger, shared households, collaboration, social profiles, comments, and native mobile apps.
- Automatic catalog schedules, direct TCGdex queries on user read paths, silent catalog identity merges, and image mirroring or transformation.
- Application implementation during this Wayfinder effort; this document and its linked tracer tickets are the implementation handoff.

## Further Notes

- The [Wayfinder map](wayfinder/map.md) indexes earlier decision records. [ADR 0002](../../adr/0002-defer-deployment-provider-selection.md) supersedes their provider-specific commitments. Current spec and implementation tickets govern active work; a material new product decision should be raised rather than guessed.
- Deployment provider selection is intentionally deferred. The application and product tickets can proceed; [provider selection](https://github.com/ry-cen/prizecheck/issues/30) is `needs-info`, and the [owner-only release](https://github.com/ry-cen/prizecheck/issues/32) is blocked until a topology is chosen.
- The first owner-only deployment and public signup have separate prerequisites. The owner must register and verify a sending domain before inviting other collectors, but domain registration is not needed to complete the implementation handoff.
- TCGdex images and names are source metadata. Show provider attribution and a clear statement that the product is not endorsed by Nintendo, The Pokémon Company, or TCGdex.

### Decision traceability

| Approved Wayfinder decision | New implementation tickets |
| --- | --- |
| [Validate TCGdex card identity and variant coverage](https://github.com/ry-cen/prizecheck/issues/1) | [First English catalog pull](https://github.com/ry-cen/prizecheck/issues/17), [Collector catalog search](https://github.com/ry-cen/prizecheck/issues/18), [Physical Decks and checks](https://github.com/ry-cen/prizecheck/issues/25) |
| [Validate the sub-$10 AWS cost envelope](https://github.com/ry-cen/prizecheck/issues/2) | [Choose deployment providers](https://github.com/ry-cen/prizecheck/issues/30), [Manual release and owner-only launch](https://github.com/ry-cen/prizecheck/issues/32) |
| [Prototype the core physical-inventory workflow](https://github.com/ry-cen/prizecheck/issues/3) | [Location tree](https://github.com/ry-cen/prizecheck/issues/20), [Select and Move Holdings](https://github.com/ry-cen/prizecheck/issues/22), [Inventory Removal and Undo](https://github.com/ry-cen/prizecheck/issues/23) |
| [Decide Card Edition and Card Identity](https://github.com/ry-cen/prizecheck/issues/4) | [First English catalog pull](https://github.com/ry-cen/prizecheck/issues/17), [Collector catalog search](https://github.com/ry-cen/prizecheck/issues/18), [Physical Decks and checks](https://github.com/ry-cen/prizecheck/issues/25) |
| [Decide catalog ingestion and search architecture](https://github.com/ry-cen/prizecheck/issues/5) | [First English catalog pull](https://github.com/ry-cen/prizecheck/issues/17), [Collector catalog search](https://github.com/ry-cen/prizecheck/issues/18), [Safe catalog refresh and reconciliation](https://github.com/ry-cen/prizecheck/issues/29) |
| [Decide the runtime, authentication, and hosting topology](https://github.com/ry-cen/prizecheck/issues/6) | [Owner sign-in and Unsorted](https://github.com/ry-cen/prizecheck/issues/16), [Choose deployment providers](https://github.com/ry-cen/prizecheck/issues/30), [Backups, alerts, and owner status](https://github.com/ry-cen/prizecheck/issues/31), [Manual release and owner-only launch](https://github.com/ry-cen/prizecheck/issues/32), [Public signup and owner walkthrough](https://github.com/ry-cen/prizecheck/issues/33) |
| [Decide the relational transactional inventory model](https://github.com/ry-cen/prizecheck/issues/7) | [Add Holdings](https://github.com/ry-cen/prizecheck/issues/19), [Location tree](https://github.com/ry-cen/prizecheck/issues/20), [Safe Location conversion and deletion](https://github.com/ry-cen/prizecheck/issues/21), [Select and Move Holdings](https://github.com/ry-cen/prizecheck/issues/22), [Inventory Removal and Undo](https://github.com/ry-cen/prizecheck/issues/23), [Collection totals and distribution](https://github.com/ry-cen/prizecheck/issues/24) |
| [Decide the core Collection, Location, and Deck interaction contract](https://github.com/ry-cen/prizecheck/issues/8) | [Add Holdings](https://github.com/ry-cen/prizecheck/issues/19), [Location tree](https://github.com/ry-cen/prizecheck/issues/20), [Safe Location conversion and deletion](https://github.com/ry-cen/prizecheck/issues/21), [Select and Move Holdings](https://github.com/ry-cen/prizecheck/issues/22), [Inventory Removal and Undo](https://github.com/ry-cen/prizecheck/issues/23), [Collection totals and distribution](https://github.com/ry-cen/prizecheck/issues/24), [Physical Decks and checks](https://github.com/ry-cen/prizecheck/issues/25) |
| [Decide the public Deck snapshot and privacy contract](https://github.com/ry-cen/prizecheck/issues/9) | [Unlisted Deck publishing](https://github.com/ry-cen/prizecheck/issues/26), [Listed Deck discovery](https://github.com/ry-cen/prizecheck/issues/27) |
| [Decide the evidence required for implementation readiness](https://github.com/ry-cen/prizecheck/issues/10) | [Backups, alerts, and owner status](https://github.com/ry-cen/prizecheck/issues/31), [Manual release and owner-only launch](https://github.com/ry-cen/prizecheck/issues/32), [Public signup and owner walkthrough](https://github.com/ry-cen/prizecheck/issues/33) |
| [Compare sub-$10 relational hosting options](https://github.com/ry-cen/prizecheck/issues/11) | [Choose deployment providers](https://github.com/ry-cen/prizecheck/issues/30), [Manual release and owner-only launch](https://github.com/ry-cen/prizecheck/issues/32) |
| [Find an authoritative cross-language Card Identity source](https://github.com/ry-cen/prizecheck/issues/12) | [First English catalog pull](https://github.com/ry-cen/prizecheck/issues/17), [Physical Decks and checks](https://github.com/ry-cen/prizecheck/issues/25) |
| [Assess Limitless TCG as a Card Identity and Printing source](https://github.com/ry-cen/prizecheck/issues/13) | [First English catalog pull](https://github.com/ry-cen/prizecheck/issues/17) |
| [Decide fallback for missing English catalog records](https://github.com/ry-cen/prizecheck/issues/14) | [Missing-card reports and approval](https://github.com/ry-cen/prizecheck/issues/28), [Safe catalog refresh and reconciliation](https://github.com/ry-cen/prizecheck/issues/29) |

## Implementation checkpoint — 2026-10-06

Application tickets 01–14 and 19 are complete on `codex/mvp-integration`; [combined validation](evidence/integration-validation.md) and [resolved review findings](evidence/code-review.md) document the local evidence. Tickets 15–18 remain pending for provider decisions, provisioning and production launch proof, per owner instruction. [Provider options](evidence/provider-options.md) are prepared for that decision. The specification remains needs-info until those gates are resolved.

## Provider-agnostic implementation completion — 2026-10-07

Tickets 01–19 are complete under the owner-approved revised scope in [ADR 0004](../../adr/0004-provider-agnostic-completion.md). The previous needs-info checkpoints are historical. [Completion evidence](evidence/provider-agnostic-completion.md) records application, operations, mobile and release checks. [Provider plug-in contracts](../../provider-adapters.md) describe configuration and adapter interfaces. [Production launch acceptance](launch-checklist.md) remains separate, with public signup closed by default. This status records implemented vendor-neutral behavior, not a deployed production launch.
