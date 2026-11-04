"""Stopped-application thread cutover: real migration transactions and deletion effects.

Manual SQL rehearsal, 2026-10-31: 2,000 pairs, 10,000 closed Trade rounds
(one line each), 50,000 messages; migration plus commit took 7.930 seconds on
this shared host after ANALYZE. All 2,000 threads, 10,000 mappings and 50,000
copied messages were verified. This is a timing observation, not a test budget.

Long-chain SQL rehearsal, 2026-10-31: one pair, 4,000 closed Trade rounds
(one line each), no messages, and no externally supplied ANALYZE. Traversal
took 11.014 ms with trade_counter_chain index scans (4,000 recursive loops,
no full Trade scans); the full migration plus commit took 1.060 seconds.
One thread and all 4,000 mappings were verified. Fixture writes were committed
before migration DDL to drain deferred triggers, as apply() does below.
"""
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from test_catalog_references import migrate
from test_trade_migrations import collector, edition, scratch  # noqa: F401

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = '162_trade_loan_threads.sql'


def apply(conn):
    # Drain the fixture's deferred promise triggers before migration DDL. The
    # rollback tests that execute migration SQL directly also commit seeds first.
    conn.commit()
    conn.execute((ROOT / 'migrations' / MIGRATION).read_text())


@pytest.fixture
def old(scratch):
    migrate(scratch, before=MIGRATION)
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        yield conn


def pair(conn, a='A', b='z'):
    for owner in (a, b):
        collector(conn, owner)
    return conn.execute("SELECT pair_conversation(%s,%s,'Ash','Misty') AS id", (a, b)).fetchone()['id']


def trade(conn, a='A', b='z', previous=None, at='2020-01-02', closed=None):
    return conn.execute("""INSERT INTO trade(id,state,closed_reason,proposer_id,recipient_id,proposer_name,
      recipient_name,countered_from,created_at,closed_at)
      VALUES (%s,%s,%s,%s,%s,'Ash','Misty',%s,%s,%s) RETURNING id""",
                        (uuid4(), 'closed' if closed else 'proposed', 'countered' if closed else None,
                         a, b, previous, at, closed)).fetchone()['id']


def loan(conn, a='A', b='z', at='2020-01-03', kind='borrow_request'):
    return conn.execute("""INSERT INTO loan(id,kind,state,lender_id,borrower_id,lender_name,borrower_name,created_at)
      VALUES (%s,%s,%s,%s,%s,'Ash','Misty',%s) RETURNING id""",
                        (uuid4(), kind, 'requested' if kind == 'borrow_request' else 'offered', a, b, at)).fetchone()['id']


def message(conn, conversation, at, low=True):
    mid = uuid4()
    conn.execute("INSERT INTO message VALUES (%s,%s,%s,%s,'Hello',%s)",
                 (mid, conversation, low, uuid4(), at))
    return mid


def mapped(conn, kind, rid):
    return conn.execute('SELECT thread_id FROM thread_round_source WHERE kind=%s AND round_id=%s',
                        (kind, rid)).fetchone()['thread_id']


