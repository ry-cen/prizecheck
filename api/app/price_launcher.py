"""Runner launch interface for price refresh (tickets 07 and 08).

Admission (07) reserves a runner slot in the record store and then calls ``spawn`` once, after the reservation has
committed. The real implementation arrives with ticket 08-B (flock-guarded detached supervisor, see
docs/price-refresh.md); until then this stub launches nothing, so admission can be built and tested against the
interface.

Contract for ``spawn(slot, owner)``:

- ``slot`` is a runner slot (0 or 1) and ``owner`` the 32-hex nonce stored in ``lease:price:runner:<slot>``.
- It returns ``True`` only when a runner process was started for exactly that reservation, and ``False`` when
  nothing was started. It never raises for a launch failure; the caller then frees the slot best effort and leaves
  the jobs queued.
- It must not block on the child and must not touch PostgreSQL or the record store: the caller owns the reservation
  and the record-store state.
- It is called from a request thread, at most once per reservation.

CI replaces this function through ``api/tests/catalog_process_fixture/price_fixture.py`` (record or fail the launch).
Callers must reach it as ``price_launcher.spawn(...)`` so a replacement takes effect.
"""

_SLOTS = (0, 1)


def spawn(slot: int, owner: str) -> bool:
    """Start a runner for a reserved slot. Stub: starts nothing and reports that it did not."""
    if type(slot) is not int or slot not in _SLOTS or type(owner) is not str or not owner:
        raise ValueError('invalid runner reservation')
    return False
