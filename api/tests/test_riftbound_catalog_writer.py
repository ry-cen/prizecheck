"""Writer transactions on freshly migrated, synthetic Riftbound databases."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import gzip
import hashlib
import json
from threading import Event
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
import pytest

from app.games.riftbound.catalog import plan, writer
from app.core.catalog.card_facts import card_facts
from app.core.trading.trade_wants import AVAILABLE
from test_core_baseline import admin, databases  # noqa: F401
from test_riftbound_migrate import migrate, ROOT
from test_riftbound_catalog_plan import product, price, pull
from test_riftbound_shared_readers import holding, listing


@pytest.fixture
def url(databases):
    url = databases()
    migrate(ROOT, url)
    return url


@pytest.fixture
def conn(url):
    with psycopg.connect(url, row_factory=dict_row) as conn:
        yield conn


def rows(conn, sql, args=()):
    with conn.transaction():
        return conn.execute(sql, args).fetchall()


def one(conn, sql, args=()):
    return rows(conn, sql, args)[0]


def state(conn):
    return one(conn, 'SELECT * FROM catalog_state')


def accepted(conn):
    return rows(conn, '''SELECT gp.printing_id,ge.edition_id,e.descriptor_key,h.quantity,
        gp.source_id,gp.tombstoned,ge.active FROM catalog_state s
        JOIN catalog_generation_printing gp ON gp.generation_id=s.active_generation
        JOIN catalog_generation_edition ge ON ge.generation_id=gp.generation_id AND ge.printing_id=gp.printing_id
        JOIN catalog_edition e ON e.id=ge.edition_id LEFT JOIN holding h ON h.edition_id=e.id
        ORDER BY gp.source_id,e.descriptor_key''')


def seed(conn):
    report = writer.apply_run(conn, [pull(prices=[price()])])
    edition = one(conn, 'SELECT id FROM catalog_edition')['id']
    with conn.transaction():
        owner, leaf = holding(conn, edition)
    return report, edition, owner, leaf


def assert_survives(conn, before):
    after = accepted(conn)
    for row in before:
        assert row in after
        assert row['active'] and not row['tombstoned'] and row['quantity'] == 3
        assert one(conn, AVAILABLE, (row['edition_id'],))
    assert one(conn, 'SELECT count(*) AS n FROM catalog_printing WHERE source<>\'tcgcsv\' AND source<>\'manual\'')['n'] == 0


def test_first_acceptable_run_promotes_and_readers_see_it(conn, monkeypatch):
    report, edition, owner, _ = seed(conn)
    assert report.promoted and report.revision == 1
    with conn.transaction():
        assert card_facts(conn, [edition])[edition].name == 'Synthetic Unit 01'
        assert listing(conn, monkeypatch, owner)['totals'].copies == '3'
    raw = one(conn, 'SELECT * FROM catalog_generation')
    data = bytes(raw['raw_gzip'])
    assert gzip.decompress(data) == json.dumps({'900': pull(prices=[price()]).raw}, sort_keys=True, separators=(',', ':')).encode()
    assert raw['raw_sha256'] == hashlib.sha256(data).hexdigest()
    assert one(conn, 'SELECT basic_energy,image_url FROM catalog_generation_printing') == {'basic_energy': 'not_applicable', 'image_url': None}
    assert one(conn, 'SELECT outcome,enumerated_count,fetched_count,validated_count FROM catalog_run') == dict(
        outcome='succeeded', enumerated_count=1, fetched_count=1, validated_count=1)


def test_identical_rerun_creates_no_generation_and_keeps_revision(conn):
    seed(conn)
    before, content = state(conn), accepted(conn)
    report = writer.apply_run(conn, [pull(prices=[price()])])
    after = state(conn)
    assert not report.promoted and report.revision == before['revision']
    assert {k:v for k,v in before.items() if k!='last_success'} == {k:v for k,v in after.items() if k!='last_success'}
    assert after['last_success'] > before['last_success']
    assert accepted(conn) == content
    assert one(conn, 'SELECT count(*) AS n FROM catalog_generation')['n'] == 1
    assert one(conn, 'SELECT count(*) AS n FROM catalog_run')['n'] == 2


@pytest.mark.parametrize('quality,result,status', [('acceptable', None, 'pull_failed'), ('suspicious', True, 'pull_suspicious'),
                                                 ('unknown', True, 'quality_unknown'), ('acceptable', False, 'not_pulled'),
                                                 ('acceptable', True, 'compared')])
def test_each_group_outcome_preserves_printings_editions_and_holdings(conn, quality, result, status):
    seed(conn)
    before = accepted(conn)
    p = replace(pull(quality=quality, prices=[price()]), result=None) if result is None else pull(quality=quality, prices=[price()])
    pulls = [] if result is False else [p]
    pulls.append(pull([product(9000010, '010', gid=901)], gid=901))
    report = writer.apply_run(conn, pulls)
    assert next(o.status for o in report.plan.outcomes if o.group_id==900) == status
    assert_survives(conn, before)


def test_no_accepted_group_keeps_catalog_and_records_failed_run(conn):
    seed(conn)
    before = state(conn), accepted(conn)
    report = writer.apply_run(conn, [pull(quality='suspicious')])
    assert not report.promoted
    assert (state(conn), accepted(conn)) == before
    assert one(conn, 'SELECT outcome FROM catalog_run WHERE id=%s', (report.run_id,))['outcome'] == 'failed'


@pytest.mark.parametrize('case', ['missing','duplicate_number','scope','details','text','repeated','marker',
                                 'unknown_finish','group_change','display_change','duplicate_product','excluded'])
def test_each_hold_preserves_active_rows_and_holdings(conn, case):
    seed(conn)
    before = accepted(conn)
    products, prices = [product()], [price()]
    gid = 900
    if case=='missing': products=[]; prices=[]
    if case=='duplicate_number': products.append(product(9000002))
    if case=='scope': products=[product(number=None)]
    if case=='details': products=[product(), product(9000002,'002',name='Synthetic Unit 01 (Alternate Art)', **{'Might':'999'})]
    if case=='text': products=[product(Description='Changed rules.')]
    if case=='repeated': products[0]['extendedData'].append({'name':'Number','value':'999'})
    if case=='marker': products=[product(name='Synthetic Unit 01 (Mystery Art)')]
    if case=='unknown_finish': prices=[price(finish='Mystery')]
    if case=='group_change': gid=901; products=[product(gid=901)]
    if case=='display_change': products=[product(number='999')]
    if case=='excluded': products=[product(**{'Card Type':'Unit;Token'})]
    pulls=[pull(products, prices, gid=gid)]
    if case=='duplicate_product': pulls.append(pull([product(gid=901)], gid=901))
    report = writer.apply_run(conn, pulls)
    assert_survives(conn, before)
    expected = {'missing':'missing_from_source', 'duplicate_number':'duplicate_number_pending',
                'scope':'card_scope_pending', 'details':'printing_details_differ', 'text':'identity_text_conflict',
                'repeated':'extended_field_repeated', 'marker':'marker_grouping_pending',
                'unknown_finish':'finish_policy_pending', 'group_change':'group_change',
                'display_change':'display_change', 'duplicate_product':'duplicate_product_id', 'excluded':'card_scope_pending'}
    assert expected[case] in {r.kind for r in report.plan.reviews}
    assert one(conn, 'SELECT count(*) AS n FROM catalog_generation')['n'] <= 2


def test_equal_digest_persists_new_review_and_changed_snapshot(conn):
    seed(conn)
    before = state(conn)
    snapshot_before = one(conn, 'SELECT snapshot_sha256 FROM riftbound_group_snapshot')['snapshot_sha256']
    report = writer.apply_run(conn, [pull([product(Description='Changed rules.')], [price()])])
    assert not report.promoted and report.plan.reviews
    assert one(conn, 'SELECT snapshot_sha256 FROM riftbound_group_snapshot')['snapshot_sha256'] != snapshot_before
    after = state(conn)
    assert {k:v for k,v in after.items() if k!='last_success'} == {k:v for k,v in before.items() if k!='last_success'}
    assert after['last_success'] > before['last_success']
    assert one(conn, 'SELECT count(*) AS n FROM catalog_generation')['n']==1
    assert one(conn, 'SELECT accepted_run FROM riftbound_group_snapshot')['accepted_run']==report.run_id
    assert one(conn, 'SELECT outcome FROM catalog_run WHERE id=%s', (report.run_id,))['outcome']=='succeeded'
    with conn.transaction():
        conn.execute("UPDATE catalog_review SET status='dismissed'")
    writer.apply_run(conn, [pull([product(Description='Changed rules.')], [price()])])
    assert {r['status'] for r in rows(conn,'SELECT status FROM catalog_review')}=={'dismissed'}


def test_vanished_price_keeps_edition_active_and_holding_available(conn):
    seed(conn)
    before = accepted(conn)
    writer.apply_run(conn, [pull()])
    assert_survives(conn, before)


def test_different_digest_promotes_and_pruning_keeps_inventory(conn):
    seed(conn)
    before = accepted(conn)
    for pid in (9000002,9000003,9000004):
        report = writer.apply_run(conn, [pull([product(), product(pid, str(pid))], [price()])])
        assert report.promoted
        assert_survives(conn, before)
    assert one(conn, 'SELECT count(*) AS n FROM catalog_generation')['n']==2
    assert one(conn, '''SELECT count(*) AS n FROM catalog_generation_edition ge
        JOIN catalog_edition e ON e.id=ge.edition_id WHERE ge.printing_id<>e.printing_id''')['n']==0


def test_manual_printing_is_carried_across_promotions(conn):
    seed(conn)
    with conn.transaction():
        identity = conn.execute('SELECT id FROM catalog_identity').fetchone()['id']
        pid = conn.execute("INSERT INTO catalog_printing(source,identity_id) VALUES ('manual',%s) RETURNING id",(identity,)).fetchone()['id']
        eid = conn.execute('''INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
            VALUES (%s,%s,%s) RETURNING id''',(pid,plan.descriptor_key(plan.UNSPECIFIED),json.dumps(plan.UNSPECIFIED))).fetchone()['id']
        gen = conn.execute('SELECT active_generation FROM catalog_state').fetchone()['active_generation']
        conn.execute('''INSERT INTO catalog_generation_printing(generation_id,printing_id,source_id,set_id,set_name,
            collector_number,display_name,search_name,source_fingerprint) VALUES (%s,%s,%s,'','Synthetic','001','Synthetic','synthetic','manual')''',(gen,pid,f'manual:{pid}'))
        conn.execute('INSERT INTO catalog_generation_edition VALUES (%s,%s,%s,true)',(gen,eid,pid))
        holding(conn,eid)
    before = accepted(conn)
    writer.apply_run(conn,[pull([product(),product(9000002,'002')],[price()])])
    assert_survives(conn,before)
    assert one(conn,'SELECT source_id FROM catalog_printing WHERE id=%s',(pid,))['source_id'] is None
    assert any(r['source_id']==f'manual:{pid}' for r in accepted(conn))


def test_default_tuple_connections_and_nonidle_rejection(url):
    with psycopg.connect(url) as conn:
        assert writer.apply_run(conn,[pull()]).promoted
        conn.execute('SELECT 1')
        with pytest.raises(ValueError,match='idle'):
            writer.apply_run(conn,[pull()])


def test_failure_rolls_back_and_nonobject_descriptor_is_rejected(conn, monkeypatch):
    original = plan.plan_run
    def invalid(previous, pulls):
        p = original(previous,pulls)
        return replace(p,printings=(replace(p.printings[0], editions=(plan.EditionRow('[]',[]),)),))
    monkeypatch.setattr(plan,'plan_run',invalid)
    with pytest.raises(ValueError,match='JSON object'):
        writer.apply_run(conn,[pull()])
    assert one(conn,'SELECT count(*) AS n FROM catalog_identity')['n']==0
    assert one(conn,'SELECT count(*) AS n FROM catalog_generation')['n']==0
    assert one(conn,'SELECT outcome FROM catalog_run')['outcome']=='failed'


def test_writer_never_uses_app_db(conn, monkeypatch):
    import app.db
    def forbidden(*args,**kwargs):
        raise AssertionError('app.db used')
    monkeypatch.setattr(app.db,'connect',forbidden)
    assert writer.apply_run(conn,[pull()]).promoted


def test_busy_run_refuses_without_writing(conn, url):
    with psycopg.connect(url) as other:
        other.execute("INSERT INTO catalog_run(phase,lease_until) VALUES ('promoting',now()+interval '30 minutes')")
    with pytest.raises(writer.WriterBusy):
        writer.apply_run(conn,[pull()])
    assert one(conn,'SELECT count(*) AS n FROM catalog_run')['n']==1
    assert state(conn)['revision']==0


def test_expired_lease_run_is_marked_failed_and_next_run_proceeds(conn):
    with conn.transaction():
        old=conn.execute("INSERT INTO catalog_run(phase,lease_until) VALUES ('promoting',now()-interval '1 minute') RETURNING id").fetchone()['id']
    assert writer.apply_run(conn,[pull()]).promoted
    assert one(conn,'SELECT outcome,error FROM catalog_run WHERE id=%s',(old,))==dict(outcome='failed',error='Riftbound catalog run lease expired')


def test_expired_between_transactions_writes_nothing(conn, url, monkeypatch):
    original=conn.transaction
    calls=0
    def transaction(*args,**kwargs):
        nonlocal calls
        calls+=1
        if calls==2:
            with psycopg.connect(url) as other:
                other.execute("UPDATE catalog_run SET lease_until=now()-interval '1 minute' WHERE outcome IS NULL")
                other.execute("""UPDATE catalog_run SET outcome='failed',phase='failed',
                    error='Riftbound catalog run lease expired',finished_at=now()
                    WHERE outcome IS NULL AND lease_until < now()""")
        return original(*args,**kwargs)
    monkeypatch.setattr(conn,'transaction',transaction)
    with pytest.raises(writer.RunExpired):
        writer.apply_run(conn,[pull()])
    assert state(conn)['revision']==0
    assert one(conn,'SELECT count(*) AS n FROM catalog_identity')['n']==0
    assert one(conn,'SELECT outcome FROM catalog_run')['outcome']=='failed'


@pytest.mark.parametrize('mutation', ['expiry', 'holding'])
def test_tx_b_fences_expiry_and_holdings_mutations(conn, url, monkeypatch, mutation):
    seed(conn)
    original=plan.plan_run
    locked,release=Event(),Event()
    def paused(previous,pulls):
        locked.set()
        assert release.wait(10)
        return original(previous,pulls)
    monkeypatch.setattr(plan,'plan_run',paused)
    with psycopg.connect(url,autocommit=True,row_factory=dict_row) as other, ThreadPoolExecutor(max_workers=2) as pool:
        future=pool.submit(writer.apply_run,conn,[pull([product(),product(9000002,'002')],[price()])])
        assert locked.wait(10)
        # NOWAIT proves both row fences without a timing-based assertion.
        for sql in ('SELECT * FROM catalog_state FOR SHARE NOWAIT',
                    'SELECT * FROM catalog_run WHERE outcome IS NULL FOR UPDATE NOWAIT'):
            with pytest.raises(psycopg.errors.LockNotAvailable), other.transaction():
                other.execute(sql)
        # An actual expiry UPDATE waits on the run lock, then rechecks outcome.
        pid=other.info.backend_pid
        sql = ("UPDATE catalog_run SET outcome='failed' WHERE outcome IS NULL AND lease_until < now()+interval '1 hour'"
               if mutation == 'expiry' else """WITH fence AS MATERIALIZED
               (SELECT singleton FROM catalog_state FOR SHARE)
               UPDATE holding SET quantity=quantity+1 FROM fence""")
        expiry=pool.submit(other.execute,sql)
        # Wait on observed PostgreSQL lock state, with a bounded deadline; no sleep as synchronization.
        import time
        deadline=time.monotonic()+10
        with psycopg.connect(url,autocommit=True) as observer:
            while not observer.execute('SELECT cardinality(pg_blocking_pids(%s))>0',(pid,)).fetchone()[0]:
                assert time.monotonic()<deadline
        release.set()
        assert future.result(timeout=10).promoted
        assert expiry.result(timeout=10).rowcount == (0 if mutation == 'expiry' else 1)
    assert not rows(conn,"SELECT id FROM catalog_run WHERE outcome<>'succeeded'")


@pytest.mark.parametrize('flag', sorted(plan.PRODUCT_HOLD_FLAGS))
def test_every_product_hold_flag_keeps_accepted_rows(conn, flag):
    seed(conn)
    before = accepted(conn)
    current = pull()
    candidate = replace(current.result.printings[0], flags=(flag,))
    current = replace(current, result=replace(current.result, printings=(candidate,)))
    report = writer.apply_run(conn, [current])
    assert report.plan.printings[0].carried
    assert report.plan.outcomes[0].held_review == 1
    assert_survives(conn, before)


def catalog_rows(conn):
    tables = ('catalog_state','catalog_identity','catalog_printing','catalog_edition','catalog_generation',
              'catalog_generation_printing','catalog_generation_edition','riftbound_group_snapshot','riftbound_identity_evidence')
    return {table: rows(conn, f'SELECT * FROM {table} ORDER BY 1,2') for table in tables}


@pytest.mark.parametrize('mode', ['failed','suspicious','unknown','not_pulled'])
def test_all_groups_held_records_reviews_and_failed_run_without_touching_catalog(conn, mode):
    seed(conn)
    before = catalog_rows(conn)
    current = pull(quality={'unknown':'unknown','suspicious':'suspicious'}.get(mode,'acceptable'))
    if mode=='failed': current=replace(current,result=None)
    report = writer.apply_run(conn, [] if mode=='not_pulled' else [current])
    assert not report.promoted and catalog_rows(conn)==before
    review = one(conn,"SELECT * FROM catalog_review WHERE kind='group_pull_held'")
    assert review['source_id']=='group:900' and review['printing_id'] is None and review['status']=='pending'
    assert one(conn,'SELECT outcome FROM catalog_run WHERE id=%s',(report.run_id,))['outcome']=='failed'
    writer.apply_run(conn, [] if mode=='not_pulled' else [current])
    assert one(conn,"SELECT count(*) AS n FROM catalog_review WHERE kind='group_pull_held'")['n']==1
    assert catalog_rows(conn)==before


def test_one_held_group_keeps_its_rows_and_snapshot_while_others_promote(conn):
    seed(conn)
    before=accepted(conn)
    snapshot=rows(conn,'SELECT * FROM riftbound_group_snapshot WHERE group_id=900')
    editions=rows(conn,'SELECT * FROM catalog_edition ORDER BY id')
    report=writer.apply_run(conn,[pull(quality='suspicious'),pull([product(9000002,'002',gid=901)],gid=901)])
    assert report.promoted and report.plan.compared==1
    assert_survives(conn,before)
    assert rows(conn,'SELECT * FROM riftbound_group_snapshot WHERE group_id=900')==snapshot
    assert all(e in rows(conn,'SELECT * FROM catalog_edition') for e in editions)
    assert one(conn,"SELECT candidate FROM catalog_review WHERE kind='group_pull_held'")['candidate']=={
        'group_id':900,'status':'pull_suspicious','reasons':['pull_suspicious']}


def test_assessed_suspicious_pull_end_to_end(conn):
    from app.games.riftbound.catalog.assess import assess_pull
    seed(conn)
    before=catalog_rows(conn)
    current=assess_pull(plan.GroupInfo(900,'Synthetic Set 900'),
        {'success':True,'results':[product()],'totalItems':2}, {'success':True,'results':[]})
    report=writer.apply_run(conn,[current])
    assert not report.promoted and catalog_rows(conn)==before
    assert one(conn,"SELECT detail,candidate FROM catalog_review WHERE kind='group_pull_held'")=={
        'detail':'total_items_mismatch', 'candidate':{'group_id':900,'status':'pull_suspicious','reasons':['total_items_mismatch']}}


@pytest.mark.parametrize('subtype', [[], {}], ids=['list', 'object'])
def test_malformed_group_does_not_stop_complete_sibling(conn, subtype):
    from app.games.riftbound.catalog.assess import assess_pull
    from test_riftbound_catalog_assess import envelope
    seed(conn)
    before = accepted(conn)
    snapshot = rows(conn, 'SELECT * FROM riftbound_group_snapshot WHERE group_id=900')
    pulls = [
        assess_pull(plan.GroupInfo(900, 'Synthetic Set 900'), envelope([product()]),
                    envelope([{**price(), 'subTypeName': subtype}])),
        assess_pull(plan.GroupInfo(901, 'Synthetic Set 901'),
                    envelope([product(9000002, '002', gid=901)]), envelope([])),
    ]
    report = writer.apply_run(conn, pulls)
    assert report.promoted and report.plan.compared == 1
    assert [(o.group_id, o.status) for o in report.plan.outcomes] == [(900, 'pull_failed'), (901, 'compared')]
    assert_survives(conn, before)
    assert rows(conn, 'SELECT * FROM riftbound_group_snapshot WHERE group_id=900') == snapshot
    assert {r['source_id'] for r in accepted(conn)} == {'9000001', '9000002'}
    assert one(conn, "SELECT source_id,detail,candidate FROM catalog_review WHERE kind='group_pull_held'") == {
        'source_id': 'group:900', 'detail': 'malformed_response',
        'candidate': {'group_id': 900, 'status': 'pull_failed', 'reasons': ['malformed_response']}}
    assert one(conn, 'SELECT outcome FROM catalog_run WHERE id=%s', (report.run_id,))['outcome'] == 'succeeded'


@pytest.mark.parametrize('which', ['products', 'prices'])
@pytest.mark.parametrize('identifier', [-1, 0, 10**19, True, '5'])
def test_invalid_product_id_does_not_block_sibling_promotion(conn, which, identifier):
    from app.games.riftbound.catalog.assess import assess_pull
    from test_riftbound_catalog_assess import envelope
    seed(conn)
    before = accepted(conn)
    snapshot = rows(conn, 'SELECT * FROM riftbound_group_snapshot WHERE group_id=900')
    payloads = {'products': envelope([product()]), 'prices': envelope([price()])}
    payloads[which]['results'][0]['productId'] = identifier
    pulls = [assess_pull(plan.GroupInfo(900, 'Synthetic Set 900'), **payloads),
             assess_pull(plan.GroupInfo(901, 'Synthetic Set 901'),
                         envelope([product(9000002, '002', gid=901)]), envelope([]))]
    report = writer.apply_run(conn, pulls)
    assert report.promoted and report.plan.compared == 1
    assert_survives(conn, before)
    assert rows(conn, 'SELECT * FROM riftbound_group_snapshot WHERE group_id=900') == snapshot
    assert {r['source_id'] for r in accepted(conn)} == {'9000001', '9000002'}
    hold = one(conn, "SELECT source_id,candidate FROM catalog_review WHERE kind='group_pull_held'")
    assert hold['source_id'] == 'group:900' and 'invalid_id' in hold['candidate']['reasons']
    assert one(conn, 'SELECT outcome FROM catalog_run WHERE id=%s', (report.run_id,))['outcome'] == 'succeeded'
