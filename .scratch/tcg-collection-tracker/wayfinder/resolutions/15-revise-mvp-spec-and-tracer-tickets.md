# Resolution — Revised MVP spec and tracer-bullet tickets

**Historical handoff:** The owner later replaced this twelve-ticket set with [eighteen approved implementation slices](../../issues/). The first current frontier is [Owner sign-in and Unsorted](../../issues/01-owner-sign-in-and-unsorted.md). The paragraph below records the original handoff rather than the current ticket count.

The [MVP spec](../../spec.md) and twelve [implementation tickets](../../issues/) now form the implementation handoff. They replace the superseded AWS/DynamoDB, English/Japanese, mixed-content Location, scheduled catalog, and automatic deployment instructions with the approved Wayfinder decisions.

The spec follows the requested to-spec structure, uses the domain glossary, contains 91 user stories, and maps all fourteen prior Wayfinder decisions to implementation tickets. Its testing section separates the complete-document handoff gate from owner-only and public launch proofs. The highest test seam is the browser journey, supported by HTTP contract, real PostgreSQL transaction, catalog-job, object-projection, and operational smoke tests where those behaviors cannot be proven through one browser path.

The original twelve tickets covered the application shell, owner-only authentication, manual English catalog pull/search, Locations, Holdings, Collection, bulk Move/Removal/Undo, physical Deck checks, public snapshots/discovery, owner-only operations, missing-card review, and verified-domain public signup. Each had a `ready-for-agent` label, testable acceptance criteria, and explicit dependency links.

Validation found all local spec/ticket links present, 91 numbered user stories, twelve labeled tickets, and an acyclic dependency graph. A scan of the new spec and tickets found stale provider/product terms only in the explicit out-of-scope statement about Japanese support. Application code, live performance results, service accounts, and deployment remain for implementation and launch.