def test_first_owner_delete_is_visible_inside_immediate_set_null_guard(old):
    """Prove the owner-gone rule with actual RI cascades, not a simulated NULL write."""
    c = old
    conv = pair(c)
    tr = trade(c)
    lo = loan(c)
    c.execute("UPDATE loan SET state='handed_over',lender_handover_at=now(),borrower_handover_at=now() WHERE id=%s", (lo,))
    mid = message(c, conv, '2020-01-04')
    pair(c, 'legacy-a', 'legacy-b')
    collector(c, 'archive-only')
    c.execute("SELECT pair_conversation('A','archive-only','Ash','Other')")
    apply(c)
    c.commit()
    tid = mapped(c, 'trade', tr)
    c.execute("DELETE FROM inventory_owner WHERE user_id='A'")
    c.commit()
    for table, key, rid, col in [('trade', 'id', tr, 'proposer_id'), ('loan', 'id', lo, 'lender_id'),
                                 ('thread', 'id', tid, 'user_low'), ('conversation', 'id', conv, 'user_low')]:
        assert c.execute(f'SELECT {col} FROM {table} WHERE {key}=%s', (rid,)).fetchone()[col] is None
    assert c.execute("SELECT count(*) AS n FROM thread_member WHERE member_id='A'").fetchone()['n'] == 0
    assert c.execute("SELECT count(*) AS n FROM conversation_member WHERE member_id='A'").fetchone()['n'] == 0
    assert c.execute('SELECT body FROM thread_message WHERE id=%s', (mid,)).fetchone()['body'] == 'Hello'
    assert c.execute("SELECT count(*) AS n FROM legacy_contact WHERE user_low='A' OR user_high='A'").fetchone()['n'] == 0
    c.execute("DELETE FROM inventory_owner WHERE user_id='legacy-a'")
    assert c.execute('SELECT count(*) AS n FROM legacy_contact').fetchone()['n'] == 0


def test_linear_chains_source_coverage_and_rerun(old):
    pair(old)
    root = trade(old, closed='2020-01-03')
    tip = trade(old, 'z', 'A', root, '2020-01-03')
    lo = loan(old)
    apply(old)
    old.commit()
    assert mapped(old, 'trade', root) == mapped(old, 'trade', tip)
    assert mapped(old, 'loan', lo) != mapped(old, 'trade', root)
    assert mapped(old, 'trade', root) not in (root, tip, lo)
    tables = ('thread', 'thread_round_source', 'thread_member', 'thread_event', 'thread_message', 'legacy_contact')
    before = {t: old.execute(f'SELECT * FROM {t} ORDER BY 1,2').fetchall() for t in tables}
    apply(old)
    old.commit()
    assert before == {t: old.execute(f'SELECT * FROM {t} ORDER BY 1,2').fetchall() for t in tables}


@pytest.mark.parametrize('column,table', [('proposer_id', 'trade'), ('lender_id', 'loan'), ('user_low', 'thread')])
def test_participant_cannot_be_nulled_or_replaced_while_owner_exists(old, column, table):
    pair(old)
    trade(old)
    loan(old)
    collector(old, 'third')
    apply(old)
    old.commit()
    for value in (None, 'third'):
        with pytest.raises(psycopg.errors.RaiseException, match='participant_immutable'), old.transaction():
            old.execute(f'UPDATE {table} SET {column}=%s', (value,))


@pytest.mark.parametrize('table,column,value', [('trade', 'thread_id', None), ('trade', 'thread_kind', 'loan'),
                                               ('loan', 'thread_id', None), ('loan', 'thread_kind', 'trade'),
                                               ('thread', 'kind', 'loan'), ('thread', 'id', None)])
def test_thread_identity_is_immutable(old, table, column, value):
    pair(old)
    trade(old)
    loan(old)
    apply(old)
    old.commit()
    with pytest.raises(psycopg.errors.RaiseException, match='round_thread_immutable'), old.transaction():
        old.execute(f'UPDATE {table} SET {column}=%s', (value,))


def test_round_kind_pair_and_one_live_backstops(old):
    pair(old)
    tr = trade(old)
    lo = loan(old)
    collector(old, 'third')
    apply(old)
    old.commit()
    template = """INSERT INTO trade(id,state,closed_reason,proposer_id,recipient_id,proposer_name,recipient_name,thread_id)
      VALUES (%s,'closed','cancelled','A',%s,'Ash','Other',%s)"""
    with pytest.raises(psycopg.errors.ForeignKeyViolation), old.transaction():
        old.execute(template, (uuid4(), 'z', mapped(old, 'loan', lo)))
    with pytest.raises(psycopg.errors.RaiseException, match='round_in_thread_pair'), old.transaction():
        old.execute(template, (uuid4(), 'third', mapped(old, 'trade', tr)))
        old.execute('SET CONSTRAINTS ALL IMMEDIATE')
    with pytest.raises(psycopg.errors.UniqueViolation), old.transaction():
        old.execute(template.replace("'closed','cancelled'", "'proposed',NULL"),
                    (uuid4(), 'z', mapped(old, 'trade', tr)))


