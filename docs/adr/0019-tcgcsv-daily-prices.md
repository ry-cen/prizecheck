# Price every card from one daily TCGCSV snapshot stored in PostgreSQL

**Status:** proposed 2026-10-27 (planning decision, not yet implemented). Supersedes these parts of other ADRs:

- **[ADR 0006](0006-access-triggered-price-refresh.md):** its refresh policy is superseded (the one-hour, 24-hour and
  three-second age bands, admission, waiting for a fetch, and coalesced in-flight work). Two of its rules still apply: no
  user has a manual price-refresh control, and anonymous Published Deck access makes zero PostgreSQL connections and reads
  no private inventory.
- **[ADR 0013](0013-import-pricing-seeds-the-price-cache.md):** catalog imports no longer seed prices. Its viewport rule
  still applies: a price slot asks only when it comes near the viewport.
- **[ADR 0008](0008-price-runner-liveness.md):** superseded once the runner is removed.
- **[ADR 0007](0007-edition-marketplace-metadata-boundary.md):** refined, not superseded. The reviewed product mapping
  still decides which product an Edition is.
- **[ADR 0018](0018-scheduled-catalog-change-check.md):** its `catalog-refresh` job gains a price step.

The plan is in [TCGCSV prices tickets](../planning/tcgcsv-prices/tickets.md).

## Context

Prices came from TCGdex's copy of TCGplayer prices. They were fetched when a collector looked at a card, and seeded from
catalog pulls. On production this left whole promo sets unpriced:

- TCGdex lists the TCGplayer product (`thirdParty.tcgplayer`) for svp, mep and swshp cards but carries no TCGplayer price
  for them.
