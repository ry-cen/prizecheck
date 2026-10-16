"""What Loans take out of a collector's own figures, per Card Edition (spec "Module boundary"). Inventory code calls
these and never imports Loan logic.

``reserved_counts`` (one owner, under that owner's lock) and ``reserved_by_owner`` (several owners at once, for the
Friend reads of ``friend_copies``, #250) are the only ones so far. Until Loans land (#252) nothing is reserved, so both
answer nothing and every figure stays as it was (#245). #252 replaces both bodies with one read of open Loan lines and
folds ``reserved_by_owner``'s read into ``friend_copies``' one statement; ``lent_counts`` and ``borrowed_in`` join them
in #253 and #254.
"""
from collections.abc import Iterable
from uuid import UUID


def reserved_counts(conn, owner_id: str, edition_ids: Iterable[UUID]) -> dict[UUID, int]:
    """Copies of each Edition the owner has promised to open Loans and not yet handed over (sent Lend Offers and
    accepted Borrow Requests). Editions with none are absent, so read it with ``.get(edition, 0)``. The caller holds the
    owner row lock. Call it as ``counts.reserved_counts(...)`` through the module, never a from-import, so one patch of
    the module attribute reaches every caller."""
    return {}


def reserved_by_owner(conn, owner_ids: Iterable[str], edition_ids: Iterable[UUID] | None = None
                      ) -> dict[tuple[str, UUID], int]:
    """``reserved_counts`` for several owners at once: copies reserved, by (owner id, Edition id), for the given Editions
    or, with None, every Edition. Pairs with none are absent. One read for any number of owners, never one per owner
    (``friend_copies`` asks for all of a viewer's Friends at once). Takes no lock: a Friend read never waits on a
    Friend's writes. Call it through the module (``counts.reserved_by_owner``), as ``reserved_counts``."""
    return {}