@pytest.mark.parametrize('table', ['conversation', 'conversation_member', 'message'])
@pytest.mark.parametrize('operation', ['insert', 'update', 'delete'])
def test_archive_refuses_direct_writes(old, table, operation):
    conv = pair(old)
    message(old, conv, '2020-01-01')
    apply(old)
    old.commit()
    statements = {
        ('conversation', 'insert'): "INSERT INTO conversation SELECT * FROM conversation",
        ('conversation', 'update'): "UPDATE conversation SET low_name='Renamed'",
        ('conversation', 'delete'): 'DELETE FROM conversation',
        ('conversation_member', 'insert'): 'INSERT INTO conversation_member SELECT * FROM conversation_member',
        ('conversation_member', 'update'): 'UPDATE conversation_member SET read_at=now()',
        ('conversation_member', 'delete'): 'DELETE FROM conversation_member',
        ('message', 'insert'): 'INSERT INTO message SELECT * FROM message',
        ('message', 'update'): "UPDATE message SET body='Changed'",
        ('message', 'delete'): 'DELETE FROM message',
    }
    with pytest.raises(psycopg.errors.RaiseException, match='conversation_archived'), old.transaction():
        old.execute(statements[table, operation])


def test_legacy_contacts_with_and_without_messages_and_reach_parity(old):
    conv = pair(old)
    message(old, conv, '2020-01-01')
    pair(old, 'B', 'y')
    pair(old, 'C', 'x')
    trade(old, 'C', 'x')
    before = old.execute("SELECT * FROM trade_reach('A',ARRAY['z'])").fetchall()
    apply(old)
    assert old.execute('SELECT user_low,user_high FROM legacy_contact ORDER BY 1').fetchall() == [
        {'user_low': 'A', 'user_high': 'z'}, {'user_low': 'B', 'user_high': 'y'}]
    assert old.execute("SELECT * FROM trade_reach('A',ARRAY['z'])").fetchall() == before
    assert old.execute('SELECT count(*) AS n FROM thread_message').fetchone()['n'] == 0


def test_forced_reach_mismatch_rolls_back_entire_batch(old):
    pair(old)
    old.commit()
    source = (ROOT / 'migrations' / MIGRATION).read_text()
    # Fault injection only: omit legacy contact insertion to prove the parity backstop.
    source = source.replace('SELECT c.user_low,c.user_high FROM conversation c WHERE',
                            'SELECT c.user_low,c.user_high FROM conversation c WHERE false AND')
    with pytest.raises(psycopg.errors.RaiseException, match='thread_reach_changed'), old.transaction():
        old.execute(source)
    assert old.execute("SELECT to_regclass('thread') AS name").fetchone()['name'] is None


def test_m1_before_between_after_and_overlapping_kinds(old):
    conv = pair(old)
    first = trade(old, at='2020-01-02', closed='2020-01-03')
    second = loan(old, at='2020-01-05')
    third = trade(old, at='2020-01-06')
    messages = [(message(old, conv, at), expected) for at, expected in [
        ('2020-01-01', first), ('2020-01-03', first), ('2020-01-04', first),
        ('2020-01-05', second), ('2020-01-06', third), ('2020-01-09', third)]]
    apply(old)
    for mid, expected in messages:
        kind = 'loan' if expected == second else 'trade'
        assert old.execute('SELECT thread_id FROM thread_message WHERE id=%s', (mid,)).fetchone()['thread_id'] \
            == mapped(old, kind, expected)


def test_m1_kind_and_thread_id_ties(old):
    conv = pair(old)
    a = trade(old, at='2020-01-02')
    b = trade(old, at='2020-01-02')
    loan(old, at='2020-01-02')
    mid = message(old, conv, '2020-01-03')
    apply(old)
    assert old.execute('SELECT thread_id FROM thread_message WHERE id=%s', (mid,)).fetchone()['thread_id'] \
        == min(mapped(old, 'trade', a), mapped(old, 'trade', b))


