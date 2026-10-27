"""The owned copies a Decklist Import can use (spec "Allocation and Edition choice"; ticket #214).

Two reads, each in its own transaction:

- ``groups``, in the review's catalog snapshot: the other Printings **Use cards I own** reaches from each resolved
  Printing. For a Basic Energy (effective Basic Energy attribute true, ``catalog_card_attribute``) it is every other
  active Basic Energy Printing of the same Energy type; Basic Energy is in no Reprint Group, so for the import's
  allocation alone the Energy type stands in for one. The type comes from the name, as ``import_energy_matching``
  reads it (``CATALOG_NAME``): the attribute's ``types`` column is empty for every Energy card. For any other Printing it
  is every other active Printing of its effective Reprint Group (``catalog_reprint_group_member``); a Printing in no
  group reaches nothing else. Reprint Groups and the Want List's Swap hint don't change. Active means not tombstoned
  and with at least one active Edition, so an owned copy of a withdrawn Printing is never offered for a Deck List.
- ``capture_owned``: one consistent capture under the owner row lock, as the Want List read takes it. It locks the
  ``inventory_owner`` row (``FOR UPDATE``, the lock every Holding, Deck List and settings writer takes), reads the Deck
  being replaced for Replace (``import_replace.read_replaced``, #215), reads the counting setting
  (``settings.read_settings``) and asks ``copy_allocation.available_to`` for the given Editions. It
  never creates the owner: a caller with no ``inventory_owner`` row owns nothing, so it reads nothing and takes no lock,
  and the review stays free of writes. Its work grows with the Holdings of the given Editions and the Deck List lines
  naming them, never with the rest of the Collection.

Neither read touches prices; the review reads stored quotes afterwards with no connection held (ADR 0006).
"""
from dataclasses import dataclass
from uuid import UUID

from .copy_allocation import Availability, available_to
from .import_energy_matching import CATALOG_NAME
from .import_match_core import ACTIVE, NEWEST_COLUMNS, RELEASE_JOINS, newest_first, release_params
from .import_replace import ReplacedDeck, read_replaced
from .location_tree import error
from .db import connect
from .settings import WantListCounting, read_settings

# A first-time caller has no owner row yet; these are the account defaults migration 049 gives a new one.
DEFAULT_COUNTING: WantListCounting = 'all_at_once'
DEFAULT_SETTINGS_REVISION = 1


def groups(conn, generation: UUID, printing_ids) -> dict[UUID, tuple[UUID, ...]]:
    """Each of ``printing_ids``' other active Printings that Use cards I own reaches, newest first (catalog search's
    order, ``import_match_core.newest_first``). A Printing that reaches none is absent."""
    wanted = sorted(set(printing_ids))
    if not wanted:
        return {}
    energy = conn.execute(f"""WITH mine AS (
        SELECT gp.printing_id,substring(gp.display_name from %s) AS energy_type FROM catalog_generation_printing gp
          JOIN catalog_card_attribute ca ON ca.printing_id=gp.printing_id AND ca.basic_energy IS TRUE
          WHERE gp.generation_id=%s AND gp.printing_id=ANY(%s) AND NOT gp.tombstoned)
      SELECT mine.printing_id AS of,gp.printing_id,{NEWEST_COLUMNS}
      FROM mine JOIN catalog_generation_printing gp ON gp.generation_id=%s AND NOT gp.tombstoned
        AND gp.printing_id<>mine.printing_id AND substring(gp.display_name from %s)=mine.energy_type
      JOIN catalog_card_attribute ca ON ca.printing_id=gp.printing_id AND ca.basic_energy IS TRUE
      {RELEASE_JOINS}
      WHERE {ACTIVE}""", (CATALOG_NAME, generation, wanted, generation, CATALOG_NAME, *release_params())).fetchall()
    grouped = conn.execute(f"""SELECT mine.printing_id AS of,gp.printing_id,{NEWEST_COLUMNS}
      FROM catalog_reprint_group_member mine
      JOIN catalog_reprint_group_member g ON g.group_id=mine.group_id AND g.printing_id<>mine.printing_id
      JOIN catalog_generation_printing gp ON gp.generation_id=%s AND gp.printing_id=g.printing_id AND NOT gp.tombstoned
      {RELEASE_JOINS}
      WHERE mine.printing_id=ANY(%s) AND {ACTIVE}""", (generation, *release_params(), wanted)).fetchall()
    found: dict[UUID, list[UUID]] = {}
    energies = {row['of'] for row in energy}
    # A Basic Energy is in no Reprint Group; should one ever be, its Energy type still decides.
    for row in sorted([*energy, *(row for row in grouped if row['of'] not in energies)], key=newest_first):
        found.setdefault(row['of'], []).append(row['printing_id'])
    return {printing: tuple(others) for printing, others in found.items()}


@dataclass(frozen=True)
class OwnedCapture:
    owner_revision: int
    counting: WantListCounting
    settings_revision: int
    availability: Availability
    replaced: ReplacedDeck | None = None   # the Deck being replaced (#215); None for a new Deck


def capture_owned(user_id: str, editions, deck_id: UUID | None = None) -> OwnedCapture:
    """The copies of ``editions`` available to the Deck ``deck_id`` (Replace, #215), or to a new Deck when it is None,
    read under the owner row lock in one transaction. With a ``deck_id`` it first reads that Deck
    (``import_replace.read_replaced``), which answers 404 DECK_NOT_FOUND unless it is one of the caller's Decks: a
    caller with no owner row has none. The check comes before ``available_to``, which assumes an owned Deck."""
    with connect() as conn, conn.transaction():
        owner = conn.execute('SELECT revision FROM inventory_owner WHERE user_id=%s FOR UPDATE', (user_id,)).fetchone()
        if owner is None:
            if deck_id is not None:
                error(404, 'DECK_NOT_FOUND')
            return OwnedCapture(owner_revision=1, counting=DEFAULT_COUNTING, settings_revision=DEFAULT_SETTINGS_REVISION,
                                availability=Availability(counting=DEFAULT_COUNTING, editions={}, places={}, order=()))
        replaced = read_replaced(conn, user_id, deck_id) if deck_id is not None else None
        settings = read_settings(conn, user_id)
        availability = available_to(conn, user_id, editions, settings.want_list_counting, deck_id)
        return OwnedCapture(owner_revision=owner['revision'], counting=settings.want_list_counting,
                            settings_revision=settings.revision, availability=availability, replaced=replaced)
