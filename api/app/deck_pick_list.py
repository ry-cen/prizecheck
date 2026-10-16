"""Pick List: where to fetch the Deck List copies a Deck is short of, and confirming those retrievals as Moves.

The Pick List reads ownership states from ``deck_ownership.read_ownership`` and adds, for each line with copies
*elsewhere*, a suggested source per Location: non-Deck Storage Leaves first, largest holding first (the fewest
Locations for that card), then copies other Decks hold beyond their own Deck List lines, then copies other Decks hold
for their own lines, which carries a warning that taking them leaves that Deck short. Suggestions are per card; the
Pick List does not optimise trips across cards.

Confirming moves the chosen copies into the Deck in one transaction under the owner lock: every item is validated
first and nothing changes unless all of them can move. The writes are those of a committed multi-source Move
(``moves.py``, migration 026): one owner revision, idempotent replay through ``mutation_request``/``move_response``,
and one Inventory Undo record for the whole confirmation, however many sources it names. A Gather therefore takes one
of the owner's five Undo records and never pushes Collection's earlier ones out. The record's id is derived from the
idempotency key (``moves.undo_id_for``) and returned as ``undo_id``, so the caller can offer Undo for it. Migration
031's holding trigger covers arriving copies; copies that a line already needs leave the Deck List unchanged.

Confirm items have the multi-source Move item shape ``{source_id, edition_id, quantity, expected_version}``. The
confirmation does not go through a Move manifest: starting one would discard a selection the collector is staging in
Collection.

Put-away needs no route of its own: the Pick List lists surplus Holdings with their versions, and putting them away is
an ordinary Move from the Deck to a Location the collector chooses.
"""
import hashlib
import json
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .copy_allocation import spare_rule
from .deck_ownership import CompetitionWarning, read_ownership
from .decks import check_revision, read_deck_list, require_deck
from .location_tree import owner_and_rows
from .main import connect, verified_user
from .moves import MAX_BATCH, MAX_QUANTITY, first_non_leaf, quantity, record_undo, undo_id_for

router = APIRouter(prefix='/api/decks', tags=['decks'])


class PickWarning(BaseModel):
    # Taking the suggested copies leaves this other Deck short of its own Deck List line.
    deck_id: UUID
    name: str
    # Copies of the Edition the Deck would newly lack for its own line.
    short_by: str


class PickSource(BaseModel):
    location_id: UUID
    name: str
    # 'storage_leaf' for loose storage, 'deck' for another Deck.
    kind: str
    # Every copy of the Edition held in this Location.
    available: str
    # Copies another Deck holds for its own Deck List line; "0" for a non-Deck Storage Leaf. Taking more than
    # ``available`` minus ``committed`` leaves that Deck short.
    committed: str
    # The Holding's version: send it back as ``expected_version`` when confirming.
    version: int
    # Copies the suggestion takes from here; "0" when the suggestion does not use this Location.
    suggested: str
    warning: PickWarning | None


class PickRow(BaseModel):
    edition_id: UUID
    quantity: str
    in_deck: str
    # Copies to fetch: the sum of the sources' ``suggested``.
    elsewhere: str
    not_owned: str
    # Every other Location holding the Edition, in the order the suggestion considers them.
    sources: list[PickSource]


class PutAwayHolding(BaseModel):
    edition_id: UUID
    # Surplus copies: held in the Deck beyond its Deck List line.
    quantity: str
    # The Deck's Holding version, for a Move out of the Deck.
    version: int


class PickList(BaseModel):
    deck_id: UUID
    deck_list_revision: int
    owner_revision: int
    # Deck List lines with copies elsewhere, in Card Edition order.
    rows: list[PickRow]
    put_away: list[PutAwayHolding]
    competition: list[CompetitionWarning]


class PickItem(BaseModel):
    source_id: UUID
    edition_id: UUID
    quantity: str
    expected_version: int = Field(ge=1)


class ConfirmPicks(BaseModel):
    items: list[PickItem] = Field(min_length=1, max_length=MAX_BATCH)
    deck_list_revision: int = Field(ge=1)
    idempotency_key: UUID


