# Decide: store TCGplayer images and upgrade Printings' large art

**Ticket:** [#361](https://github.com/ry-cen/prizecheck/issues/361), part of the Card art store feature ([#358](https://github.com/ry-cen/prizecheck/issues/358) to [#361](https://github.com/ry-cen/prizecheck/issues/361)).
**Resolved:** 2026-10-30. The owner answered the collector-facing questions one at a time; Claude settled storage, which the owner delegates.
**Records:** [ADR 0024](../../../../adr/0024-store-tcgplayer-art-copies.md), which supersedes ADR 0019's "linked, not copied" for TCGplayer art and amends [ADR 0020](../../../../adr/0020-card-art-store.md).

## Evidence put to the owner

- **Sizes (measured 2026-10-30, 12 random matched Printings).** TCGdex `high.webp` is 600×825 and averages 78 KB. TCGplayer's `_in_1000x1000.jpg` is the largest the CDN serves: about 717×1000 for modern products (116 KB on average), but some older products stop at 600×825, and one sample at 200×280. `_400w` is 400×558 (67 KB), smaller than TCGdex's `high.webp`. `_1000x1000.jpg` without `in_` answers 403. Side by side, TCGplayer's largest is a little sharper on modern cards and no different on vintage ones.
- **Terms.** No source the research could read permits storing and re-serving TCGplayer images. The TCGplayer Terms of Service (search snippets, as the page answered 403) say its material "may not be used in connection with any service or product outside of TCGplayer without express written permission". The TCGplayer API is closed to new developers. TCGCSV's FAQ grants implicit permission for TCGCSV's data only, and on card images says "For the most part, you can't." The owner accepted this risk.
- **Production (2026-10-30).** 4 accounts, 2 days of hit data: 782 small and 102 large objects stored (27 MB), at most 6 hits on one Printing. 79 Printings are held. 20,762 Printings have a price binding to a TCGplayer product; 1,382 have no TCGdex art and use the TCGplayer fallback. The boot volume is 96 GB with 87 GB free; the ticket's "about 47 GB" was wrong.

## Owner answers

1. **Copies are allowed.** Store and re-serve TCGplayer images, reversing ADR 0019's "linked, not copied". No written permission from TCGplayer was obtained; the owner accepts the terms risk.
2. **Resolution: the largest.** Store `_in_1000x1000.jpg` as a Printing's `large` art. `_400w` is not stored, since it is smaller than what TCGdex gives. Small art is unchanged: TCGdex's `low.webp`, or the linked `_200w` fallback.
3. **Replace when sharper.** The TCGplayer large image replaces TCGdex's `high.webp` only when it is larger than TCGdex's (more pixels than 600×825). For the 1,382 Printings without TCGdex art, the stored TCGplayer large image replaces the linked `_400w` whenever it is at least as large as 400×558.
4. **On demand when viewed large.** No hit threshold and no batch job. A Printing gets its TCGplayer large image the first time anyone opens its large view, as the read-through store already works. Storage grows only with use; every matched Printing would come to about 2.3 GB.
5. **Public pages use the route too.** Signed-out pages (Published Deck, public catalog) show art from the art route, so they get the same art as signed-in pages, stored TCGplayer copies included.

## Delegated decision

- **Storage: the existing disk store.** The `ArtStorage` directory under `PRIZECHECK_DATA_DIR`. The worst case is about 2.3 GB against 87 GB free, so object storage is not needed now. The interface still allows it later.
- **Format: keep the source JPEG.** Store and serve TCGplayer's bytes as `image/jpeg` (already in the store's allowlist), with no conversion.

## Not decided here

These are for the planner who turns this into tickets: how the version (`?v=`) changes when a Printing's large source changes, given that today one version covers both sizes; what a first large view serves while the TCGplayer image is being fetched and compared; how the size comparison is recorded so that a TCGplayer image that loses is not fetched again; the abuse limits for signed-out requests to the route; and how public art keeps the rule (ADR 0006, kept by ADR 0019) that anonymous Published Deck access makes zero PostgreSQL connections, or whether that needs the owner.

## Draft follow-up tickets

For the owner to approve before they are filed as `implementation` issues under `feature: card art store`.

1. **Card art store: store TCGplayer's largest image as a Printing's large art when it is sharper.**
   Add `tcgplayer-cdn.tcgplayer.com` to the art fetcher's allowed hosts, but only for `product/{int}_in_1000x1000.jpg` addresses built from a verified product id (the edition price binding or `catalog_printing_fallback_art`), never a URL from TCGCSV. On a Printing's first `large` request, fetch that image, read its dimensions, and keep it when it beats TCGdex's `high.webp` (more pixels than 600×825), or beats the `_400w` fallback for Printings without TCGdex art. Record a comparison that loses so it is not refetched. Keep the 5 requests a second limit, the 2 MiB cap, the magic-byte check and the failure backoff. Change the version when the large source changes. Add a setting that turns the TCGplayer source off, so TCGplayer art goes back to links and its stored objects can be deleted. Done when: a Printing with a sharper TCGplayer image serves it from `/api/art/{id}/large` after one view; a Printing whose TCGplayer image is smaller keeps TCGdex art and makes no second fetch; a TCGplayer-only Printing's large view no longer answers 302; with the setting off, the route behaves as it does today; the storage contract and art route tests cover each case.
2. **Card art store: signed-out pages show art from the art route.**
   Open `/api/art/{printing_id}/{size}` to signed-out requests (a public cache policy in place of `private`, with abuse limits), and have the Published Deck page and the public catalog read route addresses in place of `low_image_url`. Done when: a signed-out visitor sees the same art as a signed-in collector on both pages; anonymous responses still carry no direct TCGdex or TCGplayer addresses for stored art; the guardrail and API tests cover the public reads.
3. **Docs: record the TCGplayer image risk in the launch checklist.**
   Add a line saying that stored TCGplayer images are served without written permission, and that a takedown request is answered by turning the TCGplayer source setting off and deleting its stored objects. Done when the checklist names the setting and the deletion step.
