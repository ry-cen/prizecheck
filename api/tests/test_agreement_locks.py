"""ADR 0015's lock order and one-write rule hold for a Loan step and a Trade step, which share the command start
(``owners.begin_owner_command``) and each run their own step (``loans.run_step``, ``trades.run_trade_step``).

A recording connection keeps every statement a step sends, in order: the owner rows lock first (``lock_owners``, in
ascending ``user_id``), then any ``loan`` row, then any ``trade`` row, and the step's agreement row (``loan`` or
``trade``) is written by exactly one UPDATE.
"""
import os
import re

import psycopg
import pytest
from psycopg import sql
from psycopg.rows import dict_row

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from app.social import loans, trades
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import hold
from test_friend_copies import node, ok
from test_loans import accept, pair, sent, step, view
from test_trades import proposed, trade_step, trading
from want_list_swap_fixtures import seed_swap_catalog


class Recording(psycopg.Connection):
    """A connection that keeps the statements it executes, as (text, params)."""
    statements: list

    def execute(self, query, params=None, **kwargs):
        if not hasattr(self, 'statements'):
            self.statements = []
        text = query.as_string(self) if isinstance(query, sql.Composable) else str(query)
        self.statements.append((' '.join(text.split()), params))
        return super().execute(query, params, **kwargs)


OWNER_LOCK = re.compile(r'FROM inventory_owner WHERE user_id=%s FOR (?:NO KEY )?UPDATE')
LOAN_LOCK = re.compile(r'FROM loan\b.*\bFOR (?:NO KEY )?UPDATE')
TRADE_LOCK = re.compile(r'FROM trade\b.*\bFOR (?:NO KEY )?UPDATE')


def recorded(monkeypatch, module):
    """The recording connections ``module.connect`` hands out, in the order opened."""
    opened = []

    def connect_recording():
        conn = Recording.connect(os.environ['DATABASE_URL'], row_factory=dict_row)
        conn.statements = []
        opened.append(conn)
        return conn

    monkeypatch.setattr(module, 'connect', connect_recording)
    return opened


def locks_in_order(statements):
    """(rank, owner id or None) of each lock statement: 0 for an owner row, 1 for a Loan row, 2 for a Trade row."""
    found = []
    for text, params in statements:
        if OWNER_LOCK.search(text):
            found.append((0, params[0]))
        elif LOAN_LOCK.search(text):
            found.append((1, None))
        elif TRADE_LOCK.search(text):
            found.append((2, None))
    return found


def writes_of(statements, table):
    return [text for text, _ in statements if re.match(rf'UPDATE {table} SET\b', text)]


def assert_adr_0015(statements, agreement, owners_locked):
    found = locks_in_order(statements)
    ranks = [rank for rank, _ in found]
    assert ranks == sorted(ranks), f'locks out of the owner, Loan, Trade order: {found}'
    owner_ids = [owner for rank, owner in found if rank == 0]
    assert owner_ids == sorted(owner_ids) and set(owner_ids) == set(owners_locked)
    assert ranks.count({'loan': 1, 'trade': 2}[agreement]) == 1
    assert len(writes_of(statements, agreement)) == 1, f'{agreement} row written more than once'
    assert not writes_of(statements, 'trade' if agreement == 'loan' else 'loan')


def test_a_loan_step_locks_owners_then_the_loan_and_writes_the_loan_row_once(store, monkeypatch):
    ids = seed_swap_catalog()
    ash, misty = pair(ordered=True)
    iono = ids['PAL 185']
    hold(misty, node(misty, 'Unsorted')['id'], iono, 2)
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 2)])), [(iono, 2)]))
    current = view(ash, loan)
    opened = recorded(monkeypatch, loans)
    # The borrower's cancel of an accepted Loan locks both collectors and releases the lender's copies.
    assert ok(step(ash, current, 'cancel'))['closed_reason'] == 'cancelled'
    assert len(opened) == 1
    assert_adr_0015(opened[0].statements, 'loan', [ash, misty])


def test_a_trade_step_locks_owners_then_the_trade_and_writes_the_trade_row_once(store, monkeypatch):
    ids, ash, misty, _, _ = trading()
    trade = proposed(misty, ash, give=[(ids['PAL 185'], 1)], get=[(ids['SVI 166'], 2)])
    opened = recorded(monkeypatch, trades)
    # The recipient's decline locks both sides and releases the proposer's copies.
    assert ok(trade_step(ash, trade, 'decline'))['closed_reason'] == 'declined'
    assert len(opened) == 1
    assert_adr_0015(opened[0].statements, 'trade', [ash, misty])


@pytest.mark.parametrize('statements, message', [
    ([('SELECT 1 FROM loan WHERE id = %s FOR NO KEY UPDATE', None),
      ('SELECT 1 FROM inventory_owner WHERE user_id=%s FOR NO KEY UPDATE', ('a',))], 'out of the owner'),
    ([('SELECT 1 FROM inventory_owner WHERE user_id=%s FOR NO KEY UPDATE', ('b',)),
      ('SELECT 1 FROM inventory_owner WHERE user_id=%s FOR NO KEY UPDATE', ('a',)),
      ('SELECT * FROM loan WHERE id = %s FOR NO KEY UPDATE', None)], ''),
])
def test_the_lock_order_check_fails_on_a_loan_before_an_owner_and_on_descending_owners(statements, message):
    with pytest.raises(AssertionError):
        assert_adr_0015(statements + [('UPDATE loan SET revision = revision + 1 WHERE id = %s', None)],
                        'loan', ['a', 'b'])
