# TCGplayer pricing API access

Checked: 2026-10-08. Sources: official TCGplayer and TCGdex documentation. Researcher investigated TCGplayer; primary session verified access policy and investigated TCGdex as an alternative. No application behavior changed.

## Finding

TCGplayer has documented pricing APIs, but they require developer credentials and are closed to new access. Its current guide says: “We are no longer granting new API access at this time.” A public documentation site does not mean an anonymous or newly available API. [Getting Started](https://docs.tcgplayer.com/docs/getting-started)

## Authentication and documented endpoints

The guide describes developer public/private keys, a client-credentials request to `POST https://api.tcgplayer.com/token`, and bearer authentication on subsequent requests. It identifies the documentation version as v1.39.0. Existing credentials were not available to test; endpoint operability and an exception for this application remain unverified. [Getting Started](https://docs.tcgplayer.com/docs/getting-started)

| Documented endpoint | Data |
| --- | --- |
| [`GET /pricing/group/{groupId}`](https://docs.tcgplayer.com/reference/pricing_getgroupprices) | Product prices for a group, often a set: product ID, low/mid/high, market, direct-low, and subtype. |
| [`GET /pricing/sku/{skuIds}`](https://docs.tcgplayer.com/reference/pricing_getproductconditionprices-1) | SKU-level low, shipping, listing, market, and direct-low prices. |
| [`GET /pricing/marketprices/{productconditionId}`](https://docs.tcgplayer.com/reference/pricing_getmarketpricebyproductconditionid-1) | A SKU's market price and low/high ranges. |

Pricing reference pages display an update age of over seven years. Treat them as documented capabilities, not proof of present access or a successful live request. [Group pricing reference](https://docs.tcgplayer.com/reference/pricing_getgroupprices)

## Access and permitted use

TCGplayer's published API terms limit access to a specifically approved purpose and describe restrictions on competing applications, mixing price sources, redistribution for commercial or competitive purposes, automated collection outside the API, and acquisition of automatically collected content through third parties. They also require attribution and a relevant TCGplayer link when displaying prices. This note does not determine whether this tracker or a third-party feed has permission; that remains unverified. [API Terms & Conditions](https://help.tcgplayer.com/hc/en-us/articles/360061115874-TCGplayer-API-Terms-Conditions)

An older help article describes partner pricing APIs, but it does not establish that applications are currently accepted. The more explicit developer guide says new access is closed. A bespoke arrangement would need confirmation from TCGplayer rather than an assumption based on this page. [Pricing-data help](https://help.tcgplayer.com/hc/en-us/articles/201577976-How-can-I-get-access-to-your-card-pricing-data), [Getting Started](https://docs.tcgplayer.com/docs/getting-started)

## Alternative relevant to this tracker: TCGdex

TCGdex documents optional `pricing.tcgplayer` data on card objects. Variant entries can contain `marketPrice`, `lowPrice`, `midPrice`, `highPrice`, and `directLowPrice`; its example contains currency and pricing-update time. The card metadata `updated` timestamp explicitly excludes price updates, so pricing freshness must be tracked separately. [Card reference](https://tcgdex.dev/reference/card)

TCGdex says its API is free and needs no API key. It recommends caching bulk responses. Its FAQ acknowledges missing prices and incorrect marketplace mappings, including different printings mapped to the same listing. It describes improved per-variant marketplace IDs as in development; this research did not verify rollout or live coverage. [FAQ](https://tcgdex.dev/faq)

The tracker already imports TCGdex card records, but has no implemented price feature. `api/app/catalog.py` excludes pricing keys from variant descriptors; the active specification lists valuation outside the existing MVP. [Catalog normalization](../../../../api/app/catalog.py), [Current specification](../../spec.md)

Inference: TCGdex is a practical candidate to investigate for price display without a new direct TCGplayer key. It is not yet a validated price feed for this tracker. Before designing valuation, verify representative live records, exact edition-to-price mapping, missing/stale behavior, refresh needs, and permitted downstream use. Neither documentation availability nor free API access establishes downstream data rights.

## Research process

The original Laya call used `risk="low"`, but the local router accepts only `normal` or `high`. This invalid argument caused the generic tool error; the router was operational. A subsequent diagnostic reproduced the failure with `low` and succeeded with `normal`. The corrected call recommended researcher with low confidence and selected orchestrator; the primary's researcher assignment follows the documented role criteria. Lifecycle recording succeeded. Research used first-party documentation and repository inspection. No credentials, live authenticated TCGplayer requests, pricing implementation, or production changes were involved.
