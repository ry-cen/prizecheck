"""Cards accepted by the real Riftbound ingest path are what the Riftbound Catalog read API serves.

Offline and synthetic: fabricated TCGCSV category-89 payloads go through the real `listed_groups` and `assess_pull`,
`plan_run` and `writer.apply_run` (no stub, no direct write of `active_generation` or any generation row) into a
disposable database migrated with the real Riftbound track. They are read back over HTTP through `app.riftbound_main`
with a request signed by a per-run generated secret. No network is used.

Lifecycle semantics observed, which differ from "held / retired / tombstoned" as one might first assume:

* A held *group* (failed, suspicious or not pulled) keeps its previously accepted Printings and Editions visible.
* A held *product* (duplicate number, token scope, missing from source) is carried when it was accepted before, so
  it stays visible, and a never-accepted held product never becomes visible.
* The writer never retires: `catalog_generation_printing.tombstoned` is always false and
  `catalog_generation_edition.active` always true (`lifecycle.py`: "no automatic retirement"). A product that vanishes
  from the source stays visible with a `missing_from_source` review. The 404-after-retirement behaviour of the read API
  is therefore covered only by `test_riftbound_catalog_read_api.py`, with seeded rows; the ingest path cannot reach it.
* A display change on an accepted product holds only the *proposed display fields*: the catalog keeps the accepted
  name, number and set name and records a `display_change` review. The Printing is still processed in that pull
  (`plan.py:368`), so a supported finish in the same pull can still be added.
* A changed price set adds Editions (a new finish) and a new product adds a Printing; those are the accepted changes.
"""
import secrets

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.core.ops.operation_counts import counter
from app.games.riftbound.catalog import plan, writer
from app.games.riftbound.catalog.assess import assess_pull, listed_groups
from test_core_baseline import admin, databases  # noqa: F401
from test_riftbound_catalog_assess import envelope
from test_riftbound_catalog_plan import price, product
from test_riftbound_catalog_read_api import entry, signed  # noqa: F401
from test_riftbound_migrate import ROOT, migrate

GROUPS = envelope([{'groupId': 902, 'name': 'Synthetic Set 902', 'categoryId': 89},
                   {'groupId': 901, 'name': 'Synthetic Set 901', 'categoryId': 89},
                   {'groupId': 900, 'name': 'Synthetic Set 900', 'categoryId': 89}])


class Api:
    def __init__(self, app, secret):
        self.http, self.secret = TestClient(app), secret

    def get(self, path, **params):
        response = self.http.get(path, params=params, headers=signed('GET', path, secret=self.secret))
        assert response.status_code == 200, (path, response.status_code, response.text)
        return response.json()

    def status(self, path):
        return self.http.get(path, headers=signed('GET', path, secret=self.secret)).status_code

    def shown(self, **params):
        """(name, set id, number, finish) of every listed Edition, in served order."""
        return [(e['name'], e['set']['id'], e['number'], e['finish']) for e in self.get('/api/catalog/editions', **params)['editions']]

    def everything(self):
        listing = self.get('/api/catalog/editions')
        return {'sets': self.get('/api/catalog/sets'), 'listing': listing,
                'details': {e['id']: self.get(f"/api/catalog/editions/{e['id']}") for e in listing['editions']}}


def connect_api(entry, monkeypatch, url):  # noqa: F811
    secret = secrets.token_hex(16)  # a per-run secret, never a constant
    monkeypatch.setenv('RIFTBOUND_DATABASE_URL', url)
    monkeypatch.setenv('RIFTBOUND_INTERNAL_AUTH_SECRET', secret)
    monkeypatch.delenv('INTERNAL_AUTH_SECRET', raising=False)
    monkeypatch.setenv('DATABASE_URL', 'postgresql://unused.invalid/pokemon')  # must never be opened
    return Api(entry.app, secret)


@pytest.fixture
def migrated(databases):  # noqa: F811
    """A fresh disposable database per test, migrated with the real Riftbound track; `databases` drops it."""
    url = databases()
    migrate(ROOT, url)
    return url


@pytest.fixture
def writer_conn(migrated):
    with psycopg.connect(migrated) as conn:
        yield conn


def restore_counter(previous):
    """Drain the counts these Riftbound requests queued while the writer is still off, then put the writer back.

    `record` queues even with no writer and the background thread reads the writer only when it drains, so restoring
    first could write Riftbound request counts to another database (operation_counts.py `flush`, as test_operation_counts does).
    """
    assert counter.flush(), 'queued request counts were not drained'
    assert counter._queue.unfinished_tasks == 0 and counter._queue.empty()
    counter.set_writer(previous)


@pytest.fixture
def api(entry, monkeypatch, migrated, writer_conn):  # noqa: F811
    previous = counter.set_writer(None)
    try:
        yield connect_api(entry, monkeypatch, migrated)
    finally:
        restore_counter(previous)


def pulls(*specs):
    """One assessed pull per (group id, [products], [prices]); the group list is parsed from a category-89 payload."""
    info = {g.group_id: g for g in listed_groups(GROUPS)}
    return [assess_pull(info[gid], envelope(products), envelope(prices)) for gid, products, prices in specs]


