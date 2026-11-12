"""Shared readers exercised against the migrated Riftbound database with synthetic TCGCSV rows."""
from contextlib import nullcontext
from uuid import uuid4
import re

import psycopg
import pytest
from fastapi import HTTPException

from app.core.catalog.card_facts import CARD_FACTS, card_facts
from app.card_accepts import accepts
from app.core.trading.trade_wants import AVAILABLE
from app.core.inventory import collection as inventory
from app.core.decks import contents, deck_list_capture
from app.core.art import store
from psycopg.rows import dict_row
from test_riftbound_catalog_track import admin, databases, fresh  # noqa: F401


@pytest.fixture
def conn(fresh):
    with psycopg.connect(fresh[0], row_factory=dict_row) as connection:
        try:
            yield connection
        finally:
            connection.rollback()


def card(conn, *, name='Synthetic Unit 01', identity=None, display=True, number='001/100', image=None, identity_name=None):
    identity = identity or conn.execute(
        'INSERT INTO catalog_identity(identity_key,display_name) VALUES (%s,%s) RETURNING id',
        (str(uuid4()), name if identity_name is None else identity_name)).fetchone()['id']
    printing = conn.execute("INSERT INTO catalog_printing(source,source_id,identity_id) VALUES ('tcgcsv',%s,%s) RETURNING id",
                            (str(9000001 + uuid4().int % 1000000000), identity)).fetchone()['id']
    edition = conn.execute('''INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
        VALUES (%s,'unspecified','{"label":"Unspecified Variant"}') RETURNING id''', (printing,)).fetchone()['id']
    if display:
        conn.execute('''INSERT INTO catalog_printing_display
            (printing_id,display_name,set_id,set_name,collector_number,image_url)
            VALUES (%s,%s,'syn01','Synthetic Set 900',%s,%s)''', (printing, name, number, image))
    return printing, edition, identity


def generation(conn, seed=None, *, active=True, tombstoned=False):
    gen = uuid4()
    conn.execute('''INSERT INTO catalog_generation(id,source_count,raw_gzip,raw_sha256)
        VALUES (%s,1,%s,'synthetic')''', (gen, b'synthetic'))
    if seed:
        conn.execute('''INSERT INTO catalog_generation_printing
            (generation_id,printing_id,source_id,set_id,set_name,collector_number,display_name,
             search_name,source_fingerprint,basic_energy,tombstoned)
            VALUES (%s,%s,'9000001','syn01','Synthetic Set 900','001/100','Synthetic Unit 01',
                    'synthetic unit 01','synthetic','not_applicable',%s)''', (gen, seed[0], tombstoned))
        conn.execute('''INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id,active)
            VALUES (%s,%s,%s,%s)''', (gen, seed[1], seed[0], active))
    return gen


def holding(conn, edition):
    owner, leaf = str(uuid4()), uuid4()
    conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s)', (owner,))
    conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Synthetic leaf','storage_leaf')", (leaf, owner))
    conn.execute('INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,3,1)',
                 (owner, leaf, edition))
    return owner, leaf


def listing(conn, monkeypatch, owner, *, domains=(), requested=None, cursor=None):
    # Only connection ownership/isolation setup changes: rows and paging SQL are real.
    # The outer fixture transaction already owns the synthetic rows. A nested reader
    # cannot SET TRANSACTION after those inserts, so omit that one setup statement.
    class Connection:
        def execute(self, sql, params=None):
            if sql == 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ':
                return None
            return conn.execute(sql, params)

        def transaction(self):
            return conn.transaction()
    monkeypatch.setattr(inventory, 'connect', lambda: nullcontext(Connection()))
    return inventory.collection_holdings(None, 'name-asc', '', '', cursor, owner,
        facet_columns=("ARRAY['DomainA','DomainB']::text[] AS domains" if domains else
                       "ARRAY[]::text[] AS domains"), facet_joins='',
        facet_conditions='' if requested is None else ' AND %s=ANY(%s::text[])',
        facet_params=[] if requested is None else [requested, list(domains)], facet_context=[requested])


def test_rb_id_02_identity_is_not_name_equality(conn):
    a, b = card(conn), card(conn)
    twin = card(conn, identity=a[2])
    assert accepts(conn, {a[1]: 'identity', b[1]: 'identity'}) == {
        a[1]: {a[1], twin[1]}, b[1]: {b[1]}}


