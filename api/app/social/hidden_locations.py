"""Hidden Locations (social network #249, spec "Blocks and Hidden Locations").

A collector can hide any Location from Friends (``location.hidden``, migration 101). Hiding covers everything inside
it at any depth, including Locations added or moved in later: that is worked out when read, never stored. A Location
inside a hidden one can't be shown on its own (``location_tree.set_location_hidden`` refuses with
LOCATION_HIDDEN_BY_PARENT). Hiding never moves the inventory revision and never changes a figure the collector sees;
it decides only what Friends can see (``social.friend_copies``, #250) and never affects accepted Loans (#252).

``hidden_location_ids`` is the one definition of "effectively hidden" for Friend reads: the SQL function
``hidden_locations`` of migration 101. ``hidden_by`` is the same rule over a tree already in memory, for the
collector's own Location tree read, which also names the nearest hidden ancestor.
"""
from collections.abc import Iterable, Mapping
from uuid import UUID


def hidden_by(parents: Mapping[UUID, UUID | None], hidden: set[UUID]) -> dict[UUID, UUID | None]:
    """For every Location in ``parents`` (Location id -> parent id), the nearest strict ancestor the collector hid, or
    None. ``hidden`` is the Locations the collector hid themselves. A Location is effectively hidden when it is in
    ``hidden`` or this names an ancestor. Pure."""
    found: dict[UUID, UUID | None] = {}

    for location in parents:
        if location in found:
            continue
        # Walk up to the first hidden ancestor, or to one already answered. No Location on the walk above the start
        # is hidden, so every Location on it has the same answer.
        chain, parent, answer = [location], parents.get(location), None
        while parent is not None and parent in parents and parent not in chain:
            if parent in hidden:
                answer = parent
                break
            if parent in found:
                answer = found[parent]
                break
            chain.append(parent)
            parent = parents.get(parent)
        for item in chain:
            found[item] = answer
    return found


def own_hidden(conn, owner_id: str) -> set[UUID]:
    """The Locations the owner hid themselves."""
    return {row['id'] for row in conn.execute('SELECT id FROM location WHERE owner_id=%s AND hidden', (owner_id,))}


def hidden_location_ids(conn, owner_ids: Iterable[str]) -> dict[str, set[UUID]]:
    """Every effectively hidden Location of each owner, by owner id; owners with none are absent. One statement for any
    number of owners (Friend reads ask for several Friends at once)."""
    found: dict[str, set[UUID]] = {}
    for row in conn.execute('SELECT owner_id,location_id FROM hidden_locations(%s)', (sorted(set(owner_ids)),)):
        found.setdefault(row['owner_id'], set()).add(row['location_id'])
    return found
