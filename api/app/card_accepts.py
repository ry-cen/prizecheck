"""Will accept: which Card Editions count for a wanted one in trades (Trading #275; spec "Matching reads", resolution
"Expansion for Will accept" and Later decisions point 4).

A collector's Will accept choice for a Want List card is one of three rules:

- ``edition`` (this exact card, the default, and the only rule a Trade Wants line ever has): the Edition itself;
- ``printing`` (any finish): every Edition of its Card Printing;
- ``identity`` (any card with the same name): every Edition of every Card Printing with the same Card Identity
  (``catalog_printing.identity_id``, which a Card Identity merge rewrites), whatever its rules text, artwork or language.

It reads catalog rows only, never a collector's inventory or a counting setting, and it lives outside the social area
so that the Want List's Swap hint (``swap_hints``) and, from Trading #276, the social matches module both import it.
The choices themselves are the collector's ``trade_accept`` rows (migration 143); a missing row means ``edition``.
"""
from collections.abc import Mapping
from typing import Literal
from uuid import UUID

WillAcceptRule = Literal['edition', 'printing', 'identity']

# Every Edition each widened wanted Edition accepts: its Printing's Editions for 'printing', every Edition of the
# Printings sharing its Card Identity for 'identity'. Range reads on catalog_edition(printing_id, ...) and
# catalog_printing(identity_id, id).
ACCEPTED = """WITH wanted AS (
    SELECT w.wanted_id, w.rule, we.printing_id, wp.identity_id
    FROM unnest(%s::uuid[], %s::text[]) AS w(wanted_id, rule)
    JOIN catalog_edition we ON we.id = w.wanted_id
    JOIN catalog_printing wp ON wp.id = we.printing_id
  )
  SELECT w.wanted_id, e.id AS edition_id FROM wanted w
    JOIN catalog_edition e ON e.printing_id = w.printing_id
    WHERE w.rule = 'printing'
  UNION
  SELECT w.wanted_id, e.id FROM wanted w
    JOIN catalog_printing p ON p.identity_id = w.identity_id
    JOIN catalog_edition e ON e.printing_id = p.id
    WHERE w.rule = 'identity'"""


def accepts(conn, wanted: Mapping[UUID, WillAcceptRule]) -> dict[UUID, set[UUID]]:
    """For each wanted Edition, every Edition its rule accepts. A wanted Edition always accepts itself, and ``edition``
    reads nothing."""
    found = {edition: {edition} for edition in wanted}
    widened = sorted((edition, rule) for edition, rule in wanted.items() if rule != 'edition')
    if widened:
        for row in conn.execute(ACCEPTED, ([edition for edition, _ in widened], [rule for _, rule in widened])):
            found[row['wanted_id']].add(row['edition_id'])
    return found
