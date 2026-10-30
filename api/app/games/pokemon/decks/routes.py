from uuid import UUID, uuid4
from fastapi import APIRouter, Depends
from app.db import connect
from app.identity import verified_user
from app.holdings import parse_quantity
from app.location_tree import (owner_and_rows, replay, check_name, store_result, error, node_model,
                               apply_edit, cleaned_name, LocationCommandResult)
from app.copy_allocation import deck_lines
from app.settings import read_settings
from app.core.decks.ownership import read_ownership, held_in
from app.core.decks.loans import read_deck_loans
from app.core.decks.index import deck_cursor_encode, deck_cursor_decode, index_counts, cover_candidates
from app.core.decks.contents import DeckContents, capture_deck_contents, change_quantity
from app.core.decks.store import (CreateDeck, EditDeck, AddDeckListLine, ChangeDeckListLine, RemoveDeckListLine,
    SetDeckCover, DeckCoverResult, ChangeDeckList, require_deck, read_cover, check_revision, line_exists,
    write_deck_list, keep_response)
from app.games.pokemon.decks.models import (DeckIndex, DeckIndexEntry, DeckIndexCover, DeckDetail,
    DeckListCommandResult, SetTargetFormat)
from app.games.pokemon.decks.commands import (read_deck_list, read_target_format, surplus_with_display,
    replayed, store_deck_list_result)
from app.games.pokemon.decks.line_display import read_line_display
from app.games.pokemon.decks.checks import basic_checks
from app.games.pokemon.formats.format_evaluator import FORMATS
from app.games.pokemon.formats.deck_format_checks import held_format_checks

router = APIRouter(prefix='/api/decks', tags=['decks'])


@router.post('', response_model=LocationCommandResult, status_code=201)
def create_deck(command: CreateDeck, user_id: str = Depends(verified_user)):
    name = cleaned_name(command.name)
    with connect() as conn, conn.transaction():
        _, rows = owner_and_rows(conn, user_id)
        digest, previous = replay(conn, user_id, command.idempotency_key,
                                 {'action': 'create_deck', **command.model_dump(mode='json')})
        if previous:
            return previous
        check_name(name, None, rows)
        row = conn.execute("""INSERT INTO location(id,owner_id,name,kind)
          VALUES (%s,%s,%s,'deck') RETURNING id,name,kind,parent_id,version""",
          (uuid4(), user_id, name)).fetchone()
        rows[row['id']] = row
        return store_result(conn, user_id, command.idempotency_key, digest, row, rows)


@router.patch('/{deck_id}', response_model=LocationCommandResult)
def edit_deck(deck_id: UUID, command: EditDeck, user_id: str = Depends(verified_user)):
    return apply_edit(deck_id, command, user_id, deck=True)