- Shadowless and 1st Edition base cards have no TCGdex price lines.
- Seeding stops at a 10-minute budget and only reached about a quarter of the catalog
  ([#342](https://github.com/ry-cen/prizecheck/issues/342)).
- A card that was not cached waited up to 2.5 s and then said "unavailable".

TCGCSV (tcgcsv.com) republishes TCGplayer's catalog and prices once a day, about 20:00 UTC. It covers 220 Pokémon groups,
about 33,000 products and 45,000 price rows, one row per product and subtype. Its guidance is: fetch in bulk, never from a
user-facing request, and a thank-you link is appreciated. The owner decided on 2026-10-27:

- every card price comes from TCGCSV only, with no fallback source;
- the FAQ is taken as permission;
- the vintage gap is acceptable where no TCGplayer product exists, but modern promos must be priced;
- Printings with no TCGdex image use TCGCSV's product image link.

## Decision

- **A daily bulk import, run from the host.**
  - `catalog-refresh` (ADR 0018's host timer, 04:00 UTC) first runs the price import:
    `scripts/price_import_job.py` in the API image.
  - The job reads `last-updated.txt`, then each group's `/products` and `/prices`, about 450 requests a day, one at a time,
    with a User-Agent and bounded retries.
  - It upserts `tcgplayer_product` and `tcgplayer_price` (keyed by product and subtype) and records the run in
    `price_import`.
  - No request path calls TCGCSV.
- **Never blank.** Rows are upserted and never deleted. A failed or empty group keeps its last rows and their dates, and
  the run is recorded `partial` or `failed`.
- **The product is reviewed; the subtype is derived.**
  - An Edition's TCGplayer product is still its verified marketplace mapping (ADR 0007).
  - A pure rule picks the subtype from the Edition's physical descriptor (finish, 1st Edition stamp) among the subtypes
    TCGCSV lists for that product, and stores the result in `edition_price_binding`. For example, base1-4 Shadowless binds
    to "Unlimited Holofoil" and 1st Edition Shadowless to "1st Edition Holofoil".
  - When two verified Editions would read the same product row, neither is priced.
  - `quote_variant` is no longer a price input.
- **Matching rule v4** verifies an Edition from TCGdex's own per-variant TCGplayer id when TCGdex carries no price block.
  - **Black Star promos without ids.** Every Black Star promo set, Wizards era through ME (basep, np, dpp, hgssp, bwp,
    xyp, smp, swshp, svp, mep), maps to its TCGCSV group in a reviewed table. A card with no TCGdex id is verified only
    when exactly one product on its card number has exactly its name, with only a trailing card-number qualifier
    removed. Products named with qualifiers (Staff, Prerelease, LV.X, Cosmos Holo) never match. On 2026-10-27 this priced
    about 256 promo cards, mostly dpp, bwp, xyp and mep, and left about 133 for the owner.
  - **Owner review.** The owner reviews the matches from a "Matched by card number" list and can reject any of them.
  - It is activated like every rule. Quarantine, owner decisions and strict clearing are unchanged.
- **One read path.**
  - Card prices, Deck cost, Want List cost, Trade value and the stored reads on write paths read one PostgreSQL query:
    Edition, mapping, binding and price.
  - Nothing is admitted, launched or waited on.
  - **Market price only.** Collectors see the TCGplayer market price. When it is empty they see no price; there is no
    fallback to mid or low (owner decision).
  - A product TCGplayer delists keeps its last known price indefinitely (owner decision).
- **Published Deck pages stay off PostgreSQL.** The job publishes one public `price:<edition ref>` record per priced
  Edition into the public record store (mapping revision, product and amount only). The public cost route checks each
  record against the Edition's public marketplace record.
- **Fallback art.** A Printing that has no TCGdex image in either the active generation or its established display shows
  TCGplayer's CDN image of a verified Edition's product (`_200w` for tiles, `_400w` for detail). The images are linked, not
  copied. A TCGdex image always wins, including one added later. The scanner page and its index stay TCGdex-only: the
  scanner page is cross-origin isolated, and TCGplayer's CDN sends no CORS header.
- **Retired.** These go once production has priced from TCGCSV for a week:
  - the price runner, launcher, admission, refresh and seeding modules;
  - the runner lock directory;
  - the record store's quote, result, fence, work, lease, admission and backoff records.
- **Visibility.**
  - Owner controls shows each import's outcome, TCGCSV's update time, failures, coverage and fallback-art counts. It warns
    when the last good run, or TCGCSV's own update time, is over 48 hours old.
  - Collector screens show no time or refresh state ([AGENTS.md](../../AGENTS.md)).
  - **Footer credit.** By the owner's explicit exception to AGENTS.md's no-provenance rule, the signed-in shell and the
    public pages end with one footer line, "Prices from TCGCSV", linking tcgcsv.com. It is the only collector-visible
    provenance this decision adds.
- **Fix forward only.** No step restores TCGdex prices, and the earlier release is never redeployed for that. A broken
  release is handled by:
  - a `PRICE_READS=off` switch that hides every price without a code change;
  - a TCGCSV data repair (re-import or restore the price tables);
  - a follow-up release.

## Considered options

- **Keep TCGdex prices and add TCGCSV for the gaps.** Rejected by the owner: one consistent snapshot, no second source.
- **Fetch TCGCSV when a card is opened.** Rejected: TCGCSV asks for no user-facing requests, and a daily source gains
  nothing from it.
- **Store only per-Edition prices.** Rejected: keying by product and subtype keeps the snapshot independent of mapping
  changes. A remapped Edition is priced at its next binding without a refetch.
- **Let Published Deck cost read PostgreSQL.** Rejected: it would reverse the anonymous isolation that ADR 0006 and the
  Published Deck design keep, for a saving of one record family.
- **Fall back to TCGplayer's mid or low price when market is empty.** Rejected by the owner.
- **Keep an emergency rollback to the TCGdex readers.** Rejected by the owner: fix forward only.
- **Copy TCGplayer images to our own volume.** Rejected for now: it adds storage and a serving path, and makes us
  redistribute the images. The owner chose links.

## Consequences

- **Daily prices.** Prices are the same for everyone, up to a day old, and never wait. "Checking prices…" lasts one query.
- **Unpriced Editions.** A card TCGplayer has no product for, or whose market price is empty, is unpriced. The owner panel
  counts each reason.
- **Prices outlive delisting.** A delisted product keeps its last price indefinitely.
- **The v4 activation is a long job on production.** It re-evaluates about 9,000 Editions, so it runs on the host at a
  quiet time until [#343](https://github.com/ry-cen/prizecheck/issues/343) makes activation a background job.
- **Duplicate prices.** Prices live in PostgreSQL and in the public store. They can differ for the length of one import
  run.
- **Rollback.** The cutover is staged: one release imports, binds and publishes while the old readers still serve, and the next switches the readers. There is no path back to TCGdex prices. Mistakes are hidden with `PRICE_READS=off`, repaired in TCGCSV data, or fixed by a follow-up release.
- **A visible TCGCSV credit.** This departs from the provenance rule in AGENTS.md, by the owner's decision. AGENTS.md is left unchanged; this ADR records the exception.
- **Card-number matching can mis-price a stamped promo** that TCGdex records without its stamp. The owner's review list is the control.
- **Published Deck snapshots** keep the art they were published with. A republish picks up fallback art.
- [#342](https://github.com/ry-cen/prizecheck/issues/342) (seeding budget) is superseded.