def test_closed_tip_null_time_fallback_and_deleted_sender_slot(old):
    conv = pair(old)
    tr = trade(old, at='2020-01-02', closed='2020-01-03')
    old.execute('UPDATE trade SET closed_at=NULL WHERE id=%s', (tr,))
    mid = message(old, conv, '2020-01-04', low=False)
    old.execute("DELETE FROM inventory_owner WHERE user_id='A'")
    notices = []
    old.add_notice_handler(lambda d: notices.append(d.message_primary))
    apply(old)
    assert any('NULL closed_at' in n for n in notices)
    row = old.execute('SELECT t.user_low,t.user_high,m.from_low FROM thread_message m JOIN thread t ON t.id=m.thread_id '
                      'WHERE m.id=%s', (mid,)).fetchone()
    assert row == {'user_low': None, 'user_high': 'z', 'from_low': False}


def test_slot_diffs_follow_proposer_flip(old):
    pair(old)
    card = edition(old)
    first = trade(old, closed='2020-01-03')
    second = trade(old, 'z', 'A', first, '2020-01-03')
    for rid, side, qty in [(first, 'proposer', 2), (second, 'recipient', 1)]:
        old.execute('INSERT INTO trade_line VALUES (%s,%s,%s,0,%s)', (rid, side, card, qty))
    # Avoid promising without Holdings in this migration-only fixture.
    old.execute("UPDATE trade SET state='closed',closed_reason='cancelled',closed_at='2020-01-04' WHERE id=%s", (second,))
    apply(old)
    event = old.execute("SELECT data FROM thread_event WHERE round_id=%s AND kind='countered'", (second,)).fetchone()
    assert event['data']['lines'] == [{'giver': 'low', 'edition_id': str(card), 'from_qty': 2, 'to_qty': 1}]