class PickConfirmResult(BaseModel):
    edition_count: int
    copy_count: str
    owner_revision: int
    # The distinct source Locations the copies came from.
    source_count: int
    # The confirmation's one Inventory Undo record (POST /api/moves/undo/{undo_id}). A replay names the same record,
    # which may since have been undone, dismissed, superseded or expired.
    undo_id: UUID


def fail(status: int, code: str, **detail):
    """Raise the API error; optional detail names the affected source Storage Leaf or Card Edition."""
    raise HTTPException(status, {'code': code, **{key: str(value) for key, value in detail.items() if value is not None}})


def order_key(place: dict, units: int):
    return -units, place['name'].lower(), str(place['location_id'])


def suggest(need: int, places: list[dict]) -> list[tuple[dict, int]]:
    """Each place with the copies the suggestion takes from it, in the order the suggestion considers them.

    ``places`` have ``location_id``, ``name``, ``kind``, ``available``, ``committed`` and ``spare`` (ints: every copy
    there, the copies another Deck holds there for its own line, and the copies beyond that line, by
    ``copy_allocation.spare_rule``). Loose storage comes first, then other Decks' copies beyond their own lines, then
    copies other Decks hold for their own lines (a Deck already giving up copies first). Each tier takes from the
    largest holding first, so a card comes from as few Locations as possible.
    """
    loose = sorted((p for p in places if p['kind'] != 'deck'), key=lambda p: order_key(p, p['available']))
    decks = sorted((p for p in places if p['kind'] == 'deck'),
                   key=lambda p: order_key(p, p['spare']))
    taken = {p['location_id']: 0 for p in places}

    def take(tier):
        nonlocal need
        for place, units in tier:
            amount = min(need, units)
            if amount > 0:
                taken[place['location_id']] += amount
                need -= amount

    take([(p, p['available']) for p in loose])
    take([(p, p['spare']) for p in decks])
    # A Deck already giving up its unlisted copies is visited anyway, so its own copies are taken first.
    take(sorted(((p, p['committed']) for p in decks),
                key=lambda pair: (taken[pair[0]['location_id']] == 0, *order_key(*pair))))
    return [(p, taken[p['location_id']]) for p in loose + decks]