def first_pull():
    return pulls(
        (900, [product(9000001, '001', 900, 'Synthetic Alpha'), product(9000002, '002', 900, 'Synthetic Beta'),
               product(9000003, '003', 900, 'Synthetic Gamma'), product(9000004, '004', 900, 'Synthetic Delta'),
               product(9000005, '005', 900, 'Synthetic Epsilon')],
         [price(9000001, 'Normal'), price(9000001, 'Foil'), price(9000002, 'Normal'),
          price(9000004, 'Normal'), price(9000005, 'Normal')]),
        (901, [product(9000011, '001', 901, 'Synthetic Zeta')], [price(9000011, 'Normal')]))


FIRST = [('Synthetic Alpha', '900', '001', 'foil'), ('Synthetic Alpha', '900', '001', 'normal'),
         ('Synthetic Beta', '900', '002', 'normal'), ('Synthetic Delta', '900', '004', 'normal'),
         ('Synthetic Epsilon', '900', '005', 'normal'), ('Synthetic Gamma', '900', '003', 'unspecified'),
         ('Synthetic Zeta', '901', '001', 'normal')]


def state(url):
    with psycopg.connect(url) as conn:
        return conn.execute('SELECT active_generation,revision FROM catalog_state').fetchone()


def test_a_freshly_migrated_database_with_no_accepted_pull_is_empty(entry, monkeypatch, databases):  # noqa: F811
    url = databases()
    migrate(ROOT, url)
    previous = counter.set_writer(None)
    try:
        api = connect_api(entry, monkeypatch, url)
        assert state(url) == (None, 0)
        assert api.get('/api/catalog/sets') == []
        assert api.get('/api/catalog/editions') == {'editions': [], 'total': 0, 'pages': 1, 'catalog_empty': True}
    finally:
        restore_counter(previous)


def test_a_first_accepted_pull_is_listed_searched_filtered_and_found_by_id(api, writer_conn, migrated):
    report = writer.apply_run(writer_conn, first_pull())
    assert report.promoted and report.revision == 1 and report.plan.compared == 2
    assert state(migrated) == (report.generation_id, 1)

    listing = api.get('/api/catalog/editions')
    assert (listing['total'], listing['pages'], listing['catalog_empty']) == (7, 1, False)
    assert api.shown() == FIRST
    assert api.get('/api/catalog/sets') == [{'id': '900', 'name': 'Synthetic Set 900', 'code': ''},
                                            {'id': '901', 'name': 'Synthetic Set 901', 'code': ''}]
    assert api.shown(q='  epsilon ') == [('Synthetic Epsilon', '900', '005', 'normal')]  # name, case and padding ignored
    assert api.shown(q='003') == [('Synthetic Gamma', '900', '003', 'unspecified')]  # collector number
    assert api.shown(q='001') == [FIRST[0], FIRST[1], FIRST[6]]  # one number in two sets, a Printing's two finishes
    assert api.get('/api/catalog/editions', set='901')['total'] == 1
    assert api.shown(set='900') == FIRST[:6]
    assert api.shown(set='900', q='zeta') == [] and api.shown(set='903') == []

    with psycopg.connect(migrated) as conn:  # the served Printing is the one the writer made for that product
        source = dict(conn.execute('SELECT id::text,source_id FROM catalog_printing').fetchall())
    for edition in listing['editions']:
        assert api.get(f"/api/catalog/editions/{edition['id']}") == edition
        assert source[edition['printing_id']] == {'Synthetic Alpha': '9000001', 'Synthetic Beta': '9000002',
            'Synthetic Gamma': '9000003', 'Synthetic Delta': '9000004', 'Synthetic Epsilon': '9000005',
            'Synthetic Zeta': '9000011'}[edition['name']]
    assert api.status('/api/catalog/editions/00000000-0000-4000-8000-000000000000') == 404


