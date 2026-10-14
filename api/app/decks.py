"""Physical Decks and deliberately limited construction checks."""
import base64
import hashlib
import hmac
import json
import os
from uuid import UUID, uuid4
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from .main import connect, verified_user
from .holdings import parse_quantity
from .location_tree import (TreeNode, LocationCommandResult, EditLocation, apply_edit, cleaned_name,
                            owner_and_rows, replay, check_name, store_result, error, node_model)
from .deck_ownership import CompetitionWarning, LineOwnership, SurplusHolding, held_in, read_ownership
from .deck_format_checks import DeckFormatChecks, TargetFormat, command_format_checks, held_format_checks
from .format_evaluator import FORMATS
from .deck_list_display import CardKind, TrainerType, read_line_display, with_line_display

router = APIRouter(prefix='/api/decks', tags=['decks'])
from .construction_checks import DISCLAIMER, IdentityCount, evaluate_checks


class CreateDeck(BaseModel):
    name: str
    idempotency_key: UUID


class EditDeck(EditLocation):
    """Rename a Deck, move it to another parent, or both. The fields and rules are the Location edit's."""


class DeckIndex(BaseModel):
    decks: list[TreeNode]
    owner_revision: int
    next_cursor: str | None


class IdentityCheck(BaseModel):
    identity_id: UUID
    name: str
    quantity: str
    status: str


class DeckChecks(BaseModel):
    total: str
    shortage: str
    excess: str
    size_status: str
    identities: list[IdentityCheck]
    disclaimer: str = DISCLAIMER


class DeckEditionQuantity(BaseModel):
    edition_id: UUID
    quantity: str


class DeckContents(BaseModel):
    editions: list[DeckEditionQuantity]
    owner_revision: int
    catalog_revision: int


class DeckListLine(BaseModel):
    edition_id: UUID
    quantity: str
    in_deck: str
    # Display data (app redesign #176, ``deck_list_display``): catalog facts about the line's Card Edition, so a line for
    # a card the collector doesn't own renders without a second lookup.
    name: str
    set_id: str
    set_name: str
    collector_number: str
    descriptor: dict          # The Variant Descriptor, as Collection's Holdings carry it.
    image_url: str | None     # The small artwork, or None.
    card_kind: CardKind | None
    trainer_type: TrainerType | None
    evolves_from: str | None
    identity_id: UUID         # The Card Identity.
    identity_name: str
    # A Pokémon's evolution root and its steps from it (migration 043); null for other cards and before the roots are
    # first derived.
    evolution_root: str | None
    evolution_stage: int | None


class DeckList(BaseModel):
    revision: int
    lines: list[DeckListLine]


class AddDeckListLine(BaseModel):
    edition_id: UUID
    quantity: str
    revision: int = Field(ge=1)
    idempotency_key: UUID


class ChangeDeckListLine(BaseModel):
    quantity: str
    revision: int = Field(ge=1)
    idempotency_key: UUID


class RemoveDeckListLine(BaseModel):
    revision: int = Field(ge=1)
    idempotency_key: UUID


class SetTargetFormat(BaseModel):
    # Checked by the route, so an unknown name answers UNKNOWN_FORMAT like the format-checks read.
    target_format: str
    revision: int = Field(ge=1)
    idempotency_key: UUID


class DeckListCommandResult(BaseModel):
    deck_id: UUID
    deck_list: DeckList
    # The Deck List's Target Format after the command (app redesign #178). A response stored before migration 045 replays
    # as Standard, the Target Format every Deck List had then (``replayed``).
    target_format: TargetFormat
    # The Deck's result in its Target Format as of today (UTC) after the edit: one entry in ``results``. A replay returns
    # it as computed then; a response stored before format results existed has none, so it replays as null instead of
    # failing validation.
    format_checks: DeckFormatChecks | None = None


class DeckDetail(BaseModel):
    deck: TreeNode
    checks: DeckChecks
    # The same basic checks over the Deck List lines, owned or not; ``checks`` still reads the Deck's Holdings.
    deck_list_checks: DeckChecks
    deck_list: DeckList
    # Ownership states of each Deck List line, Holdings beyond the Deck List, and copies counted elsewhere by more
    # than one Deck. Computed from current Holdings on every read and never stored.
    ownership: list[LineOwnership]
    surplus: list[SurplusHolding]
    competition: list[CompetitionWarning]
    owner_revision: int
    catalog_revision: int
    # The Deck List's Target Format and its result as of today (app redesign #178): one entry in ``format_checks.results``.
    target_format: TargetFormat
    format_checks: DeckFormatChecks


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


