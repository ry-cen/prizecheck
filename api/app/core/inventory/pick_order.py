def order_key(place: dict, units: int):
    return -units, place['name'].lower(), str(place['location_id'])


def suggest(need: int, places: list[dict]) -> list[tuple[dict, int]]:
    """Each place with the copies the suggestion takes from it, in the order the suggestion considers them.

    ``places`` have ``location_id``, ``name``, ``kind``, ``available``, ``committed`` and ``spare`` (ints: every copy
    there, the copies another Deck holds there for its own line, and the copies beyond that line, by
    ``copy_allocation.spare_rule``), and may have ``reserved``: copies there reserved for open Loans, as the rule
    places them (``reserved_beyond`` plus ``reserved_own``: at the Loan picks first, so an out-of-date pick still
    leaves the right count reserved), out of the copies beyond a Deck's line first. Loose storage comes first, then
    other Decks' copies beyond their own lines, then copies other Decks hold for their own lines (a Deck already giving
    up copies first), then reserved copies, which can still be gathered before handover (spec "Inventory
    touch-points").
    Each tier takes from the largest holding first, so a card comes from as few Locations as possible. The Loan Pick
    List (``loan_inventory``) uses the same order.
    """
    def reserved(p) -> int:
        return min(p.get('reserved', 0), p['available'])

    def free_spare(p) -> int:
        return max(0, p['spare'] - reserved(p))

    def free_committed(p) -> int:
        return p['committed'] - max(0, reserved(p) - p['spare'])

    loose = sorted((p for p in places if p['kind'] != 'deck'),
                   key=lambda p: order_key(p, p['available'] - reserved(p)))
    decks = sorted((p for p in places if p['kind'] == 'deck'), key=lambda p: order_key(p, free_spare(p)))
    taken = {p['location_id']: 0 for p in places}

    def take(tier):
        nonlocal need
        for place, units in tier:
            amount = min(need, units)
            if amount > 0:
                taken[place['location_id']] += amount
                need -= amount

    take([(p, p['available'] - reserved(p)) for p in loose])
    take([(p, free_spare(p)) for p in decks])
    # A Deck already giving up its unlisted copies is visited anyway, so its own copies are taken first.
    take(sorted(((p, free_committed(p)) for p in decks),
                key=lambda pair: (taken[pair[0]['location_id']] == 0, *order_key(*pair))))
    take(sorted(((p, reserved(p)) for p in loose + decks), key=lambda pair: order_key(*pair)))
    return [(p, taken[p['location_id']]) for p in loose + decks]