def test_a_mixed_pull_shows_accepted_changes_and_never_a_held_candidate(api, writer_conn, migrated):
    first = writer.apply_run(writer_conn, first_pull())
    before = {e['id']: (e['name'], e['set']['id'], e['number'], e['finish']) for e in api.get('/api/catalog/editions')['editions']}
    second = writer.apply_run(writer_conn, pulls(
        (900, [product(9000001, '001', 900, 'Synthetic Alpha'), product(9000002, '002', 900, 'Synthetic Beta'),
               product(9000003, '003', 900, 'Synthetic Gamma Renamed'),  # a display change on an accepted product
               # 9000004 Delta is missing from the source
               product(9000005, '005', 900, 'Synthetic Epsilon', **{'Card Type': 'Unit;Token'}),  # now out of scope
               product(9000006, '006', 900, 'Synthetic Eta'),  # a new accepted product
               product(9000007, '007', 900, 'Synthetic Held Theta'),  # two new products sharing one number
               product(9000008, '007', 900, 'Synthetic Held Iota')],
         [price(9000001, 'Normal'), price(9000001, 'Foil'), price(9000002, 'Normal'), price(9000002, 'Foil'),
          price(9000005, 'Normal'), price(9000006, 'Normal'), price(9000007, 'Normal'), price(9000008, 'Normal')])
    ) + [assess_pull(plan.GroupInfo(901, 'Synthetic Set 901'), None, None, fetch_error='Synthetic fetch failure'),
         assess_pull(plan.GroupInfo(902, 'Synthetic Set 902'), envelope([product(9000021, '001', 902, 'Synthetic Never')], totalItems=9),
                     envelope([price(9000021, 'Normal')]))])
    assert second.promoted and second.revision == 2 and second.plan.compared == 1
    assert {o.group_id: o.status for o in second.plan.outcomes} == {900: 'compared', 901: 'pull_failed', 902: 'pull_suspicious'}
    assert second.generation_id != first.generation_id and state(migrated) == (second.generation_id, 2)

    assert api.shown() == [
        ('Synthetic Alpha', '900', '001', 'foil'), ('Synthetic Alpha', '900', '001', 'normal'),
        ('Synthetic Beta', '900', '002', 'foil'), ('Synthetic Beta', '900', '002', 'normal'),  # accepted: a new finish
        ('Synthetic Delta', '900', '004', 'normal'),  # missing from source: carried, not retired
        ('Synthetic Epsilon', '900', '005', 'normal'),  # now a token: carried, not retired
        ('Synthetic Eta', '900', '006', 'normal'),  # accepted: a new product
        ('Synthetic Gamma', '900', '003', 'unspecified'),  # the display change is a review; the accepted name stays
        ('Synthetic Zeta', '901', '001', 'normal')]  # its group's pull was held, so its last accepted rows stay
    assert api.get('/api/catalog/editions')['total'] == 9
    assert api.get('/api/catalog/sets') == [{'id': '900', 'name': 'Synthetic Set 900', 'code': ''},
                                            {'id': '901', 'name': 'Synthetic Set 901', 'code': ''}]  # 902 never accepted
    for hidden in ('held', 'theta', 'iota', 'renamed', 'never', '007', '021'):
        assert api.get('/api/catalog/editions', q=hidden)['total'] == 0, hidden
    assert api.get('/api/catalog/editions', set='902')['total'] == 0
    assert len(before) == 7  # both of Alpha's finishes are tracked, each by its own Edition id
    for edition_id, shown in before.items():  # an Edition shown before keeps its id and stays reachable by id
        detail = api.get(f'/api/catalog/editions/{edition_id}')
        assert (detail['name'], detail['set']['id'], detail['number'], detail['finish']) == shown

    with psycopg.connect(migrated) as conn:
        assert conn.execute("SELECT count(*) FROM catalog_printing WHERE source_id IN ('9000007','9000008','9000021')").fetchone()[0] == 0
        assert conn.execute('''SELECT count(*) FROM catalog_state s JOIN catalog_generation_printing gp ON gp.generation_id=s.active_generation
            WHERE gp.tombstoned''').fetchone()[0] == 0
        assert conn.execute('''SELECT count(*) FROM catalog_state s JOIN catalog_generation_edition ge ON ge.generation_id=s.active_generation
            WHERE NOT ge.active''').fetchone()[0] == 0
        kinds = {r[0] for r in conn.execute("SELECT kind FROM catalog_review WHERE status='pending'")}
    assert {'display_change', 'missing_from_source', 'card_scope_pending', 'duplicate_number_pending', 'group_pull_held'} <= kinds


def test_a_fully_held_pull_keeps_the_accepted_generation_exactly(api, writer_conn, migrated):
    writer.apply_run(writer_conn, first_pull())
    writer.apply_run(writer_conn, pulls((900, [product(9000006, '006', 900, 'Synthetic Eta')], [price(9000006, 'Normal')])))
    accepted, shown = state(migrated), api.everything()
    assert shown['listing']['total'] == 8 and shown['listing']['catalog_empty'] is False

    held = [assess_pull(plan.GroupInfo(900, 'Synthetic Set 900'), None, None, fetch_error='Synthetic fetch failure'),
            assess_pull(plan.GroupInfo(901, 'Synthetic Set 901'), envelope([product(9000011, '001', 901, 'Synthetic Zeta')], totalItems=5),
                        envelope([price(9000011, 'Normal')])),
            assess_pull(plan.GroupInfo(902, 'Synthetic Set 902'), envelope([product(9000021, '001', 902, 'Synthetic Never')]), {'success': False})]
    report = writer.apply_run(writer_conn, held)
    assert not report.promoted and report.plan.compared == 0
    assert {o.group_id: o.status for o in report.plan.outcomes} == {900: 'pull_failed', 901: 'pull_suspicious', 902: 'pull_failed'}
    assert state(migrated) == accepted and report.generation_id == accepted[0]
    assert api.everything() == shown
    assert api.get('/api/catalog/editions', q='never')['total'] == 0
    with psycopg.connect(migrated) as conn:
        assert conn.execute("SELECT outcome FROM catalog_run WHERE id=%s", (report.run_id,)).fetchone()[0] == 'failed'
