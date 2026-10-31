"""Pin the owned gallery before #473 extracts its shared listing SQL.

Capture once with GOLDEN_UPDATE=1 on the base implementation, then commit the JSON.
The verification runner must forward that variable; capture also writes to TEST_LOG_DIR
because the runner deletes its copied checkout. Never update after the extraction.
"""
import json
import os
from pathlib import Path
from urllib.parse import urlencode
from uuid import uuid4

from app import collection
from app.main import connect
from deck_import_fixtures import _seed, printed
from test_catalog_targets import isolated_rules  # noqa: F401
from test_collection_holdings import location
from test_deck_cost import launches, store  # noqa: F401
from test_friend_copies import node, ok
from test_handover import handover
from test_holdings import call
from test_loans import accept, pair, sent, view

GOLDEN = Path(__file__).parent / 'fixtures' / 'collection_listing_golden.json'
CARDS = (
    printed('sv02', 'Paldea Evolved', '001', 'Abra', 'Pokemon', types=['Psychic']),
    printed('sv01', 'Scarlet & Violet', '002', 'Alpha', 'Pokemon', types=['Fire']),
    printed('sv02', 'Paldea Evolved', '003', 'Rate %', 'Trainer', trainerType='Supporter'),
    printed('sv01', 'Scarlet & Violet', '004', 'Under_score', 'Trainer', trainerType='Item'),
    printed('sv02', 'Paldea Evolved', '005', 'Bang!', 'Trainer', trainerType='Tool'),
    printed('sv01', 'Scarlet & Violet', '006', 'a%b', 'Trainer', trainerType='Stadium'),
    printed('sv02', 'Paldea Evolved', '007', 'axb', 'Pokemon', types=['Water']),
    printed('sve', 'Scarlet & Violet Energies', '005', 'Basic Psychic Energy', 'Energy', energyType='Normal'),
)


def hand_over(borrower, lender, edition, count, deck_id=None):
    extra = {'deck_id': deck_id} if deck_id else {}
    loan = ok(accept(lender, view(lender, sent(borrower, lender, [(edition, count)], **extra)),
                     [(edition, count)]))
    ok(handover(lender, loan))
    ok(handover(borrower, loan))
    return loan


def world():
    _seed(CARDS)
    owner, friend = pair()
    with connect() as conn:
        editions = {f"{row['set_id']}/{row['collector_number']}": str(row['id']) for row in conn.execute(
            '''SELECT e.id,pd.set_id,pd.collector_number FROM catalog_edition e
               JOIN catalog_printing_display pd ON pd.printing_id=e.printing_id''').fetchall()}
        unsorted = node(owner, 'Unsorted')['id']
        binder = location(conn, owner, 'Binder')
        shelf = location(conn, owner, 'Shelf', 'organization')
        box = location(conn, owner, 'Box', parent=shelf)
        deck = location(conn, owner, 'Deck', 'deck')
        leaves = [unsorted, binder, box, deck]
        for index, edition in enumerate(value for _, value in sorted(editions.items())):
            # Every Edition in two places: 16 Holdings, including repeated Editions in the Box.
            for offset in (0, 1):
                conn.execute('''INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
                                VALUES (%s,%s,%s,%s,1)''',
                             (owner, leaves[(index + offset) % 4], edition, index + offset + 3))
    # Use the real handover so the golden includes owned copies lent out of Holdings.
    hand_over(friend, owner, editions['sv02/001'], 1)
    labels = {unsorted: 'Unsorted', binder: 'Binder', box: 'Shelf / Box', deck: 'Deck'}
    return owner, friend, editions, labels, box, deck


def read(owner, **params):
    return ok(call('GET', '/api/collection/holdings?' + urlencode(params), owner))


def normalise(body, labels, editions, first):
    edition_labels = {value: key for key, value in editions.items()}
    result = dict(body)
    result.pop('snapshot', None)
    result['next_cursor'] = bool(result['next_cursor'])
    for field in ('owner_revision', 'catalog_revision'):
        result[field] -= first[field]
    result['holdings'] = []
    for raw in body['holdings']:
        row = dict(raw)
        row['edition_id'] = edition_labels[row['edition_id']]
        row['printing_id'] = row['edition_id']  # exactly one Edition per Printing in this fixture
        row['location_id'] = labels[row['location_id']]
        row['image_url'] = row['image_url'] is not None
        result['holdings'].append(row)
    return result