def test_deck_location_deletion_borrowed_rows_and_existing_writers(old):
    """All nonidentity columns and child writers stay outside the remaining guards."""
    pair(old)
    card = edition(old)
    lo = loan(old)
    tr = trade(old, closed='2020-01-04')
    deck = uuid4()
    source = uuid4()
    old.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,'z','Deck','deck'),(%s,'A','Pick source','storage_leaf')",
                (deck, source))
    old.execute("UPDATE loan SET state='handed_over',deck_id=%s,lender_handover_at=now(),borrower_handover_at=now() WHERE id=%s",
                (deck, lo))
    old.execute('INSERT INTO loan_line VALUES (%s,%s,0,2,2,0)', (lo, card))
    old.execute('INSERT INTO trade_line VALUES (%s,\'proposer\',%s,0,1)', (tr, card))
    old.execute("INSERT INTO loan_pick(loan_id,owner_id,edition_id,source_location_id,quantity,state) VALUES (%s,'A',%s,%s,2,'lent')",
                (lo, card, source))
    old.execute("INSERT INTO trade_pick(trade_id,side,owner_id,edition_id,source_location_id,quantity) VALUES (%s,'proposer','A',%s,%s,1)",
                (tr, card, source))
    old.execute("INSERT INTO borrowed_holding(loan_id,borrower_id,location_id,edition_id,quantity) VALUES (%s,'z',%s,%s,2)",
                (lo, deck, card))
    old.execute("INSERT INTO loan_notice_seen(loan_id,user_id,kind) VALUES (%s,'A','overdue')", (lo,))
    borrowed = old.execute('SELECT * FROM borrowed_holding').fetchall()
    fk = old.execute("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='borrowed_holding'::regclass ORDER BY oid").fetchall()
    apply(old)
    old.commit()
    assert old.execute('SELECT * FROM borrowed_holding').fetchall() == borrowed
    assert old.execute("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='borrowed_holding'::regclass ORDER BY oid").fetchall() == fk
    threads = old.execute('SELECT * FROM thread ORDER BY id').fetchall()
    old.execute('DELETE FROM location WHERE id=%s', (source,))
    for table in ('loan_pick', 'trade_pick'):
        assert old.execute(f'SELECT source_location_id FROM {table}').fetchone()['source_location_id'] is None
    # Deck deletion moves Borrowed Copies before deleting its Location, as the API does.
    unsorted = uuid4()
    old.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,'z','Unsorted','storage_leaf')", (unsorted,))
    old.execute('UPDATE borrowed_holding SET location_id=%s WHERE loan_id=%s', (unsorted, lo))
    old.execute('DELETE FROM location WHERE id=%s', (deck,))
    assert old.execute('SELECT deck_id FROM loan WHERE id=%s', (lo,)).fetchone()['deck_id'] is None
    # Name-follow triggers, step writers, return rows, write-off, and pick moves
    # deliberately update columns outside thread_immutable's UPDATE OF list.
    old.execute("UPDATE collector_profile SET display_name='Renamed' WHERE user_id='A'")
    old.execute("UPDATE trade SET revision=revision+1,accepted_at=now(),proposer_swap_at=now() WHERE id=%s", (tr,))
    from app.social.loans import write_loan
    from app.social.trades import write_trade
    from datetime import date
    write_loan(old, lo, {'return_by': date.today(), 'extension_to': date.today()})
    write_trade(old, tr, {})
    ret = uuid4()
    old.execute("INSERT INTO loan_return(id,loan_id,started_by,lender_confirmed_at) VALUES (%s,%s,'lender',now())", (ret, lo))
    old.execute('INSERT INTO loan_return_line VALUES (%s,%s,%s,1)', (ret, lo, card))
    old.execute('UPDATE loan_return SET borrower_confirmed_at=now(),completed_at=now() WHERE id=%s', (ret,))
    old.execute('UPDATE loan_line SET written_off=1 WHERE loan_id=%s', (lo,))
    # Exercise the previously under-described edition-reassignment writer itself.
    from app.loan_inventory import _move_lines
    replacement = edition(old)
    _move_lines(old, lo, card, replacement)
    assert old.execute('SELECT edition_id FROM borrowed_holding').fetchone()['edition_id'] == replacement
    assert old.execute('SELECT edition_id FROM loan_return_line').fetchone()['edition_id'] == replacement
    assert old.execute('SELECT * FROM thread ORDER BY id').fetchall() == threads
    old.execute("DELETE FROM inventory_owner WHERE user_id='A'")
    old.commit()
    assert old.execute('SELECT count(*) AS n FROM loan_pick').fetchone()['n'] == 0
    assert old.execute('SELECT count(*) AS n FROM trade_pick').fetchone()['n'] == 0
    assert old.execute('SELECT count(*) AS n FROM loan_notice_seen').fetchone()['n'] == 0
    assert old.execute('SELECT count(*) AS n FROM borrowed_holding').fetchone()['n'] == 1


def test_non_linear_or_cyclic_chains_roll_back(old):
    pair(old)
    root = trade(old, closed='2020-01-03')
    trade(old, previous=root)
    trade(old, previous=root)
    old.commit()
    with pytest.raises(psycopg.errors.RaiseException, match='nonlinear_counter_chain'), old.transaction():
        old.execute((ROOT / 'migrations' / MIGRATION).read_text())
    assert old.execute("SELECT to_regclass('thread') AS name").fetchone()['name'] is None


@pytest.mark.parametrize('at', ['2020-01-01', '2020-01-10'])
def test_m1_future_and_closed_span_ties(old, at):
    conv = pair(old)
    a = trade(old, at='2020-01-02', closed='2020-01-04')
    b = trade(old, at='2020-01-02', closed='2020-01-04')
    lo = loan(old, at='2020-01-02')
    old.execute("UPDATE loan SET state='closed',closed_reason='cancelled',closed_at='2020-01-04' WHERE id=%s", (lo,))
    mid = message(old, conv, at)
    apply(old)
    assert old.execute('SELECT thread_id FROM thread_message WHERE id=%s', (mid,)).fetchone()['thread_id'] \
        == min(mapped(old, 'trade', a), mapped(old, 'trade', b))


