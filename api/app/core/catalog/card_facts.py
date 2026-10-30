"""Catalog facts about Card Editions as the social reads, Loans, Trades and the Trade List show them, and card order.

``card_facts`` reads what a card shows, its Printing and Card Identity, and its name as Catalog's name search compares it,
in one query keyed by Edition ids. ``number_order`` is the collector number order the Want List, Trade Wants and the
Friend reads sort by (``Card.order``).
"""
import re
from dataclasses import dataclass
from uuid import UUID

# What a card shows, its Printing and Card Identity, and its name as Catalog's name search compares it.
CARD_FACTS = """SELECT e.id AS edition_id, e.printing_id, p.identity_id,
  coalesce(pd.display_name, ci.display_name) AS name, psc.set_code AS set_code,
  coalesce(pd.set_name, '') AS set_name, coalesce(pd.collector_number, '') AS collector_number, e.descriptor,
  art.small_art_url AS image_url, replace(catalog_search_words(coalesce(pd.display_name, ci.display_name)), ' ', '') AS search_key
  FROM catalog_edition e
  JOIN catalog_printing p ON p.id = e.printing_id
  JOIN catalog_identity ci ON ci.id = p.identity_id
  JOIN catalog_printing_set_code psc ON psc.printing_id = p.id
  LEFT JOIN catalog_printing_display pd ON pd.printing_id = p.id
  LEFT JOIN catalog_printing_art art ON art.printing_id = p.id
  WHERE e.id = ANY(%s)"""

NUMBER_PARTS = re.compile(r'^([a-z]*)(\d*)(.*)$', re.DOTALL)


def number_order(number: str) -> tuple:
    """A collector number in natural order, compared the way catalog search compares it (``catalog_browse.NUMBER_KEY``:
    zeros after a number's letters don't count, so 097 reads as 97): plain numbers by value (2 before 10), a letter
    suffix after its number, numbers with a letter prefix after the plain ones. The raw text breaks a tie."""
    key = re.sub(r'^([a-z]*)0*([0-9])', r'\1\2', number.lower())
    prefix, digits, rest = NUMBER_PARTS.match(key).groups()
    return prefix != '', prefix, int(digits) if digits else -1, rest, number


@dataclass(frozen=True)
class Card:
    """Catalog facts about one Card Edition (``CARD_FACTS``)."""
    edition_id: UUID
    printing_id: UUID
    identity_id: UUID
    name: str
    set_code: str
    set_name: str
    collector_number: str
    descriptor: dict
    image_url: str | None
    search_key: str

    def order(self):
        """Card order, as the Want List reads: name, set, collector number, then the Edition id."""
        return self.name.casefold(), self.set_name, number_order(self.collector_number), self.edition_id


def card_facts(conn, edition_ids) -> dict[UUID, Card]:
    ids = sorted(set(edition_ids))
    if not ids:
        return {}
    return {row['edition_id']: Card(
        edition_id=row['edition_id'], printing_id=row['printing_id'], identity_id=row['identity_id'], name=row['name'],
        set_code=row['set_code'], set_name=row['set_name'],
        collector_number=row['collector_number'], descriptor=row['descriptor'],
        image_url=row['image_url'], search_key=row['search_key'] or '')
        for row in conn.execute(CARD_FACTS, (ids,))}