@router.get('', response_model=DeckIndex)
def deck_index(cursor: str | None = None, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        created = conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING RETURNING user_id', (user_id,)).fetchone()
        revision = conn.execute('SELECT revision FROM inventory_owner WHERE user_id=%s FOR UPDATE', (user_id,)).fetchone()['revision']
        if created:
            conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Unsorted','storage_leaf')", (uuid4(),user_id))
        key = deck_cursor_decode(cursor, user_id, revision) if cursor else None
        after = 'AND (lower(name),id) > (%s,%s)' if key else ''
        page = conn.execute(f"""SELECT id,name,kind,parent_id,version,lower(name) AS sort_name
          FROM location WHERE owner_id=%s AND kind='deck' {after}
          ORDER BY lower(name),id LIMIT 31""", (user_id, *key) if key else (user_id,)).fetchall()
        # Read ancestors for only the bounded page, preserving nested Deck depth.
        depths = {row['id']: row['depth'] for row in conn.execute("""WITH RECURSIVE ancestors AS (
          SELECT id AS deck_id,id,parent_id,1 AS depth FROM location WHERE owner_id=%s AND id=ANY(%s)
          UNION ALL SELECT a.deck_id,l.id,l.parent_id,a.depth+1 FROM location l JOIN ancestors a ON l.id=a.parent_id
          WHERE l.owner_id=%s AND a.depth<12)
          SELECT deck_id AS id,max(depth) AS depth FROM ancestors GROUP BY deck_id""",
          (user_id, [row['id'] for row in page[:30]],user_id)).fetchall()}
        summaries = index_summaries(conn, user_id, [row['id'] for row in page[:30]])
        return DeckIndex(decks=[DeckIndexEntry(**row,depth=depths[row['id']],**summaries[row['id']]) for row in page[:30]],
                         owner_revision=revision,
                         next_cursor=deck_cursor_encode(user_id, revision, page[29]) if len(page)>30 else None)


def index_summaries(conn, user_id: str, deck_ids: list[UUID]) -> dict[UUID, dict]:
    """Each Deck's Deck List total, the copies of it the Deck holds, its Target Format and its cover, for one index page.

    The page's Deck List lines and Holdings are two range reads paired here, never a join (see
    ``deck_ownership.read_ownership``). The cover reads only the picks, the lines and the display data of the cards that
    can lead a tile (``cover_candidates``); it never evaluates or prices a Deck."""
    if not deck_ids:
        return {}
    formats = {row['deck_id']: row['target_format'] for row in conn.execute(
        'SELECT deck_id,target_format FROM deck_list WHERE owner_id=%s AND deck_id=ANY(%s)', (user_id, deck_ids))}
    counted = index_counts(conn, user_id, deck_ids)
    # Migration 029 and its location trigger give every Deck a Deck List; a missing one reads as Standard and empty.
    candidates = {deck_id: cover_candidates(counted[deck_id].lines, counted[deck_id].pick) for deck_id in deck_ids}
    display = read_line_display(conn, {edition for found in candidates.values() for edition in found})
    covers = {}
    for deck_id, found in candidates.items():
        covers[deck_id] = None
        if found:
            best = min(found, key=lambda e: (display[e]['card_kind'] != 'pokemon', display[e]['name'].casefold(), str(e)))
            covers[deck_id] = DeckIndexCover(edition_id=best, name=display[best]['name'],
                                             image_url=display[best]['image_url'])
    return {deck_id: {'deck_list_total': str(found.deck_list_total), 'in_deck': str(found.in_deck),
                      'target_format': formats.get(deck_id, 'standard'), 'cover': covers[deck_id]}
            for deck_id, found in counted.items()}


@router.get('/{deck_id}', response_model=DeckDetail)
def deck_detail(deck_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        revision, rows = owner_and_rows(conn, user_id)
        deck = require_deck(rows, deck_id)
        state = conn.execute('SELECT active_generation,revision FROM catalog_state WHERE singleton FOR SHARE').fetchone()
        generation = state['active_generation']
        ownership = read_ownership(conn, user_id, deck_id)
        surplus = surplus_with_display(conn, ownership.surplus)
        deck_list = read_deck_list(conn, user_id, deck_id)
        target_format = read_target_format(conn, user_id, deck_id)
        # The owner lock (owner_and_rows) keeps Deck List commands out, so a saved result is reused when its key matches,
        # and otherwise recomputed and saved in this transaction.
        format_checks = held_format_checks(conn, user_id, deck_id, deck_list.revision, target_format, reuse=True)
        settings = read_settings(conn, user_id)
        counted = deck_lines(conn, user_id, deck_id, settings.want_list_counting)
        return DeckDetail(deck=node_model(deck, rows), owner_revision=revision, catalog_revision=state['revision'],
                          checks=basic_checks(conn, generation, user_id, deck_id, 'holdings'),
                          deck_list_checks=basic_checks(conn, generation, user_id, deck_id, 'deck_list'),
                          deck_list=deck_list, target_format=target_format, format_checks=format_checks,
                          ownership=ownership.lines, surplus=surplus, competition=ownership.competition,
                          to_get=str(sum(line.need for line in counted.values())),
                          want_list_counting=settings.want_list_counting, settings_revision=settings.revision,
                          loans=read_deck_loans(conn, user_id, deck_id, held_in(conn, user_id, deck_id)),
                          cover_edition_id=read_cover(conn, user_id, deck_id))


@router.post('/{deck_id}/deck-list/lines', response_model=DeckListCommandResult)
def add_deck_list_line(deck_id: UUID, command: AddDeckListLine, user_id: str = Depends(verified_user)):
    quantity = parse_quantity(command.quantity)
    payload = {'action': 'add_deck_list_line', 'deck_id': str(deck_id), 'edition_id': str(command.edition_id),
               'quantity': str(quantity), 'revision': command.revision}
    with connect() as conn, conn.transaction():
        _, rows = owner_and_rows(conn, user_id)
        digest, previous = replay(conn, user_id, command.idempotency_key, payload)
        if previous:
            return replayed(conn, previous)
        require_deck(rows, deck_id)
        check_revision(conn, user_id, deck_id, command.revision)
        state = conn.execute('SELECT active_generation FROM catalog_state WHERE singleton FOR SHARE').fetchone()
        available = conn.execute("""SELECT 1 FROM catalog_generation_edition ge
          JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
          WHERE ge.generation_id=%s AND ge.edition_id=%s AND ge.active AND NOT gp.tombstoned""",
                                 (state['active_generation'], command.edition_id)).fetchone()
        if not available:
            error(422, 'EDITION_UNAVAILABLE')
        if line_exists(conn, user_id, deck_id, command.edition_id):
            error(409, 'DECK_LIST_LINE_EXISTS')
        conn.execute('INSERT INTO deck_list_line(owner_id,deck_id,edition_id,quantity) VALUES (%s,%s,%s,%s)',
                     (user_id, deck_id, command.edition_id, quantity))
        return store_deck_list_result(conn, user_id, deck_id, command.idempotency_key, digest)


@router.patch('/{deck_id}/deck-list/lines/{edition_id}', response_model=DeckListCommandResult)
def change_deck_list_line(deck_id: UUID, edition_id: UUID, command: ChangeDeckListLine,
                          user_id: str = Depends(verified_user)):
    quantity = parse_quantity(command.quantity)
    payload = {'action': 'change_deck_list_line', 'deck_id': str(deck_id), 'edition_id': str(edition_id),
               'quantity': str(quantity), 'revision': command.revision}
    with connect() as conn, conn.transaction():
        _, rows = owner_and_rows(conn, user_id)
        digest, previous = replay(conn, user_id, command.idempotency_key, payload)
        if previous:
            return replayed(conn, previous)
        require_deck(rows, deck_id)
        check_revision(conn, user_id, deck_id, command.revision)
        if not line_exists(conn, user_id, deck_id, edition_id):
            error(404, 'DECK_LIST_LINE_NOT_FOUND')
        conn.execute('UPDATE deck_list_line SET quantity=%s WHERE owner_id=%s AND deck_id=%s AND edition_id=%s',
                     (quantity, user_id, deck_id, edition_id))
        return store_deck_list_result(conn, user_id, deck_id, command.idempotency_key, digest)


@router.delete('/{deck_id}/deck-list/lines/{edition_id}', response_model=DeckListCommandResult)
def remove_deck_list_line(deck_id: UUID, edition_id: UUID, command: RemoveDeckListLine,
                          user_id: str = Depends(verified_user)):
    payload = {'action': 'remove_deck_list_line', 'deck_id': str(deck_id), 'edition_id': str(edition_id),
               'revision': command.revision}
    with connect() as conn, conn.transaction():
        _, rows = owner_and_rows(conn, user_id)
        digest, previous = replay(conn, user_id, command.idempotency_key, payload)
        if previous:
            return replayed(conn, previous)
        require_deck(rows, deck_id)
        check_revision(conn, user_id, deck_id, command.revision)
        if not line_exists(conn, user_id, deck_id, edition_id):
            error(404, 'DECK_LIST_LINE_NOT_FOUND')
        conn.execute('DELETE FROM deck_list_line WHERE owner_id=%s AND deck_id=%s AND edition_id=%s',
                     (user_id, deck_id, edition_id))
        return store_deck_list_result(conn, user_id, deck_id, command.idempotency_key, digest)


@router.put('/{deck_id}/deck-list/target-format', response_model=DeckListCommandResult)
def set_target_format(deck_id: UUID, command: SetTargetFormat, user_id: str = Depends(verified_user)):
    """Change the Deck List's Target Format (app redesign #178). A Deck List command like the line edits: revision-checked,
    idempotent, it advances the revision (saved results depend on it) and returns the new Format's result. Choosing the
    current Target Format is accepted and advances the revision too."""
    if command.target_format not in FORMATS:
        error(422, 'UNKNOWN_FORMAT')
    payload = {'action': 'set_target_format', 'deck_id': str(deck_id), 'target_format': command.target_format,
               'revision': command.revision}
    with connect() as conn, conn.transaction():
        _, rows = owner_and_rows(conn, user_id)
        digest, previous = replay(conn, user_id, command.idempotency_key, payload)
        if previous:
            return replayed(conn, previous)
        require_deck(rows, deck_id)
        check_revision(conn, user_id, deck_id, command.revision)
        conn.execute('UPDATE deck_list SET target_format=%s WHERE owner_id=%s AND deck_id=%s',
                     (command.target_format, user_id, deck_id))
        return store_deck_list_result(conn, user_id, deck_id, command.idempotency_key, digest)


@router.put('/{deck_id}/cover', response_model=DeckCoverResult)
def set_deck_cover(deck_id: UUID, command: SetDeckCover, user_id: str = Depends(verified_user)):
    """Set or clear the Deck's cover card (#291). Idempotent and checked against the pick the client last read, not the
    Deck List revision, so Deck List edits and Rename are never made stale by it, and nothing is re-evaluated."""
    payload = {'action': 'set_deck_cover', 'deck_id': str(deck_id),
               'edition_id': str(command.edition_id) if command.edition_id else None,
               'expected_edition_id': str(command.expected_edition_id) if command.expected_edition_id else None}
    with connect() as conn, conn.transaction():
        _, rows = owner_and_rows(conn, user_id)
        digest, previous = replay(conn, user_id, command.idempotency_key, payload)
        if previous:
            return previous
        require_deck(rows, deck_id)
        if read_cover(conn, user_id, deck_id) != command.expected_edition_id:
            error(409, 'STALE_DECK_COVER')
        if command.edition_id is None:
            conn.execute('DELETE FROM deck_cover WHERE owner_id=%s AND deck_id=%s', (user_id, deck_id))
        else:
            if not line_exists(conn, user_id, deck_id, command.edition_id):
                error(409, 'COVER_NOT_ON_DECK_LIST')
            conn.execute("""INSERT INTO deck_cover(owner_id,deck_id,edition_id) VALUES (%s,%s,%s)
              ON CONFLICT (owner_id,deck_id) DO UPDATE SET edition_id=EXCLUDED.edition_id""",
                         (user_id, deck_id, command.edition_id))
        return keep_response(conn, user_id, command.idempotency_key, digest,
                             DeckCoverResult(deck_id=deck_id, cover_edition_id=command.edition_id))


@router.post('/{deck_id}/deck-list/changes', response_model=DeckListCommandResult)
def change_deck_list(deck_id: UUID, command: ChangeDeckList, user_id: str = Depends(verified_user)):
    """Set several Deck List lines at once (app redesign #177): each change is one line's new total, and 0 removes it.
    Every change applies in one transaction or none does, and the revision advances once, even when nothing differs. A
    swap is one batch, and the builder's Undo is the inverse batch at the revision this one answered, so
    STALE_DECK_LIST means the list changed in between. Only a new line needs an available Edition; a line whose Edition
    was retired can still be changed or removed. Like every Deck List command it never touches a Holding, the inventory
    revision or the inventory Undo records. The per-line routes stay."""
    if not command.changes:
        error(422, 'NO_CHANGES')
    totals: dict[UUID, int] = {}
    for change in command.changes:
        if change.edition_id in totals:
            error(422, 'DUPLICATE_EDITION')
        totals[change.edition_id] = change_quantity(change.quantity)
    # The order of the changes doesn't matter, so the stored request is sorted: the same batch in another order replays.
    payload = {'action': 'change_deck_list', 'deck_id': str(deck_id), 'revision': command.revision,
               'changes': sorted([str(edition), str(quantity)] for edition, quantity in totals.items())}
    with connect() as conn, conn.transaction():
        _, rows = owner_and_rows(conn, user_id)
        digest, previous = replay(conn, user_id, command.idempotency_key, payload)
        if previous:
            return replayed(conn, previous)
        require_deck(rows, deck_id)
        check_revision(conn, user_id, deck_id, command.revision)
        listed = {row['edition_id'] for row in conn.execute(
            'SELECT edition_id FROM deck_list_line WHERE owner_id=%s AND deck_id=%s AND edition_id=ANY(%s)',
            (user_id, deck_id, list(totals)))}
        new = [edition for edition, quantity in totals.items() if quantity and edition not in listed]
        if new:
            state = conn.execute('SELECT active_generation FROM catalog_state WHERE singleton FOR SHARE').fetchone()
            available = conn.execute("""SELECT count(*) AS n FROM catalog_generation_edition ge
              JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
              WHERE ge.generation_id=%s AND ge.edition_id=ANY(%s) AND ge.active AND NOT gp.tombstoned""",
                                     (state['active_generation'], new)).fetchone()['n']
            if available != len(new):
                error(422, 'EDITION_UNAVAILABLE')
        write_deck_list(conn, user_id, deck_id, totals)
        return store_deck_list_result(conn, user_id, deck_id, command.idempotency_key, digest)


@router.get('/{deck_id}/contents', response_model=DeckContents)
def deck_contents(deck_id: UUID, user_id: str = Depends(verified_user)):
    return capture_deck_contents(deck_id, user_id)