@pytest.mark.parametrize('display,name', [(False, 'Synthetic Unit 02'), (True, '')], ids=['RB-ID-03', 'RB-ID-04'])
def test_name_fallback(conn, display, name):
    seed = card(conn, name=name, display=display, identity_name='Synthetic Unit 04' if display else name)
    fact = card_facts(conn, [seed[1]])[seed[1]]
    assert fact.name == name
    if display:
        assert fact.name == fact.search_key == ''
    if not display:
        assert (fact.set_code, fact.set_name, fact.collector_number) == ('', '', '')


@pytest.mark.parametrize('name,words', [("Synthetic Unit: Ünit's Two // Three", 'synthetic unit units two three'),
                                     ('Synthetic-Unit Four', 'synthetic unit four'), ('', '')],
                         ids=['RB-ID-05-a', 'RB-ID-05-b', 'RB-ID-05-empty'])
def test_search_words(conn, name, words):
    seed = card(conn, name=name)
    assert conn.execute('SELECT catalog_search_words(%s) AS words', (name,)).fetchone()['words'] == words
    assert card_facts(conn, [seed[1]])[seed[1]].search_key == words.replace(' ', '')


def test_rb_pe_06_number_order(conn, monkeypatch):
    numbers = ['2/100', '7a/100', '10/100', '101*/100', 'P-001']
    seeds = [card(conn, number=n) for n in numbers]
    facts = card_facts(conn, [s[1] for s in seeds])
    assert [x.collector_number for x in sorted(facts.values(), key=lambda x: x.order())] == numbers
    owner, leaf = holding(conn, seeds[0][1])
    for seed in seeds[1:]:
        conn.execute('INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,1,1)',
                     (owner, leaf, seed[1]))
    assert len(listing(conn, monkeypatch, owner)['holdings']) == 5


def test_rb_pe_07_editions_do_not_multiply(conn, monkeypatch):
    seed = card(conn)
    ids = [seed[1]]
    for finish in ('normal', 'foil'):
        ids.append(conn.execute('''INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
            VALUES (%s,%s,jsonb_build_object('finish',%s::text)) RETURNING id''',
            (seed[0], finish, finish)).fetchone()['id'])
    owner, leaf = holding(conn, ids[0])
    for edition in ids[1:]:
        conn.execute('INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,3,1)',
                     (owner, leaf, edition))
    assert len(conn.execute(CARD_FACTS, (ids,)).fetchall()) == 3
    page = listing(conn, monkeypatch, owner)
    assert {r['edition_id'] for r in page['holdings']} == set(ids)
    assert page['totals'].copies == '9'


@pytest.mark.parametrize('mode', ['tombstoned', 'old', 'empty', 'pruned'],
                         ids=['RB-RET-01', 'RB-RET-04', 'RB-RET-05', 'RB-RET-06'])
def test_retained_inventory(conn, monkeypatch, mode):
    seed = card(conn)
    owner, _ = holding(conn, seed[1])
    old = generation(conn, seed, active=mode != 'tombstoned', tombstoned=mode == 'tombstoned')
    current = old if mode == 'tombstoned' else generation(conn)
    conn.execute('UPDATE catalog_state SET active_generation=%s WHERE singleton',
                 (None if mode == 'empty' else current,))
    if mode == 'pruned':
        conn.execute('DELETE FROM catalog_generation WHERE id=%s', (old,))
        assert conn.execute('SELECT 1 FROM catalog_generation_edition WHERE generation_id=%s', (old,)).fetchone() is None
    assert conn.execute(AVAILABLE, (seed[1],)).fetchone() is None
    assert card_facts(conn, [seed[1]])[seed[1]].name == 'Synthetic Unit 01'
    assert listing(conn, monkeypatch, owner)['totals'].copies == '3'
    if mode == 'empty':
        assert listing(conn, monkeypatch, str(uuid4()))['holdings'] == []


@pytest.mark.parametrize('domains', [('DomainA', 'DomainB'), ()], ids=['RB-DOM-02', 'RB-DOM-03'])
def test_domain_reader_half(conn, monkeypatch, domains):
    # DOM-02/03 use stand-in facet SQL until Ryan decides the catalog shape in D4.
    seed = card(conn)
    owner, _ = holding(conn, seed[1])
    page = listing(conn, monkeypatch, owner, domains=domains)
    assert len(page['holdings']) == page['totals'].editions == 1
    assert page['holdings'][0]['domains'] == list(domains)
    assert page['totals'].copies == '3'
    if not domains:
        assert listing(conn, monkeypatch, owner, domains=domains, requested='DomainA')['holdings'] == []


