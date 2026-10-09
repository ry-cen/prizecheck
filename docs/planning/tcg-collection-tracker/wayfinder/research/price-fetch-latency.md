# TCGdex price fetch latency and one-hour caching

Measured on 2026-10-08 from the local macOS execution environment. Planning evidence only; no application implementation or performance guarantee. This note integrates the scoped researcher's returned measurements. The primary separately re-read the official documentation.

The policy proposals below describe the investigation at the time. The owner subsequently selected access-only refresh without a daily fallback, with one-hour/24-hour/three-second behavior in the [accepted refresh contract](../resolutions/22-decide-price-refresh-boundary.md). That contract supersedes this note's proposed schedule; timing observations remain bounded source-fetch evidence.

## Small live sample

Three independent serial `curl` processes per known English card endpoint, each with a ten-second timeout. Each opened a new connection. Initial sandbox DNS attempts failed before reaching the provider; the approved read-only network run produced nine HTTP 200 responses. DNS failures are environment restrictions, not provider outages or successful latency samples. No full catalog, Deck endpoint or application refresh job was benchmarked.

| Source card | Round | TTFB seconds | Total seconds | TCGplayer pricing.updated |
| --- | --- | --- | --- | --- |
| swsh3-136 | 1 | 0.264946 | 0.265197 | 2026-10-07T22:55:02.647Z |
| swsh3-136 | 2 | 0.244009 | 0.244240 | 2026-10-07T22:55:02.647Z |
| swsh3-136 | 3 | 0.255427 | 0.255656 | 2026-10-07T22:55:02.647Z |
| swsh3-20 | 1 | 0.288240 | 0.289701 | 2026-10-07T22:55:02.647Z |
| swsh3-20 | 2 | 0.270527 | 0.270860 | 2026-10-07T22:55:02.647Z |
| swsh3-20 | 3 | 0.266026 | 0.266190 | 2026-10-07T22:55:02.647Z |
| sv03-223 | 1 | 0.269609 | 0.270084 | 2026-10-07T22:55:06.584Z |
| sv03-223 | 2 | 0.282139 | 0.282328 | 2026-10-07T22:55:06.584Z |
| sv03-223 | 3 | 0.265155 | 0.265539 | 2026-10-07T22:55:06.584Z |

Mean total: **0.267755 seconds**. Median: **0.266190 seconds**. Range: **0.244240–0.289701 seconds**. Primary API sources: [Furret](https://api.tcgdex.net/v2/en/cards/swsh3-136), [Charizard VMAX](https://api.tcgdex.net/v2/en/cards/swsh3-20), [Charizard ex](https://api.tcgdex.net/v2/en/cards/sv03-223).

Illustrative arithmetic, not measured Deck behavior: 35 unique source cards at this mean would take about 9.4 seconds serially. Five concurrent requests would ideally reduce that to about seven waves, roughly 1.9 seconds, before queueing, contention, validation, persistence and public projection work. A 60-copy Deck does not require 60 requests when copies share source Printings. A full card response contains finish pricing, so duplicate copies/variants can share a source fetch while exact Edition price selection remains separately validated. [TCGdex pricing guide](https://tcgdex.dev/markets-prices).

Connection reuse, hosting geography, provider load, request concurrency and failure handling may change timings. No p95/p99, production workload, pooled-connection measurement, launch latency bound or sustained request-rate test is established by nine samples.

## What a one-hour expiry means

TCGdex documents TCGplayer update frequency as **hourly to daily**, while the same page's general overview advertises hourly TCGplayer updates. It provides no freshness SLA. Prices are embedded in the card response; fetching more often cannot force the upstream price to change. All three cards returned unchanged previous-day provider timestamps across this short sample. [Pricing guide](https://tcgdex.dev/markets-prices).

TCGdex publishes no hard rate limits and recommends local caching rather than repeated bulk requests. That is not unlimited throughput permission or a latency guarantee. [FAQ](https://tcgdex.dev/faq).

A one-hour **application cache expiry** should be measured from the last successful validated source check, including a confirmed unavailable result. A unchanged old provider timestamp must not immediately expire the just-checked cache and cause requests on every view. Failed requests require bounded backoff and keep the accepted cached-price/age behavior. **Provider price age** remains based on pricing.updated; a new fetch cannot reset it. The previously accepted 48-hour stale/unknown-age presentation and uncertain-mapping rules remain in force unless explicitly changed by the owner.

Proposed behavior awaiting the owner: show locally cached prices immediately; an authenticated card/Deck view queues a shared refresh when its source check is missing or at least one hour old; coalesce concurrent requests for a source Printing; retain bounded background work and daily owned/published coverage for unvisited cards. Anonymous Published Deck views continue reading public projections without provider calls or private database wakeups. A cold cache shows pending/unavailable data until a quote is validated. This note proposes an expiry rule, not a selected refresh mechanism or resolved product contract.

## Routing

The Laya MCP route call was unavailable. The CLI returned a low-confidence orchestrator selection; the primary chose a researcher for bounded external measurement. The CLI reported logging permission failure; MCP lifecycle recording succeeded with task 73d5e6a38f8d4c5e9e75a725151e7f50. The researcher returned measurements and the primary wrote this integration note. No child delegated or changed application files.
