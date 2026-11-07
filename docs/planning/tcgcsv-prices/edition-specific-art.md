# Edition-specific SVP Pokémon Center imagery

Prepared 2026-11-04 against `5cf1ee1e2c9d8f83afc4fdcf215c0c2930aa08da`.
This is code and a reviewed data/configuration migration, not a live application,
deployment, price correction or image publication. Independent review and coordinated
validation remain required before a draft PR. No source has been refetched here.

## Current decision and scope

Ryan explicitly directed using the stamped images after the source-rights concern was
explained. This supersedes the prior pending withholding choice and the earlier
rights-gated staged-file design. The implementation uses the existing **linked**
TCGplayer image behavior from ADR 0019. It does not add an image downloader, cache,
rehosting, upload endpoint, scraper, generic URL provider or permission grant. The
superseded local-file activation/validation/recovery machinery has been removed.

Only the audited English SVP PC identities are mapped. First-edition, staff, reverse,
unspecified and other variants retain their existing reference-image behavior. Other
sets are unchanged. An SVP PC Edition without a matching reviewed physical identity
or current public selection is unavailable rather than being pictured with its
unstamped sibling. No stamp or foil effect is synthesized.

A Printing remains the scanner/reference identity. An Edition supplies the selected
physical variant's display image. `catalog_edition_art` centralizes selection for
catalog/gallery/detail, Collection and leaf Holdings, decks/replay display enrichment,
and shared social/Want List/loan/trade facts. Selecting an Edition in the popup now
selects its image; the size helper preserves that Edition in the large view. Scanner
IDs, index and its separate TCGdex `art_url` reference path remain valid. This does not
add camera stamp recognition. Linked images need no new scanner COEP permissions.

## Identity evidence and precedence

The curated `catalog_pokemon_promo_art` rows name the exact TCGdex source card,
English display name, collector number and PC product. Active source identity and
standard holo PC descriptor must match; unknown physical facets do not inherit an
exact PC image. Price-mapping product IDs do not select the image.

- Eevee PC uses **610757**, even while the upstream PC price mapping says 610758.
- Charmander PC uses **512036**. The regular-price defect is a separate correction.
- Regular siblings keep existing TCGdex art where present, with `reference=1` to
  bypass a potentially wrong-stamp marketplace large upgrade and reject stale stored
  marketplace bytes. The three Printings without TCGdex art retain their existing
  regular fallback behavior. Other variants retain their existing selection.

The cached 280-product response was fetched **2026-11-04 01:59:48 UTC**, SHA-256
`a5c5a62d3a001a15a9a8de6567fcfca97fd9f69e143b93b5a32a516bd7d19d58`.
The earlier 226-card audit ran **01:59–02:02 UTC**: 19 regular/PC pairs, 35 aligned
and 3 incorrect product IDs among 38. The bounded test fixture preserves relevant
product names, numbers, group 22872, image URLs and image counts from that response.
These are identity facts, not current prices or a license.

Independent read-only visual QA relayed by Ryan inspected all 19 ordinary `200w`
CDN assets at approximately **03:42–03:44 UTC on 2026-11-04**. All returned HTTP 200,
valid JPEG and the correct Pokémon with a visible Pokémon Center stamp; zero failed
or uncertain. Magneton's stamp is low contrast but visible. The fixture records this
provenance and each confirmed PC product. No duplicate image fetching was performed
by this implementation worker.

**Both display sizes link to those inspected 200w assets.** A large view may be soft;
no crisp high-resolution art or inspected `400w`/alternate asset is claimed. There
are no local copies or original-asset backup/recovery obligations added by this design.
The curated configuration and evidence are recoverable from the reviewed Git commit;
public selections are rebuilt from the database through the existing writer.

## Source-rights caveat

