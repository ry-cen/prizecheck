# TCGdex pricing coverage for exact card editions

Checked: 2026-10-08. Scope: read-only review of TCGdex first-party documentation, repository card-variant normalization, and representative direct API reads. No application files or existing research notes were changed. A minimal sanitized sample fixture is saved alongside this note as [`tcgdex-pricing-samples.json`](tcgdex-pricing-samples.json). Claims below are marked documented, tested, or unverified.

## Findings

TCGdex documents optional `pricing.tcgplayer` data on a full card response. The pricing guide's example uses `unit: "USD"`, an ISO `updated` time, and finish-keyed objects with `marketPrice`, `lowPrice`, `midPrice`, `highPrice`, and `directLowPrice`. Its sample shows `normal` and `reverse` prices for Furret (`swsh3-136`); its prose says TCGplayer data is USD and has separate normal, reverse-holo, and holo prices. Treat `marketPrice` as the likely displayed USD estimate because it is explicitly the marketplace market field; this is a product mapping inference, not a TCGdex guarantee that it matches a physical printing exactly. [Pricing guide](https://tcgdex.dev/markets-prices)

There is a documentation inconsistency. The Card reference lists keys including `normal`, `holofoil`, `reverse-holofoil`, `1st-edition`, and `unlimited`, and describes `updated` and `unit` as Numbers; the pricing guide's concrete example uses ISO string `updated`, string `unit`, and `normal`/`reverse` keys. Consumers should accept observed key aliases and preserve the source payload, rather than assuming either prose table is fully current. [Card reference](https://tcgdex.dev/reference/card), [Pricing guide](https://tcgdex.dev/markets-prices)

TCGdex's FAQ says absent pricing means the card is not listed, is too new, or has regional coverage gaps. It also says distinct printings can map to the same marketplace listing and therefore show identical prices. The FAQ describes explicit marketplace IDs in `variants_detailed` as forthcoming work; that page does not establish that per-variant marketplace IDs have shipped. [TCGdex FAQ](https://tcgdex.dev/faq)

The application's current Edition/Variant model matters: [`catalog.py`](../../../../api/app/catalog.py) removes `pricing`, `tcgplayer`, and provider `variantId` from identity descriptors, but it does not exclude `thirdParty`. Live records now confirm `thirdParty` contains marketplace product IDs. Since the whole `variants_detailed` entry otherwise becomes a descriptor, these IDs can affect the current application variant descriptor/Edition identity. That is an identity seam to resolve in the implementation plan: carrying price lookup metadata must not silently redefine physical Edition identity. The project card identity research says provider variant IDs must not be taken as authoritative. TCGdex's legacy variant booleans identify normal/reverse/holo availability, but marketplace keys still do not consistently equal those labels. If an Edition is `Unspecified Variant`, assigning it one particular finish price would assert information the Edition does not carry. Leave it unpriced or require a deliberate user/product rule for selecting a finish or aggregate; the choice remains open.

TCGdex says pricing is embedded in full card records, requires no separate endpoint or API key, has no published hard rate limit, and recommends locally caching bulk responses. The pricing guide claims TCGplayer refreshes hourly to daily; the FAQ/card reference say pricing update timestamps are independent of the card `updated` timestamp. Use `pricing.tcgplayer.updated` as the only documented pricing freshness signal when present; store application fetch time separately. No maximum age, price SLA, retention period, or hard refresh quota is documented in the pages reviewed. [FAQ](https://tcgdex.dev/faq), [Pricing guide](https://tcgdex.dev/markets-prices), [Card reference](https://tcgdex.dev/reference/card)

## Coverage and evidence status

| Case | What official docs establish | Live API status in this check |
| --- | --- | --- |
| Regular/non-holo | Furret `swsh3-136`: `normal.marketPrice` USD 0.25; `thirdParty.tcgplayer` is 219333 | **Tested live**; the corresponding reverse price has the same product ID |
| Reverse holo | Furret `swsh3-136`: `reverse-holofoil.marketPrice` USD 0.43 | **Tested live**; TCGdex duplicates the complete finish-price map under both detailed variant entries |
| Holo | Charizard VMAX `swsh3-20`: `holofoil.marketPrice` USD 41.68 | **Tested live**; detailed type `holo`, provider product ID 219233 |
| Special/alternate illustration or stamped variants | FAQ acknowledges distinct printings can incorrectly share a listing; detailed marketplace IDs are described as in development | **Unverified**; do not infer a special printing's price from a card-name match |
| Basic Energy | Fire Energy `base1-98` (`category: Energy`) has USD normal `marketPrice` 0.46 | **Tested live**; TCGdex reports multiple detailed print variants, including first-edition/shadowless metadata whose nested TCGplayer pricing is null. Card-level price and detailed per-variant data therefore do not always have a one-to-one shape |
| Promo | No promo-specific price coverage or mapping guarantee found in reviewed docs | **Unverified** |
| No listing / stale feed | FAQ documents omitted pricing for unlisted, new, or regional cards; timestamps are separate from card metadata updates | Behavior is documented, exact live sample records unverified |

Direct read-only GET requests were made to TCGdex's official HTTPS API after the execution environment permitted network access. Successful records were Furret (`swsh3-136`), Fire Energy (`base1-98`), and Charizard VMAX (`swsh3-20`). These verify example regular/reverse/holo market fields, USD currency, ISO update timestamps, product IDs, and per-variant nesting. The sanitized relevant fields are captured in the fixture. Three candidate IDs (`sv3-199`, `sv3pt5-1`, `sv1-151`) returned HTTP 404 and one (`swsh12-1`) returned HTTP 404; these are request/ID selection failures, not evidence that promo/special pricing is unsupported. No successful promo or special-illustration sample was verified. Request output was limited to these representative card lookups; no bulk catalog was fetched.

## Exact Edition implications and open decisions

- Decide whether prices are attached to exact Card Editions only where a TCGdex source card ID and finish mapping are known, while `Unspecified Variant` stays unpriced, or whether users can select/override a finish.
- Decide whether a deck total excludes Editions without a price, and how the UI reports partial totals and the count of unpriced cards. No feed means “unknown”, not zero.
- Decide price-age threshold and refresh behavior. TCGdex recommends caching and documents a provider timestamp, but does not publish a freshness SLA or mandatory client interval.
- Decide whether price data may be retained/displayed under the app's use case. TCGdex describes free API availability, but the reviewed pages do not spell out downstream price redistribution rights or an attribution requirement.
- Confirm current schema at runtime before rollout: support documented and guide-example finish aliases, validate currency, tolerate missing/null fields, and do not use card-level `updated` as price freshness.

## Alternatives and recommendation context

The existing TCGplayer API note records that TCGplayer's own API is documented but new API access is currently closed, requires credentials, and carries use restrictions; its published pricing references are old. TCGdex offers a technically simpler feed candidate because it embeds optional USD TCGplayer data without a key, but its own FAQ documents mapping errors and missing prices. Therefore it is a candidate for indicative cost display only after exact-Edition matching and downstream-use rights are resolved, not a verified valuation source. [TCGplayer access guide](https://docs.tcgplayer.com/docs/getting-started), [TCGplayer API terms](https://help.tcgplayer.com/hc/en-us/articles/360061115874-TCGplayer-API-Terms-Conditions), [TCGdex FAQ](https://tcgdex.dev/faq)

## Research process

Read official TCGdex Card reference, pricing guide, FAQ, and the existing TCGplayer API note; inspected `api/app/catalog.py` variant normalization; made bounded read-only HTTPS GET requests for representative records. No bulk endpoint was crawled. Writes were limited to this note and its sanitized fixture.