@router.get('/{deck_id}/pick-list', response_model=PickList)
def pick_list(deck_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        revision, rows = owner_and_rows(conn, user_id)
        require_deck(rows, deck_id)
        deck_list_revision = read_deck_list(conn, user_id, deck_id).revision
        ownership = read_ownership(conn, user_id, deck_id)
        short = [line for line in ownership.lines if int(line.elsewhere) > 0]
        held = {}
        if short:
            for row in conn.execute("""SELECT h.location_id,h.edition_id,h.version,h.quantity,l.quantity AS listed
              FROM holding h LEFT JOIN deck_list_line l
                ON l.owner_id=h.owner_id AND l.deck_id=h.location_id AND l.edition_id=h.edition_id
              WHERE h.owner_id=%s AND h.location_id<>%s AND h.edition_id=ANY(%s)""",
                                    (user_id, deck_id, [line.edition_id for line in short])):
                held[(row['location_id'], row['edition_id'])] = row
        picks = []
        for line in short:
            # The Spare Copy rule over the copies outside this Deck: what each other Deck holds for its own line.
            rule = spare_rule({place.location_id: held[(place.location_id, line.edition_id)]['quantity']
                               for place in line.locations},
                              {place.location_id: held[(place.location_id, line.edition_id)]['listed']
                               for place in line.locations
                               if held[(place.location_id, line.edition_id)]['listed'] is not None})
            places = [{'location_id': place.location_id, 'name': place.name, 'kind': place.kind,
                       'available': int(place.quantity), 'committed': rule.own.get(place.location_id, 0),
                       'spare': rule.beyond.get(place.location_id, 0)}
                      for place in line.locations]
            sources = []
            for place, taken in suggest(int(line.elsewhere), places):
                spare = place['spare']
                warning = None
                if place['kind'] == 'deck' and taken > spare:
                    warning = PickWarning(deck_id=place['location_id'], name=place['name'], short_by=str(taken - spare))
                sources.append(PickSource(
                    location_id=place['location_id'], name=place['name'], kind=place['kind'],
                    available=str(place['available']), committed=str(place['committed']),
                    version=held[(place['location_id'], line.edition_id)]['version'], suggested=str(taken),
                    warning=warning))
            picks.append(PickRow(edition_id=line.edition_id, quantity=line.quantity, in_deck=line.in_deck,
                                 elsewhere=line.elsewhere, not_owned=line.not_owned, sources=sources))
        versions = {}
        if ownership.surplus:
            versions = {row['edition_id']: row['version'] for row in conn.execute(
                'SELECT edition_id,version FROM holding WHERE owner_id=%s AND location_id=%s AND edition_id=ANY(%s)',
                (user_id, deck_id, [row.edition_id for row in ownership.surplus]))}
        return PickList(deck_id=deck_id, deck_list_revision=deck_list_revision, owner_revision=revision, rows=picks,
                        put_away=[PutAwayHolding(edition_id=row.edition_id, quantity=row.quantity,
                                                 version=versions[row.edition_id]) for row in ownership.surplus],
                        competition=ownership.competition)


@router.post('/{deck_id}/pick-list/confirm', response_model=PickConfirmResult)
def confirm_picks(deck_id: UUID, command: ConfirmPicks, user_id: str = Depends(verified_user)):
    pairs = [(item.source_id, item.edition_id) for item in command.items]
    if len(pairs) != len(set(pairs)):
        fail(422, 'DUPLICATE_MOVE_ITEM')
    items = sorted(((item.source_id, item.edition_id, quantity(item.quantity), item.expected_version)
                    for item in command.items), key=lambda item: (str(item[0]), str(item[1])))
    sources = sorted({item[0] for item in items}, key=str)
    payload = {'action': 'pick_list_confirm', 'deck_id': str(deck_id), 'deck_list_revision': command.deck_list_revision,
               'items': [[str(source), str(edition), str(amount), version] for source, edition, amount, version in items]}
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    try:
        with connect() as conn, conn.transaction():
            revision, rows = owner_and_rows(conn, user_id)
            conn.execute('DELETE FROM mutation_request WHERE owner_id=%s AND expires_at<=now()', (user_id,))
            previous = conn.execute("""SELECT mr.command_digest,mr.result_revision,r.edition_count,r.copy_count,
                r.source_count
              FROM mutation_request mr LEFT JOIN move_response r
                ON r.owner_id=mr.owner_id AND r.request_key=mr.request_key
              WHERE mr.owner_id=%s AND mr.request_key=%s""", (user_id, command.idempotency_key)).fetchone()
            if previous:
                if previous['command_digest'] != digest:
                    fail(409, 'IDEMPOTENCY_KEY_REUSED')
                if previous['edition_count'] is None:
                    fail(409, 'REPLAY_OUTCOME_UNAVAILABLE')
                return PickConfirmResult(edition_count=previous['edition_count'], copy_count=str(previous['copy_count']),
                                         owner_revision=previous['result_revision'],
                                         source_count=previous['source_count'],
                                         undo_id=undo_id_for(user_id, command.idempotency_key))
            require_deck(rows, deck_id)
            check_revision(conn, user_id, deck_id, command.deck_list_revision)
            if deck_id in sources:
                fail(409, 'SAME_LOCATION', source_id=deck_id)
            gone = first_non_leaf(conn, user_id, sources)
            if gone is not None:
                fail(404, 'LOCATION_NOT_FOUND', source_id=gone)
            listed = {row['edition_id'] for row in conn.execute(
                'SELECT edition_id FROM deck_list_line WHERE owner_id=%s AND deck_id=%s AND edition_id=ANY(%s)',
                (user_id, deck_id, sorted({item[1] for item in items}, key=str)))}
            for _, edition, _, _ in items:
                if edition not in listed:
                    fail(422, 'EDITION_NOT_ON_DECK_LIST', edition_id=edition)
            work = json.dumps([{'source_id': str(source), 'edition_id': str(edition), 'quantity': amount}
                               for source, edition, amount, _ in items])
            current = {(row['location_id'], row['edition_id']): row for row in conn.execute(
                """SELECT h.location_id,h.edition_id,h.quantity,h.version
                FROM jsonb_to_recordset(%s::jsonb) AS w(source_id uuid,edition_id uuid,quantity bigint)
                JOIN holding h ON h.owner_id=%s AND h.location_id=w.source_id AND h.edition_id=w.edition_id""",
                (work, user_id))}
            for source, edition, _, version in items:
                found = current.get((source, edition))
                if found is None or found['version'] != version:
                    fail(409, 'STALE_HOLDING', source_id=source, edition_id=edition)
            for source, edition, amount, _ in items:
                if current[(source, edition)]['quantity'] < amount:
                    fail(409, 'INSUFFICIENT_QUANTITY', source_id=source, edition_id=edition)
            arriving: dict[UUID, int] = {}
            for _, edition, amount, _ in items:
                arriving[edition] = arriving.get(edition, 0) + amount
            in_deck = {row['edition_id']: row['quantity'] for row in conn.execute(
                'SELECT edition_id,quantity FROM holding WHERE owner_id=%s AND location_id=%s AND edition_id=ANY(%s)',
                (user_id, deck_id, list(arriving)))}
            for edition in sorted(arriving, key=str):
                if in_deck.get(edition, 0) + arriving[edition] > MAX_QUANTITY:
                    fail(409, 'QUANTITY_OVERFLOW', edition_id=edition)
            new_revision = revision + 1
            conn.execute("""DELETE FROM holding h USING jsonb_to_recordset(%s::jsonb)
                AS w(source_id uuid,edition_id uuid,quantity bigint)
              WHERE h.owner_id=%s AND h.location_id=w.source_id AND h.edition_id=w.edition_id
              AND h.quantity=w.quantity""", (work, user_id))
            conn.execute("""UPDATE holding h SET quantity=h.quantity-w.quantity,version=%s
              FROM jsonb_to_recordset(%s::jsonb) AS w(source_id uuid,edition_id uuid,quantity bigint)
              WHERE h.owner_id=%s AND h.location_id=w.source_id AND h.edition_id=w.edition_id
              AND h.quantity>w.quantity""", (new_revision, work, user_id))
            # Migration 031's holding trigger extends the Deck List only for copies its lines do not already need.
            arrivals = json.dumps([{'edition_id': str(edition), 'quantity': amount} for edition, amount in arriving.items()])
            conn.execute("""INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
              SELECT %s,%s,edition_id,quantity,%s FROM jsonb_to_recordset(%s::jsonb) AS a(edition_id uuid,quantity bigint)
              WHERE true
              ON CONFLICT (owner_id,location_id,edition_id) DO UPDATE
                SET quantity=holding.quantity+EXCLUDED.quantity,version=EXCLUDED.version""",
                         (user_id, deck_id, new_revision, arrivals))
            copies = sum(arriving.values())
            conn.execute('UPDATE inventory_owner SET revision=%s WHERE user_id=%s', (new_revision, user_id))
            conn.execute("""INSERT INTO mutation_request(owner_id,request_key,command_digest,result_revision)
              VALUES (%s,%s,%s,%s)""", (user_id, command.idempotency_key, digest, new_revision))
            conn.execute("""INSERT INTO move_response(owner_id,request_key,edition_count,copy_count,source_count)
              VALUES (%s,%s,%s,%s,%s)""", (user_id, command.idempotency_key, len(arriving), copies, len(sources)))
            # One multi-source Move record for the whole confirmation, written as moves.apply_selection writes it
            # (migration 026): every item names its source.
            undo_id = undo_id_for(user_id, command.idempotency_key)
            undo = [{'source_id': str(source), 'edition_id': str(edition), 'quantity': str(amount)}
                    for source, edition, amount, _ in items]
            record_undo(conn, user_id, undo_id, 'move', deck_id, sources, json.dumps(undo))
            return PickConfirmResult(edition_count=len(arriving), copy_count=str(copies), owner_revision=new_revision,
                                     source_count=len(sources), undo_id=undo_id)
    except psycopg.Error:
        fail(503, 'INVENTORY_TEMPORARILY_UNAVAILABLE')
