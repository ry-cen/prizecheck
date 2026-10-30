from uuid import UUID
from app.core.decks import store
from app.core.decks.store import advance_deck_list_revision, keep_response
from app.core.decks.ownership import surplus_holdings
from app.core.art.store import warm_deck
from app.games.pokemon.art import route as art_route
from app.games.pokemon.decks.line_display import read_line_display, with_line_display
from app.games.pokemon.decks.models import DeckList, DeckListLine, SurplusHolding, DeckListCommandResult
from app.games.pokemon.formats.deck_format_checks import command_format_checks


def read_target_format(conn, user_id: str, deck_id: UUID) -> str:
    return conn.execute('SELECT target_format FROM deck_list WHERE owner_id=%s AND deck_id=%s',
                        (user_id, deck_id)).fetchone()['target_format']


def read_deck_list(conn, user_id: str, deck_id: UUID) -> DeckList:
    revision, lines = store.read_deck_list(conn, user_id, deck_id, display=read_line_display, line=DeckListLine)
    return DeckList(revision=revision, lines=lines)


def surplus_with_display(conn, surplus) -> list[SurplusHolding]:
    display = read_line_display(conn, [row.edition_id for row in surplus])
    return surplus_holdings([(row.edition_id, int(row.quantity)) for row in surplus],
                            {row.edition_id: row.version for row in surplus}, display=display, holding=SurplusHolding)


def advance_deck_list(conn, user_id: str, deck_id: UUID) -> dict:
    """Advance the Deck List revision and return the fields every Deck List command response carries: the Deck List,
    its Target Format and that Format's result, which is saved with the Deck. The inventory revision does not move: a
    Deck List never counts toward the Collection."""
    advance_deck_list_revision(conn, user_id, deck_id)
    deck_list = read_deck_list(conn, user_id, deck_id)
    # Background; never blocks or fails the save (#396).
    warm_deck(conn, user_id, deck_id, allowed_host=art_route.ALLOWED_HOST, linked_art=art_route.LINKED_ART,
              fetcher=art_route.fetcher, key_prefix=art_route.KEY_PREFIX, upgrade=art_route.upgrade())
    target_format = read_target_format(conn, user_id, deck_id)
    return {'deck_id': deck_id, 'deck_list': deck_list, 'target_format': target_format,
            'format_checks': command_format_checks(conn, user_id, deck_id, deck_list.revision, target_format)}


def replayed(conn, response: dict) -> dict:
    """A stored Deck List command response as it replays: display data on every line (``with_line_display``), and, for a
    response stored before migration 045, the Target Format every Deck List had then (Standard) with only that Format's
    result, as a response stored now would carry."""
    response = with_line_display(conn, response)
    if 'target_format' in response:
        return response
    checks = response.get('format_checks')
    if checks is not None:
        checks = {**checks, 'results': [result for result in checks.get('results', [])
                                        if result.get('format') == 'standard']}
    return {**response, 'target_format': 'standard', 'format_checks': checks}


def store_deck_list_result(conn, user_id: str, deck_id: UUID, key: UUID, digest: str) -> dict:
    """Advance the Deck List revision and keep the response for replay."""
    return keep_response(conn, user_id, key, digest, DeckListCommandResult(**advance_deck_list(conn, user_id, deck_id)))
