"""The Want List route (decklist import #209; spec "The Want List"): ``GET /api/want-list``.

The capture, the counting and the response models are game-free and live in ``app.want_list``; this route adds the
Pokémon line display (``line_display.read_line_display``) and the card order, and lists the lines with them.
"""
from uuid import UUID

from fastapi import APIRouter, Depends

from app.copy_allocation import LineCount
from app.core.catalog.card_facts import number_order
from app.db import connect
from app.games.pokemon.decks.line_display import read_line_display
from app.identity import verified_user
from app.swap_hints import GroupEdition, hints, swap_hint
from app.want_list import (DISPLAY_FIELDS, CombinedDeckNeed, CombinedRow, CountedFromDeck, WantList, WantListDeck,
                           WantListLine, WantListSection, capture_want_list, combined)

router = APIRouter(prefix='/api/want-list', tags=['want-list'])


@router.get('', response_model=WantList)
def want_list(deck: UUID | None = None, user_id: str = Depends(verified_user)):
    capture = capture_want_list(user_id, deck, swaps=True)
    needs = {shown.id: capture.needs(shown.id) for shown in capture.shown()}
    with connect() as conn:
        display = read_line_display(conn, {line.edition_id for lines in needs.values() for line in lines})

    def shown_of(edition: UUID) -> dict:
        return {key: display[edition][key] for key in DISPLAY_FIELDS}

    # Lines read by card, then by Edition: name, set, collector number, then the Edition id for a stable order.
    def card_order(line: LineCount):
        fields = display[line.edition_id]
        return fields['name'].casefold(), fields['set_name'], number_order(fields['collector_number']), line.edition_id

    for lines in needs.values():
        lines.sort(key=card_order)

    # The Swap hints (#211), handed out in the same card order over every Deck, oldest first.
    def group_order(edition: GroupEdition):
        return edition.name.casefold(), edition.set_name, number_order(edition.collector_number), edition.edition_id

    offered = hints(capture.swaps, [captured.id for captured in capture.decks], group_order)
    sections = [WantListSection(
        deck_id=shown.id, name=shown.name, deck_list_revision=shown.deck_list_revision,
        to_get=str(sum(line.need for line in needs[shown.id])),
        lines=[WantListLine(
            edition_id=line.edition_id, **shown_of(line.edition_id), quantity=str(line.quantity), held=str(line.held),
            spare=str(line.spare), other_decks=str(line.other_decks),
            counted_from=[CountedFromDeck(deck_id=other, quantity=str(count)) for other, count in line.from_decks],
            lent=str(line.lent), borrowed=str(line.borrowed),
            owned=str(capture.allocation.owned.get(line.edition_id, 0)), need=str(line.need),
            swap=swap_hint(offered.get((shown.id, line.edition_id)), capture.swaps))
            for line in needs[shown.id]]) for shown in capture.shown()]
    total = combined(capture, needs)
    rows = [CombinedRow(edition_id=edition, **shown_of(edition), need=str(need),
                        decks=[CombinedDeckNeed(deck_id=line.deck_id, need=str(line.need)) for line in lines])
            for edition, need, lines in total]
    return WantList(want_list_counting=capture.counting, settings_revision=capture.settings_revision,
                    owner_revision=capture.owner_revision, deck_lists_digest=capture.deck_lists_digest,
                    deck_id=capture.scope,
                    decks=[WantListDeck(id=shown.id, name=shown.name) for shown in capture.decks],
                    sections=sections, combined=rows, to_get=str(sum(need for _, need, _ in total)))