def test_deleted_pairs_do_not_mix_archives_or_read_markers(old):
    first = pair(old)
    one = trade(old)
    collector(old, 'B')
    second = old.execute("SELECT pair_conversation('B','z','B','Misty') AS id").fetchone()['id']
    two = trade(old, 'B', 'z')
    m1 = message(old, first, '2020-01-04')
    m2 = message(old, second, '2020-01-04')
    old.execute("UPDATE conversation_member SET read_at='2020-01-02' WHERE conversation_id=%s", (first,))
    old.execute("UPDATE conversation_member SET read_at='2020-01-03' WHERE conversation_id=%s", (second,))
    old.execute("DELETE FROM inventory_owner WHERE user_id IN ('A','B')")
    apply(old)
    for mid, rid, day in [(m1, one, 2), (m2, two, 3)]:
        tid = mapped(old, 'trade', rid)
        assert old.execute('SELECT thread_id FROM thread_message WHERE id=%s', (mid,)).fetchone()['thread_id'] == tid
        assert old.execute('SELECT read_at FROM thread_member WHERE thread_id=%s', (tid,)).fetchone()['read_at'].day == day


def test_deferred_pair_check_reads_post_cascade_row(old):
    pair(old)
    original = trade(old)
    apply(old)
    old.commit()
    tid = mapped(old, 'trade', original)
    old.execute("""INSERT INTO trade(id,state,closed_reason,proposer_id,recipient_id,proposer_name,recipient_name,thread_id)
      VALUES (%s,'closed','cancelled','A','z','Ash','Misty',%s)""", (uuid4(), tid))
    old.execute("DELETE FROM inventory_owner WHERE user_id='A'")
    old.commit()


def test_no_rounds_leave_inventory_and_shared_promise_definitions_unchanged(old):
    binder = collector(old, 'owner')
    card = edition(old)
    old.execute('INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,3,1)',
                ('owner', binder, card))
    definitions = old.execute("""SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc
      WHERE proname IN ('reserved_copies','reserving_picks','trade_listable','check_loan_promises') ORDER BY proname""").fetchall()
    before = {name: old.execute(f'SELECT * FROM {name}(ARRAY[\'owner\'],NULL::uuid[])').fetchall()
              for name in ('reserved_copies', 'reserving_picks', 'trade_listable')}
    holdings = old.execute('SELECT * FROM holding').fetchall()
    apply(old)
    assert old.execute('SELECT * FROM holding').fetchall() == holdings
    assert old.execute("""SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc
      WHERE proname IN ('reserved_copies','reserving_picks','trade_listable','check_loan_promises') ORDER BY proname""").fetchall() == definitions
    for name, rows in before.items():
        assert old.execute(f'SELECT * FROM {name}(ARRAY[\'owner\'],NULL::uuid[])').fetchall() == rows


def test_m1_closed_null_tip_uses_fallback_instead_of_an_open_span(old):
    conv = pair(old)
    later_close = trade(old, at='2020-01-01', closed='2020-01-03')
    missing_close = trade(old, at='2020-01-02', closed='2020-01-03')
    old.execute('UPDATE trade SET closed_at=NULL WHERE id=%s', (missing_close,))
    mid = message(old, conv, '2020-01-04')
    apply(old)
    assert old.execute('SELECT thread_id FROM thread_message WHERE id=%s', (mid,)).fetchone()['thread_id'] \
        == mapped(old, 'trade', later_close)


def test_cycle_without_a_root_rolls_back(old):
    pair(old)
    first = trade(old, closed='2020-01-03')
    second = trade(old, previous=first, closed='2020-01-04')
    old.execute('UPDATE trade SET countered_from=%s WHERE id=%s', (second, first))
    old.commit()
    with pytest.raises(psycopg.errors.RaiseException, match='cycle'), old.transaction():
        old.execute((ROOT / 'migrations' / MIGRATION).read_text())
    assert old.execute("SELECT to_regclass('thread') AS name").fetchone()['name'] is None


