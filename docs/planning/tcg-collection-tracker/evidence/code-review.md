# MVP integration review

Date: 2026-10-06. User-confirmed baseline: `a38c674`. Reviewed application tip: `d2c81bf`. Diff: `git diff a38c674...d2c81bf`. Provider/provisioning and launch tickets 15–18 remain pending by owner instruction.

## Standards

- P2 — Collection entries are typed as HoldingView and manufacture a version, zero Location UUID and 'Collection' Location name. CONTEXT.md says a Holding belongs in a Storage Leaf and Collection cannot directly hold cards. Use CollectionEntry for Edition metadata and aggregate quantity; keep real leaf Holdings in distribution responses. (api/app/collection.py:12,96)
- P3 — Possible duplicated construction checks in private Deck and public snapshot evaluation can diverge after a rule correction. Share a pure check evaluator while keeping private IDs outside public serialization. This is a judgment call under the skill's smell baseline. (api/app/decks.py:136, api/app/publications.py:134)

## Spec

- P1 — Existing source IDs can promote changed set/collector-number metadata while retaining Printing/Edition IDs. Search then labels the same inventory kind as another physical Printing while Holdings keep immutable original metadata. Ticket14 requires source drift held for review. Preserve established references and queue proposed changes. (api/app/catalog.py:262)
- P2 — Protected destinations change URL but the rendered view always initializes as Locations. Spec requires safe same-origin destination restoration. Initialize and update the view from /decks or /collection after sign-in and refresh. (web/src/main.tsx:27,73)
- P2 — PublishDeck prefers any pending action regardless of clicked action. After uncertain republish, Revoke can retry republish and leave the token live. Spec requires permanent revocation. Bind retry to its action or recover then execute the requested revoke. (web/src/PublishDeck.tsx:19)

Two Standards findings (worst P2); three Spec findings (worst P1). All were resolved by one review-fix implementer in `e058f71`, integrated in `ca44d56`, with a browser expectation follow-up integrated in `859f2aa`.

## Resolutions and verification

Standards: dedicated CollectionEntry aggregates replace fabricated Holdings; one pure Deck check evaluator serves private and public evaluation while public serialization retains its identifier-free allowlist. The Standards reviewer independently confirmed both resolutions.

Spec: established set/collector references remain frozen while drift enters review; protected view selection follows safe destinations, reloads and browser history; publication retries are action-bound so Revoke executes revocation after uncertain republish. The Spec reviewer independently confirmed all three resolutions with no remaining concrete finding in the focused re-review.

Final combined gate at `859f2aa`: 68 API/PostgreSQL, six live authentication and 19 Chromium tests passed, including source-reference drift, protected deep links and uncertain-republish/Revoke regressions. Migrations, generated contracts, TypeScript and build passed. Production tickets 15–18 remain pending.