def test_rb_ref_01_public_reference(conn):
    seeds = [card(conn), card(conn)]
    refs = [conn.execute('SELECT public_ref FROM catalog_printing WHERE id=%s', (s[0],)).fetchone()['public_ref'] for s in seeds]
    assert len(set(refs)) == 2
    assert all(re.fullmatch('[0-9a-f]{48}', ref) for ref in refs)
    with pytest.raises(psycopg.errors.RaiseException, match='Catalog public reference is immutable'):
        with conn.transaction():
            conn.execute("UPDATE catalog_printing SET public_ref=repeat('a',48) WHERE id=%s", (seeds[0][0],))
    conn.execute('UPDATE catalog_state SET active_generation=%s,revision=revision+1 WHERE singleton',
                 (generation(conn, seeds[0]),))
    assert conn.execute('SELECT public_ref FROM catalog_printing WHERE id=%s', (seeds[0][0],)).fetchone()['public_ref'] == refs[0]


def test_rb_ref_03_and_04_set_code_fallback(conn):
    seeds = [card(conn), card(conn, display=False)]
    rows = conn.execute('SELECT * FROM catalog_printing_set_code WHERE printing_id=ANY(%s)', ([s[0] for s in seeds],)).fetchall()
    assert len(rows) == 2
    assert {r['printing_id']: r['set_code'] for r in rows} == {seeds[0][0]: '', seeds[1][0]: ''}
    facts = conn.execute(CARD_FACTS, ([s[1] for s in seeds],)).fetchall()
    assert len(facts) == 2
    for seed in seeds:
        assert sum(row['edition_id'] == seed[1] for row in facts) == 1
    assert len(card_facts(conn, [s[1] for s in seeds])) == 2
    with pytest.raises(psycopg.errors.CheckViolation) as error:
        with conn.transaction():
            conn.execute("INSERT INTO catalog_set_code(set_id,code) VALUES ('syn01','syn01')")
    assert error.value.diag.constraint_name == 'catalog_set_code_code_check'


def test_rb_ref_05_unapproved_art(conn):
    seed = card(conn)
    args = dict(allowed_host='allowed.example.invalid', linked_art=re.compile('never'))
    assert store.resolve(conn, seed[0], 'small', **args) is None
    assert card_facts(conn, [seed[1]])[seed[1]].image_url is None
    imaged = card(conn, image='https://example.invalid/synthetic')
    assert store.resolve(conn, imaged[0], 'small', **args) is None


@pytest.mark.parametrize('change,code', [('catalog', 'CATALOG_CHANGED'), ('attributes', 'CATALOG_CHANGED'),
                                      ('both', 'INVENTORY_CHANGED'), ('tamper', 'INVALID_CURSOR'),
                                      ('context', 'INVALID_CURSOR')],
                         ids=['RB-REV-01', 'RB-REV-02', 'RB-REV-04', 'RB-REV-05-tamper', 'RB-REV-05-context'])
def test_revision_cursors(conn, monkeypatch, change, code):
    monkeypatch.setenv('INTERNAL_AUTH_SECRET', 'synthetic-reader-probe-secret')
    seed, second = card(conn), card(conn)
    owner, leaf = holding(conn, seed[1])
    conn.execute('INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,1,1)',
                 (owner, leaf, second[1]))
    monkeypatch.setattr(inventory, 'HOLDING_PAGE_SIZE', 1)
    before = listing(conn, monkeypatch, owner)
    token = before['next_cursor']
    assert token is not None
    assert listing(conn, monkeypatch, owner, cursor=token)['holdings']
    if change in ('catalog', 'both'):
        conn.execute('UPDATE catalog_state SET active_generation=%s,revision=revision+1 WHERE singleton', (generation(conn),))
    if change == 'attributes':
        conn.execute('UPDATE catalog_attribute_state SET revision=revision+1 WHERE singleton')
        assert conn.execute('SELECT revision FROM catalog_state WHERE singleton').fetchone()['revision'] == before['catalog_revision']
    if change == 'both':
        conn.execute('UPDATE inventory_owner SET revision=revision+1 WHERE user_id=%s', (owner,))
    if change == 'tamper':
        token = ('A' if token[0] != 'A' else 'B') + token[1:]
    if change == 'context':
        owner = str(uuid4())
    with pytest.raises(HTTPException) as error:
        listing(conn, monkeypatch, owner, cursor=token)
    assert error.value.status_code == (400 if code == 'INVALID_CURSOR' else 409)
    assert error.value.detail['code'] == code