def test_closed_loan_only_pair_gains_logged_thread_reach(old):
    collector(old, 'A')
    collector(old, 'z')
    rid = loan(old)
    old.execute("UPDATE loan SET state='closed',closed_reason='cancelled',closed_at='2020-01-04' WHERE id=%s", (rid,))
    assert old.execute("SELECT * FROM trade_reach('A',ARRAY['z'])").fetchall() == []
    notices = []
    old.add_notice_handler(lambda d: notices.append(d.message_primary))
    apply(old)
    old.commit()
    assert old.execute("SELECT how FROM trade_reach('A',ARRAY['z'])").fetchone()['how'] == 'conversation'
    assert any('2 directed answers (1 pairs)' in n for n in notices)


def test_gain_without_shared_thread_rolls_back(old):
    pair(old)
    # Fault injection: the historical function loses a Conversation's reach,
    # so recreating it via legacy_contact would be an unauthorized gain.
    old.execute("""CREATE OR REPLACE FUNCTION trade_reach(viewer text,others text[])
      RETURNS TABLE(other_id text,how text,band smallint) LANGUAGE sql STABLE AS
      $$ SELECT NULL::text,NULL::text,NULL::smallint WHERE false $$""")
    old.commit()
    with pytest.raises(psycopg.errors.RaiseException, match='thread_reach_changed'), old.transaction():
        old.execute((ROOT / 'migrations' / MIGRATION).read_text())
    assert old.execute("SELECT to_regclass('thread') AS name").fetchone()['name'] is None


@pytest.mark.parametrize('kind,actor', [('borrow_request', 'low'), ('lend_offer', 'high')])
def test_loan_acceptance_actor_follows_kind(old, kind, actor):
    pair(old)
    rid = loan(old, kind=kind)
    old.execute("UPDATE loan SET state='closed',closed_reason='cancelled',accepted_at='2020-01-04',closed_at='2020-01-05' WHERE id=%s", (rid,))
    apply(old)
    assert old.execute("SELECT actor FROM thread_event WHERE round_id=%s AND kind='accepted'", (rid,)).fetchone()['actor'] == actor


def test_lend_offer_opening_keeps_four_then_records_two_not_lent(old):
    pair(old)
    card = edition(old)
    rid = loan(old, kind='lend_offer')
    old.execute("UPDATE loan SET state='closed',closed_reason='cancelled',accepted_at='2020-01-04',closed_at='2020-01-05' WHERE id=%s", (rid,))
    old.execute('INSERT INTO loan_line VALUES (%s,%s,0,4,2,0)', (rid, card))
    apply(old)
    opening = old.execute("SELECT data FROM thread_event WHERE round_id=%s AND kind='offered'", (rid,)).fetchone()['data']
    assert opening['lines'] == [{'giver': 'low', 'edition_id': str(card), 'from_qty': 0, 'to_qty': 4}]
    reduction = old.execute("SELECT actor,data FROM thread_event WHERE round_id=%s AND kind='partly_accepted'", (rid,)).fetchone()
    assert reduction == {'actor': 'high', 'data': {'not_lent': [{'edition_id': str(card), 'quantity': 2}]}}


def test_partial_then_final_return_has_one_terminal_event(old):
    pair(old)
    card = edition(old)
    rid = loan(old)
    old.execute("UPDATE loan SET state='closed',closed_reason='returned',closed_at='2020-01-10' WHERE id=%s", (rid,))
    old.execute('INSERT INTO loan_line VALUES (%s,%s,0,4,4,0)', (rid, card))
    returns = []
    for day in (5, 10):
        ret = uuid4()
        returns.append(ret)
        old.execute("""INSERT INTO loan_return(id,loan_id,started_by,lender_confirmed_at,borrower_confirmed_at,completed_at,created_at)
          VALUES (%s,%s,'lender',%s,%s,%s,%s)""", (ret, rid, *[f'2020-01-{day:02d}'] * 4))
        old.execute('INSERT INTO loan_return_line VALUES (%s,%s,%s,2)', (ret, rid, card))
    apply(old)
    terminal = old.execute("SELECT return_id,created_at FROM thread_event WHERE round_id=%s AND kind='returned'", (rid,)).fetchall()
    assert len(terminal) == 1
    assert terminal[0]['return_id'] is None and terminal[0]['created_at'].day == 10
    for ret in returns:
        assert old.execute("SELECT count(*) AS n FROM thread_event WHERE return_id=%s AND kind='return_confirmed'", (ret,)).fetchone()['n'] == 2


