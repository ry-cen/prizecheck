"""Trading migrations 141 to 143 (Trading #268), each on its own disposable database.

Each runs again with nothing changed. Migration 142 redefines migration 106's ``reserved_copies`` and
``check_loan_promises``, so an older API build that is still serving while the migrations apply must keep working: its
Loan reads, the Loan placement read and the inbox join answer exactly what they answered before, and the invariant
still refuses under its old constraint name. The previous build's statements are copied below as they were before
#268, never imported, so a later change to the app can't make this test check itself.
"""
import os
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

from test_catalog_references import migrate

ROOT = Path(__file__).resolve().parents[2]
TRADING = ('141_trades.sql', '142_trade_promises.sql', '143_trade_wants.sql')

# The previous API build's statements, copied from api/app/social/counts.py, api/app/loan_picks.py and
# api/app/social/inbox.py as they were at commit c2371c2, with counts.RESERVING written out.
PREVIOUS_RESERVED_COUNTS = 'SELECT edition_id, reserved FROM reserved_copies(%s::text[], %s::uuid[])'
PREVIOUS_RESERVED_BY_OWNER = 'SELECT owner_id, edition_id, reserved FROM reserved_copies(%s::text[], %s::uuid[])'
PREVIOUS_RESERVED_PICKS = """SELECT p.edition_id, p.source_location_id, sum(p.quantity)::bigint AS copies
      FROM loan_pick p JOIN loan o ON o.id = p.loan_id
      WHERE p.owner_id = %s AND o.lender_id = %s AND p.edition_id = ANY(%s) AND p.state = 'reserved' AND o.state IN ('offered','accepted') AND o.lender_handover_at IS NULL
      GROUP BY p.edition_id, p.source_location_id"""
PREVIOUS_PICK_SHORTFALLS = """SELECT p.id, p.loan_id, p.edition_id, p.source_location_id, p.quantity
      FROM loan_pick p JOIN loan o ON o.id = p.loan_id
      WHERE p.owner_id = %s AND o.lender_id = %s AND p.edition_id = ANY(%s) AND p.state = 'reserved'
        AND o.state IN ('offered','accepted') AND o.lender_handover_at IS NULL
      ORDER BY o.accepted_at NULLS LAST, o.created_at, o.id, p.id"""
PREVIOUS_INBOX_EVENTS = """SELECT u.id, u.kind, u.loan_id, u.other_name, u.read_at, u.created_at,
        o.kind AS loan_kind, o.state AS loan_state, o.closed_reason, o.lender_id, o.borrower_id
      FROM inbox_update u JOIN loan o ON o.id = u.loan_id
      WHERE u.recipient_id = %s AND u.dismissed_at IS NULL
      ORDER BY u.created_at DESC, u.id LIMIT %s"""


@pytest.fixture
def scratch():
    """A new empty database on the disposable server; yields its URL and drops it after."""
    admin = os.environ.get('RECOVERY_TEST_DATABASE_URL')
    if not admin:
        pytest.skip('RECOVERY_TEST_DATABASE_URL names the disposable PostgreSQL server')
    name = 'tcg_trade_migrations_' + uuid4().hex
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    try:
        yield make_conninfo(admin, dbname=name)
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(name)))


def run_again(url, name):
    """Applies one migration file again, as scripts/migrate.py applies a file: in one transaction."""
    with psycopg.connect(url) as conn, conn.transaction():
        conn.execute((ROOT / 'migrations' / name).read_text())


def edition(conn):
    """One Card Edition, with the fewest catalog rows its keys need."""
    identity = conn.execute("""INSERT INTO catalog_identity(identity_key, display_name)
      VALUES (%s, 'Iono') RETURNING id""", ('iono-' + uuid4().hex,)).fetchone()['id']
    printing = conn.execute("INSERT INTO catalog_printing(source, identity_id) VALUES ('manual', %s) RETURNING id",
                            (identity,)).fetchone()['id']
    return conn.execute("""INSERT INTO catalog_edition(printing_id, descriptor_key, descriptor)
      VALUES (%s, 'normal', '{}') RETURNING id""", (printing,)).fetchone()['id']


