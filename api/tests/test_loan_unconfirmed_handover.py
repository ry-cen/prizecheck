"""One owner for the Loan "nobody has confirmed a handover" condition (state-invariants Stage 2, #606).

``social.loans.UNCONFIRMED_HANDOVER`` is shared by ``end_loans_between`` (Remove Friend, Block, suspension) and the Loan
arm of ``social.reports.unconfirmed_partners``. These tests pin the condition's tokens, the whole statement each site
sends with its bound parameters, and which Loans each site picks across state and handover timestamps. Behaviour is
unchanged: only requested, offered and accepted Loans with neither handover confirmed are picked; a Loan either side
confirmed, a handed over Loan and every closed Loan are not, whatever timestamps a closed Loan retains.
"""
import re
from itertools import product

import pytest

from app.main import connect
from app.social import loans, reports
from app.social.loans import end_loans_between
from app.social.owners import lock_owners
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import store  # noqa: F401  (autouse fixtures)
from test_friend_copies import collector
from test_threads import thread

CONDITION = ("state IN ('requested','offered','accepted') AND lender_handover_at IS NULL "
             "AND borrower_handover_at IS NULL")
OPEN = ('requested', 'offered', 'accepted')


def tokens(text):
    """The SQL's meaningful tokens: words, quoted literals, operators and parameters, whitespace ignored."""
    return re.findall(r"'[^']*'|%\(\w+\)s|\w+(?:\.\w+)?|<>|[^\s\w]", text)


class Recorder:
    """A connection that records each statement and answers every read with no rows."""

    def __init__(self):
        self.calls = []

    def execute(self, query, params=None):
        self.calls.append((query, params))
        return self

    def fetchall(self):
        return []

    def fetchone(self):
        return None


def test_the_condition_is_exactly_the_open_state_and_both_handover_stamps_unset():
    assert tokens(loans.UNCONFIRMED_HANDOVER) == tokens(CONDITION)


def test_end_loans_between_sends_the_same_statement_and_parameters():
    recorder = Recorder()
    assert end_loans_between(recorder, 'me', ['a', 'b'], 'closed_blocked') == set()
    [(query, params)] = recorder.calls
    assert tokens(query) == tokens("""SELECT l.*, t.user_low AS thread_user_low FROM loan l JOIN thread t ON t.id=l.thread_id
      WHERE ((lender_id = %(a)s AND borrower_id = ANY(%(b)s)) OR (lender_id = ANY(%(b)s) AND borrower_id = %(a)s))
        AND state IN ('requested', 'offered', 'accepted')
        AND lender_handover_at IS NULL AND borrower_handover_at IS NULL
      ORDER BY l.id FOR NO KEY UPDATE OF l""")
    assert params == {'a': 'me', 'b': ['a', 'b']}


def test_unconfirmed_partners_sends_the_same_statement_and_parameters():
    recorder = Recorder()
    assert reports.unconfirmed_partners(recorder, 'me') == ([], [])
    [(query, params)] = recorder.calls
    assert tokens(query) == tokens("""SELECT borrower_id AS a,lender_id AS b,thread_id FROM loan
      WHERE (borrower_id=%(me)s OR lender_id=%(me)s) AND borrower_id IS NOT NULL AND lender_id IS NOT NULL
        AND state IN ('requested','offered','accepted') AND lender_handover_at IS NULL AND borrower_handover_at IS NULL
      UNION ALL SELECT proposer_id,recipient_id,thread_id FROM trade
      WHERE (proposer_id=%(me)s OR recipient_id=%(me)s) AND proposer_id IS NOT NULL AND recipient_id IS NOT NULL
        AND state IN ('proposed','accepted') AND proposer_swap_at IS NULL AND recipient_swap_at IS NULL""")
    assert params == {'me': 'me'}


def cases():
    """(state, lender confirmed, borrower confirmed, closed_reason, picked): every open state with zero, one and two
    stamps, a handed over Loan, and closed Loans that kept the stamps they had when they closed."""
    rows = [(state, lender, borrower, None, not lender and not borrower)
            for state in OPEN for lender, borrower in product((False, True), repeat=2)]
    rows.append(('handed_over', True, True, None, False))
    rows += [('closed', lender, borrower, reason, False)
             for reason in ('declined', 'cancelled', 'returned', 'written_off')
             for lender, borrower in ((False, False), (True, False), (True, True))]
    return rows


def make(lender, borrower, state, lender_stamp, borrower_stamp, reason):
    tid, rid = thread(lender, borrower, kind='loan')
    with connect() as conn:
        conn.execute("""UPDATE loan SET state=%s, closed_reason=%s,
          closed_at=CASE WHEN %s='closed' THEN now() END,
          lender_handover_at=CASE WHEN %s THEN now() END, borrower_handover_at=CASE WHEN %s THEN now() END
          WHERE id=%s""", (state, reason, state, lender_stamp, borrower_stamp, rid))
    return tid, rid


@pytest.mark.parametrize('actor_is_lender', [False, True], ids=['borrower', 'lender'])
def test_end_loans_between_cancels_exactly_the_unconfirmed_open_loans_either_way_round(store, actor_is_lender):
    me, other = collector()[0], collector()[0]
    made = []
    for state, lender_stamp, borrower_stamp, reason, picked in cases():
        lender, borrower = (me, other) if actor_is_lender else (other, me)
        tid, rid = make(lender, borrower, state, lender_stamp, borrower_stamp, reason)
        made.append((tid, rid, state, reason, picked))
    with connect() as conn, conn.transaction():
        lock_owners(conn, me, other)
        touched = end_loans_between(conn, me, other, 'closed_unfriended')
    assert touched == {tid for tid, _, _, _, picked in made if picked}
    with connect() as conn:
        for tid, rid, state, reason, picked in made:
            row = conn.execute('SELECT state, closed_reason FROM loan WHERE id=%s', (rid,)).fetchone()
            expected = ('closed', 'cancelled') if picked else (state, reason)
            assert (row['state'], row['closed_reason']) == expected, (state, picked)


@pytest.mark.parametrize('actor_is_lender', [False, True], ids=['borrower', 'lender'])
def test_unconfirmed_partners_lists_exactly_the_partners_and_threads_of_the_unconfirmed_open_loans(store, actor_is_lender):
    me = collector()[0]
    expected_partners, expected_threads = set(), set()
    for state, lender_stamp, borrower_stamp, reason, picked in cases():
        partner = collector()[0]
        lender, borrower = (me, partner) if actor_is_lender else (partner, me)
        tid, _ = make(lender, borrower, state, lender_stamp, borrower_stamp, reason)
        if picked:
            expected_partners.add(partner)
            expected_threads.add(tid)
    with connect() as conn:
        partners, threads = reports.unconfirmed_partners(conn, me)
    assert partners == sorted(expected_partners)
    assert threads == sorted(expected_threads)
    assert len(expected_partners) == len(OPEN)