def test_proven_deleted_loan_archive_normalizes_sender_slots(old):
    conv = pair(old)
    witness = trade(old, closed='2020-01-04')
    old.execute("UPDATE trade SET closed_by='A' WHERE id=%s", (witness,))
    # Lender is the survivor: its own round column is low after the deletion,
    # whereas the archive kept the survivor in high.
    rid = loan(old, 'z', 'A')
    old.execute("UPDATE loan SET state='closed',closed_reason='cancelled',closed_by='A',closed_at='2020-01-06' WHERE id=%s", (rid,))
    mid = message(old, conv, '2020-01-05', low=False)
    old.execute("UPDATE conversation_member SET read_at='2020-01-02' WHERE conversation_id=%s", (conv,))
    old.execute("DELETE FROM inventory_owner WHERE user_id='A'")
    apply(old)
    tid = mapped(old, 'loan', rid)
    assert old.execute('SELECT user_low,user_high FROM thread WHERE id=%s', (tid,)).fetchone() == {'user_low': 'z', 'user_high': None}
    assert old.execute('SELECT thread_id,from_low FROM thread_message WHERE id=%s', (mid,)).fetchone() == {'thread_id': tid, 'from_low': True}
    assert old.execute('SELECT read_at FROM thread_member WHERE thread_id=%s', (tid,)).fetchone()['read_at'].day == 2


def test_ambiguous_deleted_loan_partners_stay_archive_only(old):
    first = pair(old)
    collector(old, 'B')
    second = old.execute("SELECT pair_conversation('B','z','B','Misty') AS id").fetchone()['id']
    loans = [loan(old, 'A', 'z'), loan(old, 'B', 'z')]
    for conv in (first, second):
        message(old, conv, '2020-01-05')
        old.execute("UPDATE conversation_member SET read_at='2019-01-01' WHERE conversation_id=%s", (conv,))
    old.execute("DELETE FROM inventory_owner WHERE user_id IN ('A','B')")
    notices = []
    old.add_notice_handler(lambda d: notices.append(d.message_primary))
    apply(old)
    assert old.execute('SELECT count(*) AS n FROM thread_message').fetchone()['n'] == 0
    assert old.execute('SELECT count(*) AS n FROM message').fetchone()['n'] == 2
    for rid in loans:
        row = old.execute('SELECT read_at FROM thread_member WHERE thread_id=%s', (mapped(old, 'loan', rid),)).fetchone()
        assert row['read_at'].year == 2020
    assert any('2 deleted-participant Loan rounds have no proven archive association' in n for n in notices)


def test_unique_deleted_loan_archive_without_identity_proof_is_not_guessed(old):
    conv = pair(old)
    rid = loan(old, 'z', 'A')
    message(old, conv, '2020-01-05', low=False)
    old.execute("UPDATE conversation_member SET read_at='2019-01-01' WHERE conversation_id=%s", (conv,))
    old.execute("DELETE FROM inventory_owner WHERE user_id='A'")
    apply(old)
    tid = mapped(old, 'loan', rid)
    assert old.execute('SELECT user_low,user_high FROM thread WHERE id=%s', (tid,)).fetchone() == {'user_low': 'z', 'user_high': None}
    assert old.execute('SELECT count(*) AS n FROM thread_message').fetchone()['n'] == 0
    assert old.execute('SELECT read_at FROM thread_member WHERE thread_id=%s', (tid,)).fetchone()['read_at'].year == 2020
