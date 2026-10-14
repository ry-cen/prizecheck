"""A background price refresh for a snapshot just published or republished (app redesign #181).

Spec, "Publishing and public routes": publish and republish start a background price refresh for the snapshot's
Editions, within the existing admission caps, so a new listing is usually priced by the time Discover (which reads cached
quotes only) shows it.

The publish and republish routes run ``refresh_published_prices`` as a background task after their response, so it never
runs under the publication command's locks (the owner row and the session advisory lock) and never delays or fails the
command. It reads the frozen snapshot back from the public projection, then makes one ordinary access over its priced
rows, exactly as the Published Deck cost does (``published_cost.public_quotes``), but for the signed-in owner's caller
(``user:<id>``, the gateway's form, so the per-caller caps are shared with that owner's cost reads) and with no wait:
``evaluate_and_admit`` admits stale rows, then ``release`` drops the interactive permit at once.

Everything is best effort. Fresh rows (checked under an hour ago) admit nothing, so republishing is no way to force a
refresh (ADR 0006); a full queue or the caller's caps refuse rows as any access would; a store problem, a snapshot that
changed or was revoked since, or any other failure leaves the publication as it is and writes nothing. PostgreSQL is never
read.
"""
import logging
import time

from . import price_refresh, public_deck
from .price_budget import Budget
from .public_catalog import marketplace_states
from .public_records import public_record_store

log = logging.getLogger(__name__)

# The whole budget of one refresh: the snapshot read, the eligibility read and admission's compare-and-swap. Admission
# stops before ``wait_until`` (this minus the budget's 0.5 s reserve), and nothing here waits for a runner.
REFRESH_SECONDS = 2.0


def _priced_refs(active: public_deck.ActiveSnapshot) -> dict[str, str | None]:
    """{edition_ref: frozen printing_ref} for the snapshot's rows that carry a reference (as the Published Deck cost
    keys them); a reference frozen with two different Printings keeps None, which proves nothing."""
    frozen: dict[str, str | None] = {}
    for row in active.rows:
        if row.edition_ref is not None:
            frozen[row.edition_ref] = (row.printing_ref if frozen.get(row.edition_ref, row.printing_ref) == row.printing_ref
                                       else None)
    return frozen


def _priceable(state, frozen_printing_ref) -> bool:
    """A row admission may refresh: verified, with a quote lookup and a quote state, for the Printing frozen with it."""
    return (state.state == 'verified' and state.quote_lookup is not None and state.quote is not None
            and public_deck.printing_matches(frozen_printing_ref, state.printing_ref))


def refresh_published_prices(token: str, version: int, caller: str, store=None):
    """Admit a background refresh for the stale priced rows of snapshot ``version`` of ``token``. Returns the
    ``Admission`` (for tests), or None when nothing was asked for. Never raises."""
    try:
        budget = Budget(hard=time.monotonic() + REFRESH_SECONDS, caller=caller)
        active = public_deck.read_active(token, version, deadline=budget.wait_until)
        frozen = _priced_refs(active)
        if not frozen:
            return None
        store = store or public_record_store()
        states = marketplace_states(store, list(frozen), budget.wait_until)
        rows = [price_refresh.Row(ref, ref, state.mapping_revision, state.quote_lookup, state.product_id, state.quote)
                for ref, state in states.items() if _priceable(state, frozen[ref])]
        if not rows:
            return None
        admission = price_refresh.evaluate_and_admit(rows, caller, budget, store)
        admission.release()
        return admission
    except Exception as error:  # noqa: BLE001 - a refresh never fails or changes the publication
        log.warning('Publish price refresh skipped: %s', type(error).__name__)
        return None