def test_rb_rev_06_capture_binds_revision(conn, monkeypatch):
    owner, deck = str(uuid4()), uuid4()
    conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s)', (owner,))
    conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Synthetic deck','deck')", (deck, owner))
    for module in (contents, deck_list_capture):
        monkeypatch.setattr(module, 'connect', lambda: nullcontext(conn))
    for _ in range(2):
        revision = conn.execute('UPDATE catalog_state SET active_generation=%s,revision=revision+1 WHERE singleton RETURNING revision',
                                (generation(conn),)).fetchone()['revision']
        assert contents.capture_deck_contents(deck, owner).catalog_revision == revision
        assert deck_list_capture.capture_deck_list(deck, owner).catalog_revision == revision


def test_rb_ref_02_every_inventory_reference_survives_retirement(conn):
    seed = card(conn)
    owner, _ = holding(conn, seed[1])
    deck, loan, trade = uuid4(), uuid4(), uuid4()
    conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Synthetic deck','deck')", (deck, owner))
    conn.execute('INSERT INTO deck_list_line(owner_id,deck_id,edition_id,quantity) VALUES (%s,%s,%s,1)', (owner, deck, seed[1]))
    for thread_id, kind in ((loan, 'loan'), (trade, 'trade')):
        conn.execute('''INSERT INTO thread(id,kind,created_at,last_activity_at,changed_at)
            VALUES (%s,%s,now(),now(),now())''', (thread_id, kind))
    conn.execute('''INSERT INTO loan(id,thread_id,kind,state,lender_name,borrower_name)
        VALUES (%s,%s,'borrow_request','requested','Synthetic A','Synthetic B')''', (loan, loan))
    conn.execute('INSERT INTO loan_line(loan_id,edition_id,position,requested) VALUES (%s,%s,0,1)', (loan, seed[1]))
    conn.execute("INSERT INTO trade(id,thread_id,state,proposer_name,recipient_name) VALUES (%s,%s,'proposed','Synthetic A','Synthetic B')", (trade, trade))
    conn.execute("INSERT INTO trade_line(trade_id,side,edition_id,position,quantity) VALUES (%s,'proposer',%s,0,1)", (trade, seed[1]))
    conn.execute('INSERT INTO trade_want(owner_id,edition_id,quantity) VALUES (%s,%s,1)', (owner, seed[1]))
    gen = generation(conn, seed, active=False, tombstoned=True)
    conn.execute('UPDATE catalog_state SET active_generation=%s WHERE singleton', (gen,))
    assert seed[1] in card_facts(conn, [seed[1]])
    # Isolate each FK so a single Holding FK cannot hide a missing line FK.
    for relation in ('holding', 'deck_list_line', 'loan_line', 'trade_line', 'trade_want'):
        assert conn.execute(f'''SELECT count(*) AS n FROM {relation} r
            JOIN catalog_edition e ON e.id=r.edition_id WHERE e.id=%s''', (seed[1],)).fetchone()['n'] == 1
        with conn.transaction(force_rollback=True):
            conn.execute('DELETE FROM catalog_generation_edition WHERE edition_id=%s', (seed[1],))
            for other in ('holding', 'deck_list_line', 'loan_line', 'trade_line', 'trade_want'):
                if other != relation:
                    conn.execute(f'DELETE FROM {other} WHERE edition_id=%s', (seed[1],))
            with pytest.raises(psycopg.errors.ForeignKeyViolation) as error:
                with conn.transaction():
                    conn.execute('DELETE FROM catalog_edition WHERE id=%s', (seed[1],))
            assert error.value.diag.table_name == relation
            assert error.value.sqlstate == '23503'


def test_verified_set_code_and_active_availability(conn):
    seed = card(conn)
    conn.execute("INSERT INTO catalog_set_code VALUES ('syn01','SYN')")
    assert conn.execute('SELECT set_code FROM catalog_printing_set_code WHERE printing_id=%s', (seed[0],)).fetchone()['set_code'] == 'SYN'
    verified = card(conn)
    # Printing display is immutable; insert the verified set on a fresh Printing.
    extra = card(conn, display=False)
    conn.execute("INSERT INTO catalog_printing_display VALUES (%s,'Synthetic Unit','24344','Synthetic Set','1',NULL)", (extra[0],))
    assert conn.execute('SELECT set_code FROM catalog_printing_set_code WHERE printing_id=%s', (extra[0],)).fetchone()['set_code'] == 'OGN'
    gen = generation(conn, seed)
    conn.execute('UPDATE catalog_state SET active_generation=%s WHERE singleton', (gen,))
    assert conn.execute(AVAILABLE, (seed[1],)).fetchone() is not None
