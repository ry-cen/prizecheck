"""Relationship closures: explicit log kinds, global lock order and one final thread pass."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID, uuid4
from stranger_fixtures import trader_of

import pytest

from app.main import connect
from app.social import friends, reports
from test_catalog_targets import isolated_rules  # noqa: F401
from test_deck_cost import launches, store  # noqa: F401
from test_deck_counting import hold
from test_ending_friendship import remove
from test_friend_copies import ok
from test_handover import handover
from test_holdings import call
from test_loans import accept, sent, view as loan_view
from test_trade_reports import as_owner, decide, filed, report
from test_trade_swap import confirm
from test_trades import accept_trade, counter, detail, proposed, read, trading


@pytest.mark.parametrize('action,kind', [('unfriend','closed_unfriended'), ('block','closed_blocked'),
                                       ('report','closed_blocked'), ('suspend','closed_suspended')])
def test_each_closure_logs_one_event_per_item_and_touches_threads_once_last(store, monkeypatch, action, kind):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    hold(misty,binder,iono,5)
    requested=sent(ash,misty,[(iono,1)])
    accepted_loan=ok(accept(misty,loan_view(misty,sent(ash,misty,[(iono,1)])),[(iono,1)]))
    handed=ok(accept(misty,loan_view(misty,sent(ash,misty,[(iono,1)])),[(iono,1)]))
    ok(handover(misty,handed))
    offered=proposed(misty,ash,give=[(iono,1)])
    agreed=ok(accept_trade(ash,proposed(misty,ash,give=[(iono,1)],get=[(arven,1)])))
    half=ok(accept_trade(ash,proposed(misty,ash,give=[(iono,1)])))
    ok(confirm(ash,half))
    owner, report_id=(as_owner(),filed(ash,misty)) if action=='suspend' else (None,None)
    touched=[]
    module=reports if action=='suspend' else friends
    real=module.touch_threads
    def finish(conn,updates):
        # Every cancellable round is already closed and every event exists before the first thread lock.
        assert conn.execute("SELECT count(*) AS n FROM loan WHERE id=ANY(%s) AND state<>'closed'",
                            ([requested['id'],accepted_loan['id']],)).fetchone()['n']==0
        assert conn.execute("SELECT count(*) AS n FROM trade WHERE id=ANY(%s) AND state<>'closed'",
                            ([offered['id'],agreed['id']],)).fetchone()['n']==0
        found=conn.execute('SELECT kind,round_id FROM thread_event WHERE round_id=ANY(%s) AND kind=%s',
                           ([requested['id'],accepted_loan['id'],offered['id'],agreed['id']],kind)).fetchall()
        assert len(found)==4
        result=real(conn,updates)
        touched.append(set(result))
        return result
    monkeypatch.setattr(module,'touch_threads',finish)
    if action=='unfriend': ok(remove(ash,misty))
    elif action=='block': ok(call('POST','/api/social/blocks',ash,{'collector_id':misty,'idempotency_key':str(uuid4())}))
    elif action=='report': ok(report(ash, trader_of(misty)),201)
    else: ok(decide(owner,report_id,'suspend'))
    assert len(touched)==1
    assert touched[0]=={UUID(item['thread_id']) for item in (requested,accepted_loan,handed,offered,agreed,half)}
    with connect() as conn:
        for item in (requested,accepted_loan,offered,agreed):
            events=conn.execute('SELECT kind,actor,data FROM thread_event WHERE round_id=%s AND kind LIKE %s',
                                (item['id'],'closed_%')).fetchall()
            assert len(events)==1 and events[0]['kind']==kind and events[0]['data']=={}
            actor=misty if action=='suspend' else ash
            assert events[0]['actor']==('low' if actor==min(ash,misty) else 'high')
        for item in (handed,half):
            assert conn.execute("SELECT count(*) AS n FROM thread_event WHERE round_id=%s AND kind LIKE 'closed_%%'",
                                (item['id'],)).fetchone()['n']==0
    assert loan_view(ash,handed)['state']=='accepted'
    assert ok(read(ash,half))['state']=='accepted'


@pytest.mark.parametrize('block_first',[True,False])
def test_block_and_counter_serialize_without_deadlock(store, block_first):
    ids,ash,misty,binder,box=trading()
    offered=proposed(misty,ash,give=[(ids['PAL 185'],1)],get=[(ids['SVI 166'],1)])
    # Both callers take the same pair of owners in ascending order. A barrier starts them together.
    barrier=Barrier(2)
    def blocking():
        barrier.wait(timeout=10)
        return call('POST','/api/social/blocks',misty,{'collector_id':ash,'idempotency_key':str(uuid4())})
    def changing():
        barrier.wait(timeout=10)
        return counter(ash,offered,give=[(ids['SVI 166'],1)],get=[(ids['PAL 185'],1)])
    with ThreadPoolExecutor(max_workers=2) as pool:
        first=pool.submit(blocking if block_first else changing)
        second=pool.submit(changing if block_first else blocking)
        a,b=first.result(timeout=30),second.result(timeout=30)
    blocked,changed=(a,b) if block_first else (b,a)
    assert blocked.status_code==200,blocked.text
    assert changed.status_code==200 or detail(changed)==(409,{'code':'OFFER_CHANGED'})
    with connect() as conn:
        rows=conn.execute('SELECT id,state FROM trade WHERE thread_id=%s',(offered['thread_id'],)).fetchall()
        assert rows and all(row['state']=='closed' for row in rows)
        assert conn.execute("SELECT count(*) AS n FROM thread_event WHERE thread_id=%s AND kind='closed_blocked'",
                            (offered['thread_id'],)).fetchone()['n']==1


def test_account_deletion_keeps_loan_trade_threads_and_messages_readable(store):
    from test_threads import message, timeline
    ids,ash,misty,binder,box=trading()
    loan=sent(ash,misty,[(ids['PAL 185'],1)])
    trade=proposed(misty,ash,give=[(ids['PAL 185'],1)])
    sent_messages={}
    for item,kind in ((loan,'loans'),(trade,'trades')):
        sent_messages[kind]=ok(message(ash,item['thread_id'],'Kept after deletion',kind=kind),201)['id']
    with connect() as conn:
        conn.execute('DELETE FROM inventory_owner WHERE user_id=%s',(ash,))
    for item,kind,field in ((loan,'loans','live_terms'),(trade,'trades','live_offer')):
        detail_=ok(call('GET',f"/api/{kind}/{item['thread_id']}",misty))
        assert detail_[field]['id']==item['id']
        assert detail_['can_message'] is False and detail_['can_report'] is False
        messages=[r['message'] for r in timeline(misty,item['thread_id'],kind=kind)['items'] if r['kind']=='message']
        assert [r['id'] for r in messages]==[sent_messages[kind]]
        assert messages[0]['from']=='them' and messages[0]['body']=='Kept after deletion'
        with connect() as conn:
            row=conn.execute('SELECT user_low,user_high FROM thread WHERE id=%s',(item['thread_id'],)).fetchone()
            assert {row['user_low'],row['user_high']}=={misty,None}
            assert conn.execute('SELECT member_id FROM thread_member WHERE thread_id=%s',
                                (item['thread_id'],)).fetchall()==[{'member_id':misty}]


def test_suspension_batches_all_loan_and_trade_partners_before_touching(store,monkeypatch):
    from test_friend_copies import befriend, collector
    ids,ash,misty,binder,box=trading()
    brock,_=collector('Brock')
    gary,_=collector('Gary')
    befriend(misty,brock)
    befriend(misty,gary)
    loans=[sent(other,misty,[(ids['PAL 185'],1)]) for other in (ash,brock,gary)]
    trades=[proposed(misty,other,give=[(ids['PAL 185'],1)]) for other in (ash,brock)]
    owner,report_id=as_owner(),filed(ash,misty)
    calls=[]
    real_loans,real_trades,real_touch=reports.end_loans_between,reports.end_trades_between,reports.touch_threads
    def close_loans(conn,actor,others,kind):
        calls.append(('loans',actor,others,kind))
        return real_loans(conn,actor,others,kind)
    def close_trades(conn,actor,others,kind):
        calls.append(('trades',actor,others,kind))
        return real_trades(conn,actor,others,kind)
    def touch(conn,updates):
        calls.append(('threads',))
        return real_touch(conn,updates)
    monkeypatch.setattr(reports,'end_loans_between',close_loans)
    monkeypatch.setattr(reports,'end_trades_between',close_trades)
    monkeypatch.setattr(reports,'touch_threads',touch)
    ok(decide(owner,report_id,'suspend'))
    assert calls==[('loans',misty,sorted((ash,brock,gary)),'closed_suspended'),
                   ('trades',misty,sorted((ash,brock,gary)),'closed_suspended'),('threads',)]
    with connect() as conn:
        for item in loans+trades:
            assert conn.execute("SELECT count(*) AS n FROM thread_event WHERE thread_id=%s AND kind='closed_suspended'",
                                (item['thread_id'],)).fetchone()['n']==1


@pytest.mark.parametrize('kind',['request','offer'])
@pytest.mark.parametrize('first',['creation','suspension'])
def test_incoming_loan_creation_serializes_with_suspension(store,monkeypatch,kind,first):
    import os
    from threading import Event
    import psycopg
    from app import loan_inventory
    from test_loan_promises import _waiting_on_a_row
    from test_lend_offers import offer
    from test_loans import send
    from test_trade_promises import reserved
    ids,ash,misty,binder,box=trading()
    owner,report_id=as_owner(),filed(ash,misty)
    paused,release=Event(),Event()
    if first=='creation':
        real=loan_inventory.new_loan_thread
        def boundary(*args,**kwargs):
            paused.set()
            assert release.wait(timeout=10)
            return real(*args,**kwargs)
        monkeypatch.setattr(loan_inventory,'new_loan_thread',boundary)
    else:
        real=reports._suspend
        def boundary(*args,**kwargs):
            # The second partner read has completed, and the suspended owner is locked.
            paused.set()
            assert release.wait(timeout=10)
            return real(*args,**kwargs)
        monkeypatch.setattr(reports,'_suspend',boundary)
    def creation():
        return send(ash,misty,[(ids['PAL 185'],1)]) if kind=='request' else offer(
            ash,misty,[(box,ids['SVI 166'],1)])
    def suspension():
        return decide(owner,report_id,'suspend')
    operations={'creation':creation,'suspension':suspension}
    second='suspension' if first=='creation' else 'creation'
    with ThreadPoolExecutor(max_workers=2) as pool, psycopg.connect(os.environ['DATABASE_URL'],autocommit=True) as watch:
        a=pool.submit(operations[first])
        try:
            assert paused.wait(timeout=10)
            b=pool.submit(operations[second])
            _waiting_on_a_row(watch,[a,b])
        finally:
            release.set()
        responses={first:a.result(timeout=30),second:b.result(timeout=30)}
    assert responses['suspension'].status_code==200,responses['suspension'].text
    created=responses['creation']
    if first=='suspension':
        assert detail(created)==(409,{'code':'COLLECTOR_UNAVAILABLE'})
    else:
        assert created.status_code==201,created.text
        item=created.json()
        with connect() as conn:
            assert conn.execute('SELECT state,closed_by FROM loan WHERE id=%s',(item['id'],)).fetchone()=={
                'state':'closed','closed_by':misty}
            events=conn.execute('SELECT kind FROM thread_event WHERE thread_id=%s AND kind LIKE %s',
                                (item['thread_id'],'closed_%')).fetchall()
            assert events==[{'kind':'closed_suspended'}]
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM loan WHERE state<>'closed' AND (lender_id=%s OR borrower_id=%s)",
                            (misty,misty)).fetchone()['n']==0
        assert conn.execute('SELECT count(*) AS n FROM loan_pick WHERE owner_id=ANY(%s)',([ash,misty],)).fetchone()['n']==0
    assert reserved(ash,ids['SVI 166'])==(0,0) and reserved(misty,ids['PAL 185'])==(0,0)


@pytest.mark.slow(reason='capacity: 200 Trade rounds and 50 Loan rounds exercise batched closure prerequisites')
def test_bulk_closure_prerequisite_selects_are_bounded_at_250_rounds(store):
    from app.social.loans import end_loans_between
    from app.social.trades import end_trades_between
    from app.social.threads import touch_threads
    from app.social.owners import lock_owners
    from test_threads import thread
    from test_trade_promises import reserved
    ids,ash,misty,binder,box=trading()
    iono=ids['PAL 185']
    hold(misty,binder,iono,300)
    with connect() as conn,conn.transaction():
        lock_owners(conn,ash,misty)
        for _ in range(200):
            _,rid=thread(misty,ash,conn=conn)
            conn.execute("INSERT INTO trade_line(trade_id,side,edition_id,position,quantity) VALUES (%s,'proposer',%s,0,1)",(rid,iono))
        for _ in range(50):
            _,rid=thread(misty,ash,kind='loan',conn=conn)
            conn.execute("UPDATE loan SET kind='lend_offer',state='offered' WHERE id=%s",(rid,))
            conn.execute('INSERT INTO loan_line(loan_id,edition_id,position,requested,promised) VALUES (%s,%s,0,1,1)',(rid,iono))
    assert reserved(misty,iono)==(250,200)
    class CountSelects:
        def __init__(self,conn):
            self.conn=conn
            self.selects=[]
        def execute(self,query,params=None):
            if isinstance(query,str) and query.lstrip().upper().startswith('SELECT'):
                self.selects.append(query)
            return self.conn.execute(query,params)
    with connect() as conn,conn.transaction():
        lock_owners(conn,ash,misty)
        counted=CountSelects(conn)
        touched=set(end_loans_between(counted,misty,[ash],'closed_suspended'))
        touched.update(end_trades_between(counted,misty,[ash],'closed_suspended'))
        assert len(touched)==250
        # This excludes the intentional per-thread locking in the one final touch pass.
        assert len(counted.selects)<=6,counted.selects
        assert set(touch_threads(conn,list(touched)))==touched
    assert reserved(misty,iono)==(0,0)
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM thread_event WHERE thread_id=ANY(%s) AND kind='closed_suspended'",
                            (list(touched),)).fetchone()['n']==250
