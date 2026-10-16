"""What Loans take out of a collector's own figures, per Card Edition (spec "Module boundary"). Inventory code calls
these and never imports Loan logic.

``reserved_counts`` is the only one so far. Until Loans land (#252) nothing is reserved, so it answers no Edition and
every figure stays as it was (#245). #252 replaces its body with the read of open Loan lines; ``lent_counts`` and
``borrowed_in`` join it in #253 and #254.
"""
from collections.abc import Iterable
from uuid import UUID


def reserved_counts(conn, owner_id: str, edition_ids: Iterable[UUID]) -> dict[UUID, int]:
    """Copies of each Edition the owner has promised to open Loans and not yet handed over (sent Lend Offers and
    accepted Borrow Requests). Editions with none are absent, so read it with ``.get(edition, 0)``. The caller holds the
    owner row lock. Call it as ``counts.reserved_counts(...)`` through the module, never a from-import, so one patch of
    the module attribute reaches every caller."""
    return {}