def cases(owner, labels, editions, box, monkeypatch):
    first = read(owner)
    assert first['lent'] == '1'
    assert first['totals']['holdings'] >= 12
    result = {}
    queries = {}
    for sort in ('name-asc', 'name-desc', 'set-asc', 'set-desc', 'quantity-asc', 'quantity-desc'):
        queries[f'all/{sort}'] = {'sort': sort}
        queries[f'box/{sort}'] = {'sort': sort, 'location_id': box}
    queries['set'] = {'set_id': 'sv02'}
    for category in ('Pokemon', 'Trainer', 'Energy'):
        queries[f'category/{category}'] = {'category': category}
    for kind in ('supporter', 'item', 'tool', 'stadium'):
        queries[f'trainer/{kind}'] = {'trainer_type': kind}
    queries['element'] = {'elemental_type': 'Psychic'}
    queries['combination'] = {'set_id': 'sv02', 'category': 'Pokemon', 'elemental_type': 'Psychic'}
    for name in ('Ab', '%', '_', '!', 'a%b'):
        queries[f'name/{name}'] = {'name': name}
    literal_names = {'%': {'Rate %', 'a%b'}, '_': {'Under_score'}, '!': {'Bang!'}, 'a%b': {'a%b'}}
    for label, query in queries.items():
        body = read(owner, **query)
        assert body['next_cursor'] is None
        if query.get('name') in literal_names:
            assert {row['printing_name'] for row in body['holdings']} == literal_names[query['name']]
        result[label] = normalise(body, labels, editions, first)
    # A no-op monkeypatch would silently leave this as one page: explicitly refuse it.
    monkeypatch.setattr(collection, 'HOLDING_PAGE_SIZE', 3)
    for label, query in queries.items():
        pages, walked, cursor = [], [], None
        while True:
            body = read(owner, **query, **({'cursor': cursor} if cursor else {}))
            assert len(body['holdings']) <= 3, 'STOP: page-size monkeypatch did not reach the HTTP app'
            pages.append(normalise(body, labels, editions, first))
            walked.extend(pages[-1]['holdings'])
            cursor = body['next_cursor']
            if cursor is None:
                break
        assert walked == result[label]['holdings']
        assert len(pages) == max(1, (len(walked) + 2) // 3)
        result[f'pages/{label}'] = pages
    return result


def assert_golden(actual, update=False):
    if update and os.environ.get('GOLDEN_UPDATE') == '1':
        content = json.dumps(actual, indent=2, ensure_ascii=False) + '\n'
        GOLDEN.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN.write_text(content)
        if os.environ.get('TEST_LOG_DIR'):
            (Path(os.environ['TEST_LOG_DIR']) / GOLDEN.name).write_text(content)
    assert GOLDEN.is_file(), 'Capture on base with GOLDEN_UPDATE=1 before extracting collection.py'
    assert actual == json.loads(GOLDEN.read_text())


def test_owned_listing_matches_the_base_golden(monkeypatch, store):
    owner, _, editions, labels, box, _ = world()
    assert_golden(cases(owner, labels, editions, box, monkeypatch), update=True)


def test_owned_listing_still_matches_with_borrowed_copies(monkeypatch, store):
    owner, friend, editions, labels, box, deck = world()
    edition = editions['sv02/001']
    friend_leaf = node(friend, 'Unsorted')['id']
    with connect() as conn:
        conn.execute('''INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
                        VALUES (%s,%s,%s,6,1) ON CONFLICT (owner_id,location_id,edition_id)
                        DO UPDATE SET quantity=holding.quantity+6''', (friend, friend_leaf, edition))
    loan = hand_over(owner, friend, edition, 2)
    source = node(owner, 'Unsorted')['id']
    ok(call('POST', '/api/loans/borrowed/move', owner, {
        'loan_id': loan['id'], 'edition_id': edition, 'from_location_id': source,
        'to_location_id': box, 'quantity': '1', 'idempotency_key': str(uuid4())}))
    hand_over(owner, friend, edition, 1, deck)
    assert_golden(cases(owner, labels, editions, box, monkeypatch))