User authorization to prepare/use these links is not a third-party license.
[TCGplayer API Terms](https://help.tcgplayer.com/hc/en-us/articles/360061115874-TCGplayer-API-Terms-Conditions)
require express written preapproval and restrict use/display/copy/storage. An applicable
Prizecheck written agreement has **not** been established. Public CDN accessibility
and API image examples do not establish unrestricted rights, and
[current onboarding](https://docs.tcgplayer.com/docs/getting-started) does not grant new
API access. This implementation makes no compliance or permission claim, accepts no
new terms, creates no account and bypasses no denied access. It prepares the requested
links with this known unresolved rights concern; any actual access/terms blocker must
be reported before the affected action. The older ADR 0024 does not prove permission.
TCGdex repository MIT coverage likewise does not establish blanket Pokémon art rights.
Do not upload these scans to TCGdex as a workaround.

## Public selection, caching and compatibility

`/api/public/edition-art/<opaque-edition-ref>/<size>?v=<version>` reads only public
catalog records, then returns a **302 with no-store** to the exact linked URL shape.
It makes no PostgreSQL connection, fetches no pixels and touches no art storage. The
gateway allows only the existing exact CDN host/product pattern for these redirects,
never an arbitrary Location; its art rate limit applies.

The selected image is bound to Edition/Printing references, current mapping revision
and current public review revision. Its version hashes those revisions and the curated
image product. Reviewed image-map edits/removal enqueue every affected Edition in the
existing ordered public outbox. Mapping corrections also change the selection URL,
without substituting the corrected price product for the independent image identity.
The public writer re-reads current committed state and uses existing CAS ordering;
a stale publisher cannot overwrite a newer selection. Prior image URLs fail closed
after the new selection is delivered. Missing/corrupt/inconsistent public state
withholds the PC image.

Published Deck and Discover resolve current Edition art before shared Printing pointers
or frozen URLs, in both sizes and before featured-card ranking. Legacy snapshots with
Edition references pick up the current PC image; legacy PC rows missing those references
remain unavailable until republished, rather than showing regular art. Frozen deck
content/quantities are never rewritten. This extends ADR 0020's current-art exception.
Metadata reads are batched once per page/chunk and respect Discover's request deadline.
No per-row database/network/image-byte work is added to list reads.

Public delivery is asynchronous. Private selection may be newer while delivery is
pending/failed; do not call that a completed public correction. Capture the expected
private/public revisions, pending/attempt/last-error outbox state and resulting URLs.
Retry delivery from committed state rather than replaying a stale selection. The
migration enqueues an initial derived display refresh for affected Printings; it does
not change mappings, bindings, owner decisions, inventory or descriptors. Confirm drain
completion before reporting rollout success. Newly recognized source variants outside
the curated identities require a new reviewed mapping, not automatic marketplace use.

Existing immutable Printing/browser caches cannot be remotely erased. Regular reference
requests get a distinct `reference=1` address. New Edition selection redirects use
no-store; external CDN bytes retain the provider's cache policy and can change at the
same URL. No byte-level permanence or future availability is claimed.

The established `catalog:edition`, quarantine and price payloads remain unchanged,
including their strict readers. A separate protected `art:edition:<ref>` sidecar carries
linked/reference/withheld display selection. The current writer publishes it with the
unchanged Edition and quarantine records in the same CAS/snapshot, using at most 42
Editions per batch (126 keys). Current art reads pin sidecar and parent at one generation
and compare references, descriptor and revisions. Frozen Printing/set/number/physical
variant must also agree before linked/reference/withheld selection is used. Ordinary
Printing mode adds no new eligibility condition: its existing fallback remains available
through source withdrawal/reinstatement, including reverse/staff/first-edition variants.

Art-only missing/mismatched state is derived-display repair, not an unexplained market
timeline: it does not contribute to marketplace recovery conflict, stored mapping-revision
reconciliation or quarantine. Old local readers/writers/rebuilds use the original keys
and payloads, ignoring sidecars. An old writer can advance the parent while leaving a
stale sidecar; the new art reader then withholds the scoped image until fresh delivery /
rebuild, while price/export eligibility retains its original semantics. Rebuild is the
explicit catch-up path after rollback; it does not require another owner decision.

An older HTTP relay may reject the new protected family. HTTP deployments therefore
keep `PUBLIC_ART_SIDECARS` off by default and retain the original two-key publication
path; art readers do not request sidecars there. Upgrade/conformance-check the relay
before explicitly setting `PUBLIC_ART_SIDECARS=on`. File storage uses the existing
format-2 manifest and protects the new family from eviction. No deployment-owned relay
or live configuration was changed here. Compatibility and conformance regressions are
prepared but **unrun**; these source repairs require independent re-review.

Regular-reference protection is immutable scoped policy independent of link availability.
Missing/old/corrupt sidecars, failed public-store access, missing legacy Edition refs or
withdrawal of a PC link cannot permit a known potentially wrong marketplace upgrade.
For the 16 audited reference Printings, a proven safe TCGdex pointer/direct source is
used or the image is unavailable. The three no-TCGdex fallbacks remain unchanged, as
do unrelated variants. A current reference sidecar uses its current TCGdex URLs; an
explicit absence does not silently revive a frozen URL.

Generation promotion compares the small scoped set in the same catalog transaction.
Withdrawal/reinstatement and reference-image input changes stamp/enqueue art even when
price mappings are unchanged. Stored Deck command replies batch-refresh mutable image
URLs on replay while keeping the original command identity, quantities and revision.

## Later operator plan — not executed

1. Review the exact commit, narrow test results, rights caveat and public-record
   compatibility/relay gate. Obtain separate environment-specific release/deployment authority.
2. An authorized operator reads actual Edition/source identities, current price mappings,
   revisions/owner decisions, stored images and public delivery. Existing denied dev SSH
   and signed-in catalog 401 remain unresolved; do not retry with other credentials.
3. Apply the migration only through the separately authorized release process. It seeds
   the reviewed image identities and enqueues derived public display refreshes; it does
   not run the separate Eevee/Charmander price correction commands.
4. Drain and verify the public outbox. Check both regular/PC thumbnails and popup views,
   Collection/leaf Holdings, deck lines, Published Deck and Discover. Verify PC URLs use
   the curated product and both sizes use the inspected 200w asset, while regular art
   remains unstamped reference art. No current USD price is asserted by an art check.
5. To withdraw/change a reviewed link later, use a separately reviewed, authorized
   configuration change and verify its delivered revision and old URLs. An unreachable
   or withdrawn PC link must not fall back to the sibling's regular scan. Restore
   configuration from the reviewed commit and rebuild public records after recovery;
   no image bytes are restored or refetched by this feature.

No live migration, correction, public-record rebuild, sign-in, deployment, merge or
image activation has occurred during preparation. The separate pricing worker owns
pricing correction/runbook work. The final PR must name actual test results, the exact
reviewed version and remaining rollout/rights limitations.
