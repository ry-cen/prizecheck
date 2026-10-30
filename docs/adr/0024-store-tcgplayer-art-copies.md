# Store TCGplayer's largest image when it is sharper, and serve art publicly

**Status:** accepted on 2026-10-30. The owner decided it in [#361](https://github.com/ry-cen/prizecheck/issues/361) ([resolution](../planning/card-art-store/wayfinder/resolutions/decide-tcgplayer-art-copies.md)). It supersedes the "linked, not copied" part of [ADR 0019](0019-tcgcsv-daily-prices.md)'s fallback art and its rejected option "Copy TCGplayer images to our own volume". It amends [ADR 0020](0020-card-art-store.md): TCGplayer becomes a stored source, and the art route is no longer signed-in only.

**Context.** ADR 0020 stores TCGdex art on first request and counts hits, so that the most-used images could later be upgraded. ADR 0019 links TCGplayer's CDN image for Printings with no TCGdex art, and its #360 amendment makes the route answer `302` to that link. The largest TCGplayer image (`_in_1000x1000.jpg`) is about 717×1000 for modern products, against TCGdex's 600×825 `high.webp`. Some older products stop at 600×825 or smaller. No TCGplayer or TCGCSV terms that could be read permit storing and re-serving the images, and the TCGplayer API is closed to new developers.

**Decision.**

- **Copies are stored.** The art store fetches and stores TCGplayer's `_in_1000x1000.jpg` for a Printing with a verified TCGplayer product, as that Printing's `large` art. The address is built from an integer product id, never copied from TCGCSV. Small art does not change.
- **Only when sharper.** The TCGplayer image replaces TCGdex's `high.webp` only when it has more pixels than 600×825. For a Printing without TCGdex art it replaces the linked `_400w` when it is at least 400×558. A TCGdex image that is sharper always wins.
- **On demand.** The upgrade happens on a Printing's first `large` request, through the same rate limit, caps and failure backoff as TCGdex art. There is no batch job and no hit threshold. The hit counts stay as a record.
- **Disk.** The images go in the existing `ArtStorage` directory as JPEG, unconverted. The worst case, every matched Printing, is about 2.3 GB.
- **Public pages use the route.** The Published Deck page and the public catalog show art from `/api/art`, which answers signed-out requests.
- **An off switch.** A setting turns the TCGplayer source off. TCGplayer art then goes back to links, and its stored objects can be deleted.

**Considered options.**

- **Keep linking (ADR 0019).** Rejected by the owner: stored copies give sharper large art, and a same-origin copy works where a link cannot.
- **Ask TCGplayer for written permission first.** Not taken. The owner accepts the terms risk; the off switch is the response to a takedown request.
- **Store `_400w` and `_200w`.** Rejected: `_400w` is smaller than TCGdex's `high.webp`.
- **Always replace TCGdex art.** Rejected: some TCGplayer images are no larger than TCGdex's, or are smaller.
- **Backfill every matched Printing, or upgrade the top Printings by hits.** Rejected: there was only 2 days of hit data, and an on-demand upgrade costs nothing for Printings no one opens.
- **Object storage.** Not needed at about 2.3 GB on a disk with 87 GB free. `ArtStorage` still allows it later.

**Consequences.**

- **We redistribute TCGplayer's images without written permission.** The launch checklist records the risk and the takedown steps.
- **The first large view of a Printing may fetch twice:** once from TCGdex and once from TCGplayer, until the comparison is recorded.
- **Signed-out traffic reaches the art route.** It needs abuse limits and a public cache policy, so ADR 0020's `private` caching and signed-in rule no longer hold for public pages.
- **Public art meets the Published Deck's zero-connection rule.** ADR 0006, as kept by ADR 0019, says anonymous Published Deck access makes zero PostgreSQL connections. Art requests from that page would reach the route, which reads PostgreSQL. Public art is served from pointer files stored next to each image, with no database read ([ADR 0020](0020-card-art-store.md), amendment for #438 and #439), so the rule holds.
- **ADR 0020's guardrail and allowed-host list change.** The fetcher accepts `tcgplayer-cdn.tcgplayer.com`, but only for product image addresses.
