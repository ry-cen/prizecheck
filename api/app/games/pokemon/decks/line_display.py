"""Display data on Deck List lines (app redesign #176, spec "Deck List contracts": Display data).

Every Deck List line in the Deck read and in every Deck List command response carries what the deck builder draws: the
name, set, collector number, Variant Descriptor, image, card kind, Trainer Type, evolves from and Card Identity. A line
for a card the collector doesn't own renders from these alone; there is no second lookup and no batch Edition route.

The fields are catalog facts about the line's Card Edition, never Deck List state: the line stores only its Edition and
quantity. Card kind, Trainer Type and evolves from come from the effective card attributes (``catalog_card_attribute``,
the one source of card type, migration 041), so a reviewed correction shows on the next read. The Card Identity is the
Printing's current one (``catalog_printing.identity_id``, which a Card Identity merge rewrites), the same identity the
basic four-copy check groups by. A Pokémon line also carries its evolution root and its stage from that root, read from
``catalog_evolution_root`` (migration 043, ``app.games.pokemon.catalog.evolution_roots``), so the builder can group an evolution line even when
the deck skips a stage; both are null for other cards and until the roots are first derived.

The display read is one query keyed by the lines' Edition ids, never a join against ``deck_list_line``: a large Deck's
lines are read by primary-key range and paired here, as ``deck_ownership.read_ownership`` explains.
"""
from typing import Literal
from uuid import UUID

CardKind = Literal['pokemon', 'trainer', 'energy']
TrainerType = Literal['supporter', 'item', 'tool', 'stadium']

DISPLAY_QUERY = """SELECT e.id AS edition_id,coalesce(pd.display_name,ci.display_name) AS name,
  coalesce(pd.set_id,'') AS set_id,coalesce(pd.set_name,'') AS set_name,
  coalesce(pd.collector_number,'') AS collector_number,e.descriptor,art.small_art_url AS image_url,
  ca.card_kind,ca.trainer_type,ca.evolves_from,ci.id AS identity_id,ci.display_name AS identity_name,
  er.root_name AS evolution_root,er.stage AS evolution_stage
  FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
  JOIN catalog_identity ci ON ci.id=p.identity_id
  LEFT JOIN catalog_printing_display pd ON pd.printing_id=p.id
  LEFT JOIN catalog_printing_art art ON art.printing_id=p.id
  LEFT JOIN catalog_card_attribute ca ON ca.printing_id=p.id
  LEFT JOIN catalog_evolution_root er ON er.identity_key=ci.identity_key AND ca.card_kind='pokemon'
  WHERE e.id=ANY(%s)"""
# Every display field a line carries; a stored response missing any of them is enriched on replay.
DISPLAY_KEYS = frozenset(('name', 'set_id', 'set_name', 'collector_number', 'descriptor', 'image_url', 'card_kind',
                          'trainer_type', 'evolves_from', 'identity_id', 'identity_name', 'evolution_root',
                          'evolution_stage'))


def read_line_display(conn, edition_ids) -> dict[UUID, dict]:
    """Display fields by Edition id for ``edition_ids``. The image is the small artwork as an art-route URL (``catalog_printing_art.small_art_url``,
    ADR 0020), or None when the catalog has none."""
    ids = list(edition_ids)
    if not ids:
        return {}
    found = {}
    for row in conn.execute(DISPLAY_QUERY, (ids,)).fetchall():
        fields = {key: value for key, value in row.items() if key != 'edition_id'}
        found[row['edition_id']] = fields
    return found


def with_line_display(conn, response: dict) -> dict:
    """A stored Deck List command response, replayed with display data on every line.

    Responses stored before #176 carry no display data, and those stored before the evolution roots carry no
    ``evolution_root`` or ``evolution_stage``; replaying either as stored would fail the response model. A line missing
    any display field gets today's values for the fields it lacks, and keeps every field it has: display data is catalog
    data about each line's Edition, not part of the Deck List the command changed, so the replay still returns the Deck
    List, revision and format results exactly as computed then."""
    deck_list = response.get('deck_list') or {}
    lines = deck_list.get('lines') or []
    bare = [UUID(line['edition_id']) for line in lines if DISPLAY_KEYS - line.keys()]
    if not bare:
        return response
    display = read_line_display(conn, bare)
    # Every stored line names a catalog Edition (deck_list_line.edition_id references catalog_edition, and the
    # application never deletes an Edition), so the lookup below finds it.
    return {**response, 'deck_list': {**deck_list, 'lines': [
        {**display[UUID(line['edition_id'])], **line} if DISPLAY_KEYS - line.keys() else line for line in lines]}}