def deck_cursor_encode(user_id, revision, row):
    payload = json.dumps({'v': 1, 'u': user_id, 'r': revision,
                          'k': [row['sort_name'], str(row['id'])]}, separators=(',', ':')).encode()
    mac = hmac.new(os.environ['INTERNAL_AUTH_SECRET'].encode(), payload, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(payload + mac).decode().rstrip('=')


def deck_cursor_decode(token, user_id, revision):
    try:
        if len(token) > 2048:
            raise ValueError()
        raw = base64.urlsafe_b64decode(token + '=' * (-len(token) % 4))
        payload, mac = raw[:-32], raw[-32:]
        expected = hmac.new(os.environ['INTERNAL_AUTH_SECRET'].encode(), payload, hashlib.sha256).digest()
        if not hmac.compare_digest(mac, expected):
            raise ValueError()
        data = json.loads(payload)
        if data['v'] != 1 or data['u'] != user_id or not isinstance(data['r'], int):
            raise ValueError()
        if data['r'] != revision:
            error(409, 'INVENTORY_CHANGED')
        if len(data['k']) != 2 or not isinstance(data['k'][0], str):
            raise ValueError()
        return data['k'][0], UUID(data['k'][1])
    except (ValueError, KeyError, TypeError):
        error(400, 'INVALID_CURSOR')


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
        return DeckIndex(decks=[TreeNode(**row,depth=depths[row['id']]) for row in page[:30]], owner_revision=revision,
                         next_cursor=deck_cursor_encode(user_id, revision, page[29]) if len(page)>30 else None)


# Basic checks read one quantity source: the Deck's Holdings (``checks``) or its Deck List (``deck_list_checks``).
CHECK_SOURCES = {
    'deck_list': 'SELECT edition_id,quantity FROM deck_list_line WHERE owner_id=%s AND deck_id=%s',
    'holdings': 'SELECT edition_id,quantity FROM holding WHERE owner_id=%s AND location_id=%s',
}


def basic_checks(conn, generation_id, user_id: str, deck_id: UUID, source: str) -> DeckChecks:
    # The Basic Energy exemption reads the effective card attributes (migration 030), not the source energy type:
    # an identity is exempt only when every printing is Basic Energy, and unresolved when any printing's Basic
    # Energy status is unknown. ``generation_id`` is no longer read.
    groups = conn.execute(f"""SELECT ci.id,ci.display_name,sum(c.quantity) AS quantity,
      bool_and(a.basic_energy IS TRUE) AS exempt,
      bool_or(a.basic_energy IS NULL) AS unresolved
      FROM ({CHECK_SOURCES[source]}) c JOIN catalog_edition e ON e.id=c.edition_id
      JOIN catalog_printing p ON p.id=e.printing_id JOIN catalog_identity ci ON ci.id=p.identity_id
      LEFT JOIN catalog_card_attribute a ON a.printing_id=p.id
      GROUP BY ci.id,ci.display_name
      ORDER BY ci.display_name,ci.id""", (user_id, deck_id)).fetchall()
    evaluated = evaluate_checks([IdentityCount(int(g['quantity']),g['exempt'],g['unresolved']) for g in groups])
    identities = [IdentityCheck(identity_id=g['id'],name=g['display_name'],quantity=str(g['quantity']),status=status)
                  for g,status in zip(groups,evaluated.identity_statuses)]
    return DeckChecks(total=str(evaluated.total),shortage=str(evaluated.shortage),excess=str(evaluated.excess),
                      size_status=evaluated.size_status,identities=identities)


def require_deck(rows, deck_id: UUID):
    deck = rows.get(deck_id)
    if not deck or deck['kind'] != 'deck':
        error(404, 'DECK_NOT_FOUND')
    return deck


def read_deck_list(conn, user_id: str, deck_id: UUID) -> DeckList:
    header = conn.execute('SELECT revision FROM deck_list WHERE owner_id=%s AND deck_id=%s',
                          (user_id, deck_id)).fetchone()
    if header is None:
        # Migration 029 and its location trigger give every Deck a Deck List.
        raise RuntimeError('Deck has no Deck List')
    # Two primary-key range reads paired here, never a join (see deck_ownership.read_ownership).
    lines = conn.execute('SELECT edition_id,quantity FROM deck_list_line WHERE owner_id=%s AND deck_id=%s '
                         'ORDER BY edition_id', (user_id, deck_id)).fetchall()
    held = held_in(conn, user_id, deck_id)
    display = read_line_display(conn, [row['edition_id'] for row in lines])
    return DeckList(revision=header['revision'], lines=[
        DeckListLine(edition_id=row['edition_id'], quantity=str(row['quantity']),
                     in_deck=str(min(row['quantity'], held.get(row['edition_id'], 0))), **display[row['edition_id']])
        for row in lines])


@router.get('/{deck_id}', response_model=DeckDetail)
def deck_detail(deck_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        revision, rows = owner_and_rows(conn, user_id)
        deck = require_deck(rows, deck_id)
        state = conn.execute('SELECT active_generation,revision FROM catalog_state WHERE singleton FOR SHARE').fetchone()
        generation = state['active_generation']
        ownership = read_ownership(conn, user_id, deck_id)
        deck_list = read_deck_list(conn, user_id, deck_id)
        target_format = read_target_format(conn, user_id, deck_id)
        # The owner lock (owner_and_rows) keeps Deck List commands out, so a saved result is reused when its key matches,
        # and otherwise recomputed and saved in this transaction.
        format_checks = held_format_checks(conn, user_id, deck_id, deck_list.revision, target_format, reuse=True)
        return DeckDetail(deck=node_model(deck, rows), owner_revision=revision, catalog_revision=state['revision'],
                          checks=basic_checks(conn, generation, user_id, deck_id, 'holdings'),
                          deck_list_checks=basic_checks(conn, generation, user_id, deck_id, 'deck_list'),
                          deck_list=deck_list, target_format=target_format, format_checks=format_checks,
                          ownership=ownership.lines, surplus=ownership.surplus, competition=ownership.competition)


def read_target_format(conn, user_id: str, deck_id: UUID) -> str:
    return conn.execute('SELECT target_format FROM deck_list WHERE owner_id=%s AND deck_id=%s',
                        (user_id, deck_id)).fetchone()['target_format']


def check_revision(conn, user_id: str, deck_id: UUID, expected: int):
    current = conn.execute('SELECT revision FROM deck_list WHERE owner_id=%s AND deck_id=%s',
                           (user_id, deck_id)).fetchone()
    if current is None:
        raise RuntimeError('Deck has no Deck List')
    if current['revision'] != expected:
        error(409, 'STALE_DECK_LIST')


def line_exists(conn, user_id: str, deck_id: UUID, edition_id: UUID) -> bool:
    return bool(conn.execute('SELECT 1 FROM deck_list_line WHERE owner_id=%s AND deck_id=%s AND edition_id=%s',
                             (user_id, deck_id, edition_id)).fetchone())


def advance_deck_list(conn, user_id: str, deck_id: UUID) -> dict:
    """Advance the Deck List revision and return the fields every Deck List command response carries: the Deck List,
    its Target Format and that Format's result, which is saved with the Deck. The inventory revision does not move: a
    Deck List never counts toward the Collection."""
    conn.execute('UPDATE deck_list SET revision=revision+1 WHERE owner_id=%s AND deck_id=%s', (user_id, deck_id))
    deck_list = read_deck_list(conn, user_id, deck_id)
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


def keep_response(conn, user_id: str, key: UUID, digest: str, result: BaseModel) -> dict:
    """Store a Deck List command's response for replay and return it."""
    response = result.model_dump(mode='json')
    conn.execute('INSERT INTO location_command(owner_id,request_key,request_digest,response) VALUES (%s,%s,%s,%s)',
                 (user_id, key, digest, json.dumps(response)))
    return response


def store_deck_list_result(conn, user_id: str, deck_id: UUID, key: UUID, digest: str) -> dict:
    """Advance the Deck List revision and keep the response for replay."""
    return keep_response(conn, user_id, key, digest, DeckListCommandResult(**advance_deck_list(conn, user_id, deck_id)))


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


def capture_deck_contents(deck_id: UUID, user_id: str, timeout_ms: int | None = None) -> DeckContents:
    """Detach a complete inventory capture before any pricing/export source work.

    Inventory writers serialize on the owner row, so the revision and every
    Edition quantity belong to the same committed inventory state. Catalog
    activation is fenced separately for the captured catalog revision.
    ``timeout_ms`` bounds every statement and lock wait (the budgeted Deck cost
    route passes what is left of its three seconds).
    """
    with connect() as conn, conn.transaction():
        if timeout_ms is not None:
            conn.execute(f'SET LOCAL statement_timeout = {max(1, int(timeout_ms))}')
            conn.execute(f'SET LOCAL lock_timeout = {max(1, int(timeout_ms))}')
        revision, rows = owner_and_rows(conn, user_id)
        deck = rows.get(deck_id)
        if not deck or deck['kind'] != 'deck':
            error(404, 'DECK_NOT_FOUND')
        catalog_revision = conn.execute(
            'SELECT revision FROM catalog_state WHERE singleton FOR SHARE'
        ).fetchone()['revision']
        holdings = conn.execute("""SELECT edition_id,quantity FROM holding
          WHERE owner_id=%s AND location_id=%s ORDER BY edition_id""",
          (user_id, deck_id)).fetchall()
        contents = DeckContents(
            editions=[DeckEditionQuantity(edition_id=row['edition_id'], quantity=str(row['quantity']))
                      for row in holdings],
            owner_revision=revision, catalog_revision=catalog_revision)
    # Both transaction locks and the connection are released before callers can wait.
    return contents


@router.get('/{deck_id}/contents', response_model=DeckContents)
def deck_contents(deck_id: UUID, user_id: str = Depends(verified_user)):
    return capture_deck_contents(deck_id, user_id)
