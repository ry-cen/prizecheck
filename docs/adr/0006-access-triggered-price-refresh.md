# Refresh accessed card prices after one-hour cache expiry

**Status:** accepted — owner instruction, 2026-10-08. Superseded in part by [ADR 0019](0019-tcgcsv-daily-prices.md): prices now come from one daily TCGCSV import, so the one-hour, 24-hour and three-second age bands, admission, waiting for a fetch and coalesced in-flight work no longer apply. No manual price-refresh control and zero PostgreSQL connections for anonymous Published Deck access still apply.

During [Decide price refresh scope and workload bounds](https://github.com/ry-cen/prizecheck/issues/41), the owner directed: “lets only update cards that are accessed and have stale prices”, following discussion of a one-hour cache expiry. This replaces the earlier daily refresh preference, including the proposed daily fallback for unvisited owned or published cards.

Price refresh is access-triggered. The owner requested a maximum acceptable age before synchronous refreshing and then accepted the proposed thresholds with “yes lets go with that”. Time since the last successful validated source check determines behavior:

- Under one hour: use the cache.
- At least one hour but under 24 hours: show cached prices and refresh eligible accessed source cards in the background.
- At least 24 hours, unknown cache-check age, or no validated cached result: attempt refresh before displaying the accessed prices.

Only the price and Deck cost displays wait, with “Checking prices…” while other page information loads. The entire interactive price request has a three-second wait budget, not three seconds per card. On timeout or failure, display defensible cached quotes with an explicit refresh-failure/age explanation, or unavailable if no quote exists. Coalesce concurrent requests and apply bounded retry backoff so repeated visits do not repeatedly block. A Deck cost request covers all included cards, independent of Holdings pagination. Owning, publishing or previously accessing a card alone does not create recurring hourly work; no daily fallback refreshes unaccessed cards.

The one-hour threshold measures time since a successful validated source check, not time since the marketplace quote changed. An unchanged provider timestamp does not immediately re-expire a just-checked cache. Provider pricing timestamps continue to determine displayed quote age; the accepted 48-hour stale label, unknown-age behavior, exact-Edition mapping, coverage and retained defensible quotes after fetch failure remain in force. Cache a confirmed unavailable result for one hour, mark its Edition unpriced and reduce coverage. Failed or ambiguous responses retain defensible cached state without falsely advancing the successful-check time. Partial successes apply independently. Confirmed unavailability supersedes older quotes rather than allowing them to reappear after a failed retry.

The owner accepted the remaining access/absence choices with “yes to all”: displayed prices in card information and rendered catalog/Holding rows count as access, as do complete private and Published Deck costs, including anonymous visitors. Links alone do not trigger refresh. Quotes and in-flight work are shared with bounded requests/retries across collectors.

The owner then explicitly corrected the manual-control choice: “ok we do not want the owner of the deck to be able to refresh prices no users should have access to manually refresh”. **No user has a manual price-refresh control**, including Deck owners and site administrators. Do not expose a Refresh prices button, user-callable manual/force-refresh action or cache-expiry override. Automatic access-triggered work and its bounded internal retries remain the only feature refresh paths. Reloading a page may trigger an eligible automatic check but cannot bypass the shared cache expiry or backoff.

Published prices relate to fixed published cards rather than current private Holdings. Anonymous access must use only public snapshot/quote data, with zero PostgreSQL wakeups and no private inventory reads. Non-price page content remains independent of TCGdex; the price display may wait up to three seconds under the hard expiry rule. The [Published Deck decision](https://github.com/ry-cen/prizecheck/issues/39) owns the public-only storage/coordination mechanism, old snapshots, revocation/version correctness and architect review of that concrete design. This ADR selects product behavior, not that architecture. The [refresh resolution](../planning/tcg-collection-tracker/wayfinder/resolutions/22-decide-price-refresh-boundary.md) holds the full contract and later handoff examples.

This supersedes the daily schedule in [the card-price presentation resolution](../planning/tcg-collection-tracker/wayfinder/resolutions/18-decide-price-contract.md) and the daily/hourly-plus-daily proposals in the refresh ticket. Historical wording is retained there. No application implementation, scheduler or cache mechanism is selected by this ADR.

## Historical manual-control choice

Superseded by the explicit correction above: the earlier accepted round retained a manual Refresh prices control for the collector owning the selected Deck, respecting expiry/backoff. That control is removed from the active plan; the one-hour/24-hour/three-second automatic policy remains accepted.