def collector(conn, user_id):
    """An owner row (its profile comes with it) and a Binder of theirs; returns the Binder's id."""
    conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s)', (user_id,))
    binder = uuid4()
    conn.execute("INSERT INTO location(id, owner_id, name, kind) VALUES (%s, %s, 'Binder', 'storage_leaf')",
                 (binder, user_id))
    return binder


def test_migrations_141_to_143_add_the_trade_schema_and_run_again(scratch):
    migrate(scratch, before='143_trade_wants.sql')
    owner = 'collector-' + uuid4().hex
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        collector(conn, owner)
    migrate(scratch)
    for name in TRADING:
        run_again(scratch, name)
        run_again(scratch, name)
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        tables = {row['tablename'] for row in conn.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'trade%%'")}
        assert tables == {'trade', 'trade_line', 'trade_pick', 'trade_want', 'trade_accept'}
        triggers = {row['tgname']: row['tgrelid'] for row in conn.execute(
            """SELECT tgname, tgrelid::regclass::text AS tgrelid FROM pg_trigger
               WHERE tgname IN ('trade_promise_guard', 'trade_line_promise_guard', 'trade_names_follow_profile')""")}
        assert triggers == {'trade_promise_guard': 'trade', 'trade_line_promise_guard': 'trade_line',
                            'trade_names_follow_profile': 'collector_profile'}
        deferred = {row['tgname'] for row in conn.execute(
            "SELECT tgname FROM pg_trigger WHERE tgconstraint <> 0 AND tgdeferrable AND tginitdeferred")}
        assert {'trade_promise_guard', 'trade_line_promise_guard'} <= deferred
        indexes = {row['indexname'] for row in conn.execute(
            "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename IN ('trade', 'trade_pick')")}
        assert indexes >= {'trade_proposer', 'trade_recipient', 'trade_reserving_proposer', 'trade_reserving_recipient',
                           'trade_pick_trade', 'trade_pick_source_index'}
        functions = {row['proname'] for row in conn.execute(
            """SELECT proname FROM pg_proc WHERE proname IN ('trade_reserved_copies', 'reserved_copies',
                 'check_loan_promises', 'reserving_picks', 'trade_listable', 'trade_promise_guard',
                 'trade_line_promise_guard', 'trade_names_follow_profile')""")}
        assert len(functions) == 8
        [kinds] = conn.execute("""SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid = 'handle_lookup_event'::regclass AND contype = 'c'""").fetchall()
        for kind in ('lookup', 'handle_change', 'friend_command', 'loan_command', 'trade_command'):
            assert f"'{kind}'" in kinds['definition'], kind
        assert conn.execute("SELECT pg_get_serial_sequence('loan_pick', 'id') AS name").fetchone()['name'] \
            == 'public.loan_pick_id_seq'
        # The profile that existed before 143 is not Open to cash offers.
        assert conn.execute('SELECT open_to_cash_offers FROM collector_profile WHERE user_id=%s',
                            (owner,)).fetchone() == {'open_to_cash_offers': False}
        # Trade Wants and Will accept go with the account.
        card = edition(conn)
        conn.execute('INSERT INTO trade_want(owner_id, edition_id, quantity) VALUES (%s, %s, 4)', (owner, card))
        conn.execute("INSERT INTO trade_accept(owner_id, edition_id, rule) VALUES (%s, %s, 'identity')", (owner, card))
        conn.execute("INSERT INTO handle_lookup_event(user_id, kind) VALUES (%s, 'trade_command')", (owner,))
        other = edition(conn)
        for statement in ('INSERT INTO trade_want(owner_id, edition_id, quantity) VALUES (%s, %s, 10000)',
                          'INSERT INTO trade_want(owner_id, edition_id, quantity) VALUES (%s, %s, 0)',
                          "INSERT INTO trade_accept(owner_id, edition_id, rule) VALUES (%s, %s, 'edition')"):
            with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
                conn.execute(statement, (owner, other))
        conn.execute('DELETE FROM inventory_owner WHERE user_id=%s', (owner,))
        assert conn.execute("""SELECT (SELECT count(*) FROM trade_want) + (SELECT count(*) FROM trade_accept)
          AS n""").fetchone() == {'n': 0}


def test_an_older_api_build_still_reads_loans_and_the_inbox_once_migrations_140_to_142_apply(scratch):
    migrate(scratch, before='140_for_trade_locations.sql')
    lender, borrower = 'lender-' + uuid4().hex, 'borrower-' + uuid4().hex
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        card = edition(conn)
        binder = collector(conn, lender)
        collector(conn, borrower)
        conn.execute('INSERT INTO holding(owner_id, location_id, edition_id, quantity, version) VALUES (%s,%s,%s,3,1)',
                     (lender, binder, card))
        loans = []
        # An offered Lend Offer created first, then an accepted Borrow Request: the offer's pick sorts last.
        for kind, state, accepted in (('lend_offer', 'offered', None), ('borrow_request', 'accepted', 'now')):
            loan = uuid4()
            loans.append(loan)
            conn.execute("""INSERT INTO loan(id, kind, state, lender_id, borrower_id, lender_name, borrower_name,
                created_at, accepted_at)
              VALUES (%s, %s, %s, %s, %s, 'Misty W.', 'Ash K.', now() - interval '1 day' * %s, %s::timestamptz)""",
                         (loan, kind, state, lender, borrower, 2 - len(loans), accepted))
            conn.execute('INSERT INTO loan_line(loan_id, edition_id, position, requested, promised) VALUES (%s,%s,0,1,1)',
                         (loan, card))
            conn.execute("""INSERT INTO loan_pick(loan_id, owner_id, edition_id, source_location_id, quantity)
              VALUES (%s, %s, %s, %s, 1)""", (loan, lender, card, binder))
        conn.execute("""INSERT INTO inbox_update(id, recipient_id, kind, loan_id, other_name)
          VALUES (%s, %s, 'accepted', %s, 'Misty W.')""", (uuid4(), borrower, loans[1]))

    def previous_reads():
        with psycopg.connect(scratch, row_factory=dict_row) as conn:
            return {
                'reserved_counts': conn.execute(PREVIOUS_RESERVED_COUNTS, ([lender], [card])).fetchall(),
                'reserved_by_owner': conn.execute(PREVIOUS_RESERVED_BY_OWNER, ([lender, borrower], None)).fetchall(),
                'reserved_picks': conn.execute(PREVIOUS_RESERVED_PICKS, (lender, lender, [card])).fetchall(),
                'pick_shortfalls': conn.execute(PREVIOUS_PICK_SHORTFALLS, (lender, lender, [card])).fetchall(),
                'inbox': conn.execute(PREVIOUS_INBOX_EVENTS, (borrower, 50)).fetchall()}

    before = previous_reads()
    assert [row['reserved'] for row in before['reserved_counts']] == [2]
    assert [row['loan_id'] for row in before['pick_shortfalls']] == [loans[1], loans[0]]
    assert len(before['inbox']) == 1
    migrate(scratch, before='143_trade_wants.sql')
    assert previous_reads() == before
    # The invariant still refuses under its old constraint name and SQLSTATE; only the message names Trades.
    with pytest.raises(psycopg.errors.CheckViolation) as refused:
        with psycopg.connect(scratch) as conn:
            conn.execute('UPDATE holding SET quantity=1 WHERE owner_id=%s', (lender,))
    assert (refused.value.diag.constraint_name, refused.value.diag.sqlstate) == ('loan_promises_owned', '23514')
    assert refused.value.diag.message_primary == \
        'Open Loans and Trades promise 2 copies of a Card Edition its owner holds 1 of'
    migrate(scratch)
    for name in TRADING:
        run_again(scratch, name)
    assert previous_reads() == before
