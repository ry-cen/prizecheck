# Resolution — Decide catalog ingestion and search architecture

**Deployment amendment:** [ADR 0002](../../../../adr/0002-defer-deployment-provider-selection.md) defers the named GitHub Actions, R2, and Neon choices below. The manual pull, private raw-generation retention, atomic promotion, and search behavior remain approved.

**Execution amendment:** [ADR 0003](../../../../adr/0003-on-demand-catalog-imports.md) specifies one import process launched on demand by the owner panel, which exits after its supplied run. No permanently polling catalog worker is required. See [ticket 19](https://github.com/ry-cen/tcg-tracker/issues/34).

The owner confirmed the catalog and search contract below. Earlier Card Identity and hosting resolutions apply.

## Agreed product decisions

- Catalog synchronization is initiated manually from a frontend control panel accessible only to the owner/operator. There is no scheduled catalog synchronization or timer-based freshness target. A failed pull leaves the last complete catalog active.
- The first catalog import is also started manually from the control panel. Catalog search is unavailable until the first complete import succeeds.
- A successful complete import is validated and promoted automatically without a separate publish action. The control panel shows the outcome; failed or incomplete imports do not replace the active catalog.
- Catalog search keeps the approved name-prefix matching plus set and collector-number lookup. The MVP does not add typo tolerance or mid-name substring matching.
- Search results and card details show TCGdex card images when provided, using the source image URL; missing images show a placeholder and do not prevent inventory entry. An image is associated with a Card Printing and is not proof that a particular Card Edition's physical finish is pictured.
- Catalog search shows the date and time of the last successful pull to all users, since synchronization is manual.
- A source name change that would move a Card Printing to a different Card Identity is held for owner/operator review. Other validated catalog changes may still promote; the affected Printing keeps its current effective Card Identity until reviewed.
- The pull runs in the background. The control panel shows progress, completion or failure, and pending review items; closing the browser does not stop it.

## Control and execution

- The single operator account is identified by immutable application user ID in server-side configuration. The frontend hides the control panel from other accounts, and every control-panel API operation independently checks that ID. After the operator signs in, a deploy-time setup step explicitly binds that account ID; the first person to sign in is never granted access automatically. Neither email text nor a client-side flag grants the role.
- `POST /api/admin/catalog-runs` accepts one operator request, reserves one run ID, and launches one background import process for that run. A second request while a healthy run is active returns it without another launch. PostgreSQL serializes dispatch and runner ownership; launch failure and orphan recovery follow the [on-demand import specification](../../proposals/manual-catalog-import.md). The process writes progress/results and exits. The panel can be closed and reopened to see the same run. Eventual hosting must support the on-demand launcher; provider choice remains deferred.
- The panel displays phase, counts of enumerated/fetched/validated records, start and completion times, last success, a concise error, and review queue. It never displays access tokens or raw card payloads. No timer or cron starts a catalog run.

## Full English pull and promotion

- Fetch the complete English brief-card ID set from TCGdex, then fetch full records with bounded concurrency and retry transient failures. Re-enumerate IDs at the end; if the set changed during the run, or any listed full record is missing or invalid, fail the run. There is no delta-only or timestamp-only synchronization because the source has no authoritative change/deletion feed ([earlier source investigation](../research/tcgdex-card-identity.md)).
- Normalize Card Printings, Card Editions, Variant Descriptors, source metadata, set names, image bases, and verified Basic Energy data using the existing identity rules. Store source fingerprints. Keep the fetched raw source generation as a compressed private R2 artifact; stage only normalized changes in PostgreSQL to stay within Neon's 0.5 GB Free project limit ([Neon](https://neon.com/blog/neon-backend-is-ga)).
- Validate unique source references, complete record fetches, normalized variant-key collisions, and the proposed change set before touching the active catalog. A source-ID count drop greater than 1% from the last successful pull or projected database size over the agreed 70% upgrade threshold fails validation and requires operator attention. Ambiguous variant descriptors are held for review while other valid changes promote; missing optional fields or images do not fail a run. Record counts and fingerprints come from our run, not a claimed TCGdex version.
- Apply validated changes to stable application-owned Card Printing and Card Edition IDs in one PostgreSQL transaction. The transaction also advances the active catalog revision and last-success timestamp. Readers see either the old or new catalog. Failed validation or transaction rollback leaves the last complete catalog active. The first import exposes search only after this transaction commits.
- Source records absent from two agreeing complete enumerations are tombstoned on promotion; referenced Card Editions retain their identity and last display metadata for existing Holdings. New Holdings cannot select tombstoned Editions. New source variants create new Editions; existing Unspecified Variant Holdings are never reassigned.
- A name change that would move a Printing between Card Identities is quarantined from the effective catalog and appears in the operator review queue. The rest of the valid change set promotes. Approval explicitly selects its Card Identity and creates a versioned Catalog Override; rejection retains the old effective identity and records the reviewed source fingerprint so the same change does not repeatedly appear as new. Neither action silently rewrites Holdings.
- Keep the current and previous successful raw source artifacts for diagnosis and rollback preparation; remove older artifacts and failed staging artifacts after seven days. Restoring an old catalog requires a new validated promotion, not a pointer flip that could erase newer Holding references.

## Search contract

- Search our PostgreSQL catalog, not TCGdex on each user query. Return Card Printings with their available Card Editions, set, collector number, and image. Support case-insensitive English name-prefix search and set plus collector-number lookup. Do not add typo tolerance or mid-name substring search in the MVP.
- Store an application-normalized `search_name` separately from the display name and Card Identity key. Case-fold and normalize Unicode and whitespace for search, retaining punctuation and suffixes. Use PostgreSQL B-tree prefix indexing (C collation or an equivalent `text_pattern_ops` index), plus a set/collector lookup index. Escape wildcard input and use bound parameters. PostgreSQL documents prefix-capable pattern operator classes ([PostgreSQL index documentation](https://www.postgresql.org/docs/current/indexes-opclass.html)).
- Return at most 30 Printings per page, ordered by normalized name then immutable Printing ID (or by set, collector number, and ID for set lookup). Use keyset pagination. An opaque cursor binds the normalized filters, sort tuple, and active catalog revision; a changed revision yields `CATALOG_CHANGED` and the UI restarts from page one. PostgreSQL warns that offset pagination computes skipped rows and that pagination requires unique ordering ([PostgreSQL pagination documentation](https://www.postgresql.org/docs/current/queries-limit.html)).
- Search begins after a nonempty name prefix or set/collector filter. Results show a low-resolution TCGdex image when available; detail views use the high-resolution image. Missing image URLs or failed loads show a placeholder without blocking selection. TCGdex's image field is optional and its asset URL supports low/high WebP variants ([Card brief](https://tcgdex.dev/reference/card-brief), [assets](https://tcgdex.dev/assets)).
- Show the last successful catalog-pull timestamp near search results. If the first import has not succeeded, show an unavailable state rather than querying TCGdex live.

## Verification and limits

- Before implementation is considered ready, measure a full English generation, its PostgreSQL indexes, authentication data, and a 25,000-Holding fixture against Neon's storage cap. Verify indexed query plans and page latency for broad prefixes and set/number lookups. If the fixture or a full pull cannot meet the agreed 70% quota trigger, upgrade the database or adjust the topology rather than dropping catalog records or atomic promotion.
- Test interrupted fetch, changing ID enumeration, invalid source data, duplicate variant descriptors, transaction failure, tombstoning of an owned Edition, operator-only dispatch, cursor invalidation, and a source rename requiring review.

The GitHub Actions dispatch API supports starting a workflow from an authenticated HTTP request with a fine-grained Actions-write credential ([GitHub documentation](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)).
