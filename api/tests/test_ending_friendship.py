"""Ending a friendship with open Loans (social network #260), through signed HTTP against PostgreSQL.

Remove Friend and Block, from either side, cancel the pair's Borrow Requests, Lend Offers and accepted Loans nobody has
confirmed a handover for, either way round, and release what they reserved: each such lender's revision moves once.
The other side is told only that the Loan was cancelled and by whom, as for any cancel. A Loan either side confirmed a
handover for counts as handed over and stays open, and its steps still work. An unfriend racing a handover, or a
cancel from the other side, waits for it and never deadlocks. Edit and resend, a new request to the lender, is offered
only while the two are Friends (owner's decision, 2026-10-16).

Ending a friendship with open Trades (Trading #274): the same commands cancel the pair's Trade Proposals and accepted
Trades nobody has confirmed the swap for, either way round, and release both sides' promised copies, which come back to
both Trade Lists and to the Spare Copies a Friend sees; each side whose copies were released moves its revision once.
The other side gets the update a plain cancel stores, the same after an unfriend and after a Block. A Trade one side
confirmed stays open, and the remaining side finishes it alone, Blocked or not, seeing nothing change. The Remove
Friend and Block questions count from the Trades list's rows. Unfriend and Block racing an accept, a Confirm swap or a
send of the same pair wait for each other and never deadlock.
"""
import json
import os
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg
import pytest

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import hold
from test_blocks import unblock
from test_for_trade_locations import mark
from test_friend_copies import befriend, block, collector, copies, ok, place
from test_handover import _asleep, _sleeping, accepted_loan, borrowed, code, handover, take_back
from test_holdings import call
from test_inbox import inbox, updates
from test_lend_offers import offer
from test_loan_promises import _waiting_on_a_row
from test_loans import accept, pair, revision_of, sent, step, view
from test_returns import confirm_return, start_return
from test_trade_lists import own_cards
from test_trade_promises import reserved, trade_picks
from test_trade_swap import confirm, held, unsorted
from test_trades import accept_trade, detail, propose, proposed, read, row_of, trade_step
from test_trades import updates as stored_updates
from want_list_swap_fixtures import seed_swap_catalog

CANCELLED = ('requested', 'accepted', 'offered', 'reverse')


def remove(user, other, key=None):
    return call('POST', f'/api/social/friends/{other}/remove', user, {'idempotency_key': str(key or uuid4())})


def shape(user, loan):
    found = view(user, loan)
    return found['state'], found['closed_reason'], found['closed_by']


def picks_left(loan):
    with connect() as conn:
        return conn.execute('SELECT count(*) AS n FROM loan_pick WHERE loan_id=%s', (loan['id'],)).fetchone()['n']


def cancels(user):
    return sorted((loan_id, name) for kind, loan_id, name, _ in updates(user) if kind == 'cancelled')


def loans_between():
    """Ash K. and Misty W., Friends, Ash's id first. Misty holds 8 Iono in Binder, Ash 2 in Box. Between them: a Borrow
    Request Ash sent, a Loan Misty accepted, a Lend Offer Misty sent, a Loan Ash accepted lending Misty one, a Loan only
    Misty confirmed handing over, and a Loan both confirmed."""
    iono = seed_swap_catalog()['PAL 185']
    ash, misty = pair(ordered=True)
    binder, box = place(misty, 'Binder'), place(ash, 'Box')
    hold(misty, binder, iono, 8)
    hold(ash, box, iono, 2)

    def accepted():
        return ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))

    loans = {'requested': sent(ash, misty, [(iono, 1)]), 'accepted': accepted(),
             'offered': ok(offer(misty, ash, [(binder, iono, 1)]), 201),
             'reverse': ok(accept(ash, view(ash, sent(misty, ash, [(iono, 1)])), [(iono, 1)])),
             'half': accepted(), 'out': accepted()}
    ok(handover(misty, loans['half']))
    ok(handover(misty, loans['out']))
    ok(handover(ash, loans['out']))
    return iono, ash, misty, loans


def test_removing_a_friend_cancels_every_loan_nobody_handed_over_either_way_and_keeps_the_rest(store):
    iono, ash, misty, loans = loans_between()
    before = {owner: revision_of(owner) for owner in (ash, misty)}
    key = uuid4()
    assert ok(remove(ash, misty, key))['relation'] == 'none'
    for name in CANCELLED:
        assert shape(ash, loans[name]) == ('closed', 'cancelled', 'you'), name
        assert shape(misty, loans[name]) == ('closed', 'cancelled', 'them'), name
        assert picks_left(loans[name]) == 0, name
    # Misty lent on the accepted Loan and the offer, Ash on the reverse one: each revision moved once.
    assert revision_of(misty) == before[misty] + 1 and revision_of(ash) == before[ash] + 1
    # A Loan either side confirmed a handover for stays open.
    half = view(misty, loans['half'])
    assert (half['state'], half['you_confirmed_handover'], half['they_confirmed_handover']) == ('accepted', True, False)
    assert view(ash, loans['out'])['state'] == 'handed_over'
    # Misty is told each was cancelled by Ash and never why; Ash, who ended it, is told nothing.
    assert cancels(misty) == sorted((loans[name]['id'], 'Ash K.') for name in CANCELLED)
    assert cancels(ash) == []
    # The same command replayed changes nothing more.
    assert ok(remove(ash, misty, key))['relation'] == 'none'
    assert revision_of(misty) == before[misty] + 1 and len(cancels(misty)) == len(CANCELLED)
    # The open Loans' steps still work: Ash confirms the half-confirmed one, and returns the handed-over one.
    ok(handover(ash, loans['half']))
    assert view(misty, loans['half'])['state'] == 'handed_over'
    ok(start_return(ash, loans['out'], [(iono, 1)]))
    ok(confirm_return(misty, loans['out']))
    assert shape(misty, loans['out'])[:2] == ('closed', 'returned')


def test_a_block_by_either_side_cancels_them_too_and_the_blocked_collector_reads_a_plain_cancel(store):
    iono, ash, misty, loans = loans_between()
    block(misty, ash)
    for name in CANCELLED:
        assert shape(ash, loans[name]) == ('closed', 'cancelled', 'them'), name
    assert cancels(ash) == sorted((loans[name]['id'], 'Misty W.') for name in CANCELLED)
    told = next(update for update in inbox(ash)['updates']
                if update['loan_id'] == loans['accepted']['id'])
    assert set(told) == {'id', 'kind', 'loan_id', 'loan_kind', 'loan_state', 'role', 'other_name', 'read', 'at',
                         'return_by'}
    # Misty confirmed the half-confirmed Loan: she may still take that back after the Block, and then it is a Loan
    # nobody confirmed a handover for, which either side may cancel.
    assert view(ash, loans['half'])['state'] == 'accepted'
    ok(take_back(misty, loans['half']))
    ok(step(ash, view(ash, loans['half']), 'cancel'))
    assert shape(misty, loans['half']) == ('closed', 'cancelled', 'them')
    assert view(misty, loans['out'])['state'] == 'handed_over'
    # The borrower's Block cancels the lender's Loans just the same.
    iono, ash, misty, loans = loans_between()
    block(ash, misty)
    for name in CANCELLED:
        assert shape(misty, loans[name]) == ('closed', 'cancelled', 'them'), name
    assert view(misty, loans['half'])['state'] == 'accepted'


def test_an_unfriend_racing_the_lenders_handover_waits_and_leaves_that_loan_open(store):
    # Ash's id sorts first, so his unfriend holds his own row while it waits on Misty's, which her handover holds.
    iono, ash, misty, binder, loan = accepted_loan(held=4, asked=2, ordered=True)
    pending = sent(ash, misty, [(iono, 1)])
    drop = _sleeping('loan_pick', 'UPDATE', f"NEW.owner_id = '{misty}' AND NEW.state = 'lent'")
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            handed = executor.submit(handover, misty, loan)
            _asleep(watch, 1, [handed])
            removed = executor.submit(remove, ash, misty)
            handed, removed = handed.result(), removed.result()
    finally:
        drop()
    assert handed.status_code == 200, handed.text
    assert ok(removed)['relation'] == 'none'
    found = view(ash, loan)
    assert (found['state'], found['they_confirmed_handover']) == ('accepted', True)
    assert shape(ash, pending) == ('closed', 'cancelled', 'you')
    # Ash can still confirm his side.
    ok(handover(ash, loan))
    assert view(misty, loan)['state'] == 'handed_over'


def test_a_handover_racing_an_unfriend_waits_and_then_finds_the_loan_cancelled(store):
    # Misty's unfriend locks Ash's row first and holds it while it writes the Loan row; Ash's handover waits on it.
    iono, ash, misty, binder, loan = accepted_loan(held=2, asked=2, ordered=True)
    before = revision_of(misty)
    body = {'revision': view(ash, loan)['revision'], 'idempotency_key': str(uuid4())}
    drop = _sleeping('loan', 'UPDATE', f"NEW.closed_by = '{misty}'")
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            removed = executor.submit(remove, misty, ash)
            _asleep(watch, 1, [removed])
            handed = executor.submit(call, 'POST', f"/api/loans/{loan['id']}/handover", ash, body)
            removed, handed = removed.result(), handed.result()
    finally:
        drop()
    assert ok(removed)['relation'] == 'none'
    assert code(handed) == (409, 'LOAN_CHANGED')
    assert shape(ash, loan) == ('closed', 'cancelled', 'them')
    assert borrowed(loan) == {} and picks_left(loan) == 0 and revision_of(misty) == before + 1


def test_an_unfriend_and_a_cancel_from_the_other_side_lock_both_owners_in_order_and_never_deadlock(store):
    # Ash, the borrower, cancels one Loan (locking both owners, his row first) while Misty removes him (locking both,
    # the same order): the unfriend waits, then cancels what is left, and each command moves Misty's revision once.
    iono, ash, misty, binder, first = accepted_loan(held=4, asked=2, ordered=True)
    second = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))
    before = revision_of(misty)
    body = {'revision': view(ash, first)['revision'], 'idempotency_key': str(uuid4())}
    drop = _sleeping('loan', 'UPDATE', f"NEW.closed_by = '{ash}'")
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            cancelled = executor.submit(call, 'POST', f"/api/social/loans/{first['id']}/cancel", ash, body)
            _asleep(watch, 1, [cancelled])
            removed = executor.submit(remove, misty, ash)
            cancelled, removed = cancelled.result(), removed.result()
    finally:
        drop()
    assert cancelled.status_code == 200, cancelled.text
    assert ok(removed)['relation'] == 'none'
    assert shape(misty, first) == ('closed', 'cancelled', 'them')
    assert shape(misty, second) == ('closed', 'cancelled', 'you')
    assert revision_of(misty) == before + 2


def test_edit_and_resend_is_offered_only_while_the_lender_is_still_a_friend(store):
    iono, ash, misty, loans = loans_between()
    declined = sent(ash, misty, [(iono, 1)])
    ok(step(misty, view(misty, declined), 'decline'))
    assert view(ash, declined)['actions'] == ['edit_and_resend']
    # Ash removes Misty: the requests he sent, cancelled or declined, no longer offer it, on the Loan and the Loans tab.
    ok(remove(ash, misty))
    for name in ('requested', 'accepted'):
        assert shape(ash, loans[name]) == ('closed', 'cancelled', 'you') and view(ash, loans[name])['actions'] == []
    assert view(ash, declined)['actions'] == []
    tab = {loan['id']: loan['actions'] for loan in ok(call('GET', '/api/social/loans', ash))['loans']}
    assert tab[declined['id']] == [] and tab[loans['requested']['id']] == []
    # Friends again, it is offered again.
    befriend(ash, misty)
    assert view(ash, declined)['actions'] == ['edit_and_resend']
    assert view(ash, loans['requested'])['actions'] == ['edit_and_resend']
    # Misty's Block hides it, and lifting the Block doesn't bring it back: they aren't Friends.
    block(misty, ash)
    assert view(ash, declined)['actions'] == []
    assert ok(unblock(misty, ash))['relation'] == 'none'
    assert view(ash, declined)['actions'] == []


# Ending a friendship with open Trades (Trading #274).

ENDED = ('proposed', 'reverse', 'accepted')


def end(action, user, other):
    """Remove Friend or Block, through the route; returns the response."""
    if action == 'remove':
        return remove(user, other)
    return call('POST', '/api/social/blocks', user, {'collector_id': other, 'idempotency_key': str(uuid4())})


def trade_shape(user, trade):
    found = ok(read(user, trade))
    return found['state'], found['closed_reason'], found['closed_by']


def trade_cancels(user):
    """The Trade updates the inbox shows ``user`` as sorted (kind, Trade id, name)."""
    return sorted((update['kind'], update['trade_id'], update['other_name']) for update in inbox(user)['trade_updates'])


def trades_between():
    """Ash K. and Misty W., Friends, Ash's id first. Misty holds 4 Iono in her For trade Trade Binder, Ash 4 Arven in
    his For trade Box. Between them: a proposal Misty sent (1 Iono for 1 Arven), one Ash sent (1 Arven for 1 Iono), a
    Trade Ash accepted (Misty's Iono for his Arven) and one Ash accepted and confirmed (the same cards): half-confirmed.
    Returns (ids, ash, misty, binder, box, trades)."""
    ids = seed_swap_catalog()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    ash, misty = pair(ordered=True)
    binder, box = place(misty, 'Trade Binder'), place(ash, 'Box')
    hold(misty, binder, iono, 4)
    hold(ash, box, arven, 4)
    ok(mark(misty, binder))
    ok(mark(ash, box))

    def swap():
        return proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)])

    trades = {'proposed': swap(), 'reverse': proposed(ash, misty, give=[(arven, 1)], get=[(iono, 1)]),
              'accepted': ok(accept_trade(ash, swap())), 'half': ok(accept_trade(ash, swap()))}
    ok(confirm(ash, trades['half']))
    return ids, ash, misty, binder, box, trades


def test_removing_a_friend_cancels_every_trade_nobody_confirmed_either_way_and_keeps_the_half_confirmed_one(store):
    ids, ash, misty, binder, box, trades = trades_between()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    # Brock, Friends with both, sees their Spare Copies.
    brock, _ = collector('Brock S.')
    befriend(brock, ash)
    befriend(brock, misty)
    # Misty promised 3 Iono (her proposal, the accepted Trade and the half-confirmed one); Ash 2 Arven (his proposal and
    # the accepted Trade) of the 3 he still holds, having given 1 at his Confirm swap.
    assert reserved(misty, iono) == (3, 3) and reserved(ash, arven) == (2, 2)
    # Ash's own Iono, from that swap, is spare and was never promised.
    assert copies(brock, [misty, ash], [iono, arven]) == {
        (misty, iono): (1, 0), (ash, arven): (1, 0), (ash, iono): (1, 0)}
    before = {owner: revision_of(owner) for owner in (ash, misty)}
    key = uuid4()
    assert ok(remove(ash, misty, key))['relation'] == 'none'
    for name in ENDED:
        assert trade_shape(ash, trades[name]) == ('closed', 'cancelled', 'you'), name
        assert trade_shape(misty, trades[name]) == ('closed', 'cancelled', 'them'), name
        assert trade_picks(trades[name]['id']) == [], name
    # Both sides' promised copies come back, to both Trade Lists and to the Spare Copies Brock sees; Misty's copy for
    # the half-confirmed Trade stays promised.
    assert reserved(misty, iono) == (1, 1) and reserved(ash, arven) == (0, 0)
    assert own_cards(misty) == {iono: ('3', {'Trade Binder': '3'})} and own_cards(ash) == {arven: ('3', {'Box': '3'})}
    assert copies(brock, [misty, ash], [iono, arven]) == {
        (misty, iono): (3, 0), (ash, arven): (3, 0), (ash, iono): (1, 0)}
    # Each side gave cards in a cancelled Trade: each revision moved once.
    assert revision_of(misty) == before[misty] + 1 and revision_of(ash) == before[ash] + 1
    # Misty is told each was cancelled by Ash and never why; Ash, who ended it, is told nothing new.
    assert trade_cancels(misty) == sorted(
        [('accepted', trades[name]['id'], 'Ash K.') for name in ('accepted', 'half')]
        + [('cancelled', trades[name]['id'], 'Ash K.') for name in ENDED])
    assert trade_cancels(ash) == []
    # The same command replayed changes nothing more.
    assert ok(remove(ash, misty, key))['relation'] == 'none'
    assert revision_of(misty) == before[misty] + 1 and len(trade_cancels(misty)) == 5
    # The half-confirmed Trade stays open, and Misty, the remaining side, may only finish it.
    half = ok(read(misty, trades['half']))
    assert (half['state'], half['they_confirmed_swap'], half['waiting'], half['actions']) == (
        'accepted', True, 'confirm_swap', ['confirm_swap', 'use_suggested_picks'])
    assert [line['id'] for line in inbox(misty)['trade_waiting']] == [trades['half']['id']]
    done = ok(confirm(misty, trades['half']))
    assert (done['state'], done['closed_reason']) == ('closed', 'swapped')
    assert held(misty, unsorted(misty)) == {arven: '1'} and reserved(misty, iono) == (0, 0)
    assert stored_updates(trades['half'])[-1] == (ash, 'swapped', 'Misty W.')


def _no_block(body):
    assert 'block' not in json.dumps(body).lower()


@pytest.mark.parametrize('blocker', ['confirmed', 'remaining'])
def test_a_block_by_either_side_cancels_them_too_and_the_remaining_side_finishes_unseen(store, blocker):
    # Ash confirmed the half-confirmed Trade; Misty is the remaining side. Either one blocks the other.
    ids, ash, misty, binder, box, trades = trades_between()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    seen = ok(read(misty, trades['half']))
    [line] = [line for line in inbox(misty)['trade_waiting'] if line['id'] == trades['half']['id']]
    before = {owner: revision_of(owner) for owner in (ash, misty)}
    if blocker == 'confirmed':
        block(ash, misty)
    else:
        block(misty, ash)
    actor, other = (ash, misty) if blocker == 'confirmed' else (misty, ash)
    for name in ENDED:
        assert trade_shape(other, trades[name]) == ('closed', 'cancelled', 'them'), name
        assert trade_picks(trades[name]['id']) == [], name
    assert reserved(misty, iono) == (1, 1) and reserved(ash, arven) == (0, 0)
    assert revision_of(misty) == before[misty] + 1 and revision_of(ash) == before[ash] + 1
    actor_name = 'Ash K.' if actor == ash else 'Misty W.'
    assert [entry for entry in trade_cancels(other) if entry[0] == 'cancelled'] == sorted(
        ('cancelled', trades[name]['id'], actor_name) for name in ENDED)
    # Misty's half-confirmed Trade, its line and her steps read exactly as before the Block, and nothing says Block.
    assert ok(read(misty, trades['half'])) == seen
    # Ash's proposal to Misty was cancelled, so her one line left is the half-confirmed Trade, as it was.
    assert inbox(misty)['trade_waiting'] == [line]
    for body in (seen, line, inbox(misty), ok(call('GET', '/api/social/trades', misty))):
        _no_block(body)
    # She confirms alone: the Trade is swapped, and Ash, who confirmed first, hears it.
    done = ok(confirm(misty, trades['half']))
    _no_block(done)
    assert (done['closed_reason'], done['other']['display_name']) == ('swapped', 'Ash K.')
    assert held(misty, unsorted(misty)) == {arven: '1'}
    assert stored_updates(trades['half'])[-1] == (ash, 'swapped', 'Misty W.')


def _normal_update(trade):
    """The one stored update of a Trade's other side, without the columns that differ between any two updates."""
    with connect() as conn:
        [row] = conn.execute("SELECT * FROM inbox_update WHERE trade_id=%s AND kind='cancelled'",
                             (trade['id'],)).fetchall()
    return {column: value for column, value in row.items() if column not in ('id', 'recipient_id', 'trade_id',
                                                                             'created_at')}


def _normal_entry(user, trade):
    [entry] = [entry for entry in inbox(user)['trade_updates']
               if entry['trade_id'] == trade['id'] and entry['kind'] != 'accepted']
    return {key: value for key, value in entry.items() if key not in ('id', 'trade_id', 'at')}


def _normal_view(user, trade):
    found = ok(read(user, trade))
    found['other'] = {key: value for key, value in found['other'].items() if key not in ('collector_id', 'handle')}
    return {key: value for key, value in found.items() if key not in ('id', 'created_at')}


def _ended_world(ids, action):
    """A new Ash and Misty: Misty's proposal to Ash and a Trade Ash accepted, then Misty ends it all by ``action``
    ('remove', 'block', or 'cancel', which cancels the Trade and withdraws the proposal: the plain steps). Returns
    Ash's normalized (update, inbox entry, view) of each, by name. One catalog seed serves every world: a seed replaces
    the catalog."""
    iono, arven = ids['PAL 185'], ids['SVI 166']
    ash, misty = pair()
    binder, box = place(misty, 'Trade Binder'), place(ash, 'Box')
    hold(misty, binder, iono, 2)
    hold(ash, box, arven, 1)
    ok(mark(misty, binder))
    ok(mark(ash, box))
    found = {'proposal': proposed(misty, ash, give=[(iono, 1)]),
             'trade': ok(accept_trade(ash, proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)])))}
    if action == 'cancel':
        ok(trade_step(misty, ok(read(misty, found['trade'])), 'cancel'))
        ok(trade_step(misty, ok(read(misty, found['proposal'])), 'withdraw'))
    else:
        ok(end(action, misty, ash))
    return {name: (_normal_update(trade), _normal_entry(ash, trade), _normal_view(ash, trade))
            for name, trade in found.items()}


def test_the_other_side_reads_the_same_update_after_an_unfriend_a_block_and_a_plain_cancel(store):
    ids = seed_swap_catalog()
    unfriended, blocked, cancelled = (_ended_world(ids, action) for action in ('remove', 'block', 'cancel'))
    # Every stored column, the inbox entry and the Trade as Ash reads it are the same after an unfriend and a Block.
    assert unfriended == blocked
    # An accepted Trade reads exactly as a plain cancel does.
    assert unfriended['trade'] == cancelled['trade']
    update, entry, view_ = unfriended['trade']
    assert (update['kind'], update['other_name'], update['loan_id'], update['read_at'], update['dismissed_at']) == (
        'cancelled', 'Misty W.', None, None, None)
    assert entry == {'kind': 'cancelled', 'trade_state': 'closed', 'role': 'recipient', 'other_name': 'Misty W.',
                     'read': False}
    assert (view_['closed_reason'], view_['closed_by'], view_['actions']) == ('cancelled', 'them', [])
    # A proposal reads "cancelled", whichever ended the friendship, never "withdrawn", which a plain withdraw reads.
    assert unfriended['proposal'][1]['kind'] == 'cancelled'
    assert unfriended['proposal'][2]['closed_reason'] == 'cancelled'
    assert cancelled['proposal'][1]['kind'] == 'withdrawn'


def test_only_the_sides_whose_copies_were_promised_move_their_revision_once_for_trades_and_once_for_loans(store):
    ids = seed_swap_catalog()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    ash, misty = pair(ordered=True)
    binder, box = place(misty, 'Trade Binder'), place(ash, 'Box')
    hold(misty, binder, iono, 3)
    hold(ash, box, arven, 2)
    ok(mark(misty, binder))
    ok(mark(ash, box))
    # Misty asks Ash for an Arven (a proposal reserves only what its sender gives: nothing) and gives him an Iono (an
    # accepted gift: Ash gives nothing), and lends him another Iono that nobody has handed over.
    ask = proposed(misty, ash, get=[(arven, 1)])
    gift = ok(accept_trade(ash, proposed(misty, ash, give=[(iono, 1)])))
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))
    before = {owner: revision_of(owner) for owner in (ash, misty)}
    ok(remove(ash, misty))
    for trade in (ask, gift):
        assert trade_shape(misty, trade) == ('closed', 'cancelled', 'them')
    assert shape(misty, loan) == ('closed', 'cancelled', 'them')
    assert reserved(misty, iono) == (0, 0) and reserved(ash, arven) == (0, 0)
    # Ash reserved nothing, so his revision stays. Misty's moves once for her Loans and once for her Trades: the two
    # cancels are separate steps of one command, each moving the revisions it released.
    assert revision_of(ash) == before[ash] and revision_of(misty) == before[misty] + 2


def trades_counted(user, other):
    """The Remove Friend and Block questions' counts, by the web's rule (``tradesEnding``) over the Trades list:
    (Trade Proposals, Trades nobody has confirmed, Trades one side has confirmed), and the ids of the first two."""
    rows = [trade for trade in ok(call('GET', '/api/social/trades', user))['trades']
            if trade['other']['collector_id'] == other]
    proposals = [trade['id'] for trade in rows if trade['state'] == 'proposed']
    unswapped = [trade['id'] for trade in rows if trade['state'] == 'accepted'
                 and not trade['you_confirmed_swap'] and not trade['they_confirmed_swap']]
    staying = [trade['id'] for trade in rows if trade['state'] == 'accepted'
               and trade['you_confirmed_swap'] != trade['they_confirmed_swap']]
    return (len(proposals), len(unswapped), len(staying)), set(proposals + unswapped)


def test_the_trades_list_gives_both_sides_the_questions_counts_and_they_are_what_an_unfriend_cancels(store):
    ids, ash, misty, binder, box, trades = trades_between()
    counted, ending = trades_counted(ash, misty)
    assert counted == (2, 1, 1) and trades_counted(misty, ash) == (counted, ending)
    assert ending == {trades[name]['id'] for name in ENDED}
    ok(remove(misty, ash))
    assert {trade_id for kind, trade_id, _ in trade_cancels(ash) if kind == 'cancelled'} == ending
    # Afterwards only the Trade that stays is counted.
    assert trades_counted(ash, misty) == ((0, 0, 1), set())


def test_a_deleted_account_leaves_its_name_and_the_remaining_side_confirms_alone(store):
    ids, ash, misty, binder, box, trades = trades_between()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    assert trade_picks(trades['reverse']['id']) == [('proposer', ash, box, 1)]
    # Account deletion is not built yet (spec, "Account deletion"): the owner row goes by SQL.
    with connect() as conn:
        conn.execute('DELETE FROM inventory_owner WHERE user_id=%s', (ash,))
    for name, (proposer, recipient) in {'half': (misty, None), 'reverse': (None, misty)}.items():
        row = row_of(trades[name])
        assert (row['proposer_id'], row['recipient_id'], row['proposer_name'], row['recipient_name']) == (
            proposer, recipient, 'Misty W.' if proposer else 'Ash K.', 'Misty W.' if recipient else 'Ash K.'), name
    # Ash's picks went with his account; Misty's stay.
    assert trade_picks(trades['reverse']['id']) == []
    assert trade_picks(trades['half']['id']) == [('proposer', misty, binder, 1)]
    half = ok(read(misty, trades['half']))
    assert half['other'] == {'collector_id': None, 'display_name': 'Ash K.', 'handle': None,
                             'open_to_cash_offers': False}
    assert half['actions'] == ['confirm_swap', 'use_suggested_picks']
    done = ok(confirm(misty, trades['half']))
    assert (done['closed_reason'], done['other']['collector_id']) == ('swapped', None)
    assert held(misty, unsorted(misty)) == {arven: '1'} and reserved(misty, iono) == (2, 2)


# The same seam, real PostgreSQL: Ash's id sorts first. The step is Ash's accept or Confirm swap of Misty's swap, or
# Misty's send of one; the other collector ends the friendship. The command that goes first sleeps holding its locks:
# a step while it writes a pick (an accept or a send inserting one, a confirm deleting its own), the unfriend or Block
# while it deletes the friendship row, after it cancelled the Trades.

def _race_setup(step_name):
    ids = seed_swap_catalog()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    ash, misty = pair(ordered=True)
    binder, box = place(misty, 'Trade Binder'), place(ash, 'Box')
    hold(misty, binder, iono, 2)
    hold(ash, box, arven, 2)
    ok(mark(misty, binder))
    ok(mark(ash, box))
    trade = None
    if step_name == 'accept':
        trade = proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)])
    elif step_name == 'confirm':
        trade = ok(accept_trade(ash, proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)])))
    return ids, ash, misty, binder, box, trade


@pytest.mark.parametrize('action', ['remove', 'block'])
@pytest.mark.parametrize('first', ['step', 'end'])
@pytest.mark.parametrize('step_name', ['accept', 'confirm', 'send'])
def test_ending_a_friendship_and_a_trade_step_of_the_pair_run_one_after_the_other(store, step_name, first, action):
    ids, ash, misty, binder, box, trade = _race_setup(step_name)
    iono, arven = ids['PAL 185'], ids['SVI 166']
    stepper, ender = (misty, ash) if step_name == 'send' else (ash, misty)
    revision = trade['revision'] if trade else None
    steps = {'accept': lambda: accept_trade(ash, trade, revision=revision),
             'confirm': lambda: confirm(ash, trade, revision=revision),
             'send': lambda: propose(misty, ash, give=[(iono, 1)], get=[(arven, 1)])}
    before = {owner: revision_of(owner) for owner in (ash, misty)}
    if first == 'step':
        held_ = _sleeping('trade_pick', 'DELETE' if step_name == 'confirm' else 'INSERT',
                          f"{'OLD' if step_name == 'confirm' else 'NEW'}.owner_id = '{stepper}'")
    else:
        held_ = _sleeping('friendship', 'DELETE', f"OLD.user_low = '{ash}'")
    run = {'step': steps[step_name], 'end': lambda: end(action, ender, stepper)}
    second = 'end' if first == 'step' else 'step'
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            winner = executor.submit(run[first])
            _asleep(watch, 1, [winner])
            loser = executor.submit(run[second])
            _waiting_on_a_row(watch, [winner, loser])
            results = {first: winner.result(), second: loser.result()}
    finally:
        held_()
    assert ok(results['end'])['relation'] == ('none' if action == 'remove' else 'blocked')
    stepped = results['step']
    with connect() as conn:
        rows = conn.execute('SELECT * FROM trade WHERE proposer_id = ANY(%(pair)s) AND recipient_id = ANY(%(pair)s)',
                            {'pair': [ash, misty]}).fetchall()
    if first == 'step':
        assert stepped.status_code == (201 if step_name == 'send' else 200), stepped.text
        [row] = rows
        if step_name == 'confirm':
            # Ash confirmed first: the Trade stays open for Misty to finish alone.
            assert (row['state'], row['recipient_swap_at'] is not None) == ('accepted', True)
            assert trade_picks(row['id']) == [('proposer', misty, binder, 1)]
            assert held(ash, box) == {arven: '1'} and held(ash, unsorted(ash)) == {iono: '1'}
            assert revision_of(ash) == before[ash] + 1 and revision_of(misty) == before[misty]
            assert ok(confirm(misty, row))['closed_reason'] == 'swapped'
        else:
            # The accepted Trade, or the new proposal, is then cancelled by the unfriend or Block.
            assert (row['state'], row['closed_reason'], row['closed_by']) == ('closed', 'cancelled', ender)
            assert trade_picks(row['id']) == [] and reserved(misty, iono) == (0, 0) and reserved(ash, arven) == (0, 0)
            # The step moved its collector's revision; the cancel moved each side's that it released.
            if step_name == 'accept':
                assert revision_of(ash) == before[ash] + 2 and revision_of(misty) == before[misty] + 1
            else:
                assert revision_of(misty) == before[misty] + 2 and revision_of(ash) == before[ash]
    else:
        if step_name == 'send':
            # No Trade is sent once the friendship is gone.
            assert detail(stepped) == (409, {'code': 'NOT_FRIENDS'}) and rows == []
            assert revision_of(misty) == before[misty] and reserved(misty, iono) == (0, 0)
        else:
            # The step read the Trade before the unfriend or Block cancelled it: its revision moved on. Read again,
            # nothing is left to do.
            assert detail(stepped) == (409, {'code': 'TRADE_CHANGED'})
            [row] = rows
            assert (row['state'], row['closed_reason'], row['closed_by']) == ('closed', 'cancelled', misty)
            assert trade_picks(row['id']) == [] and reserved(misty, iono) == (0, 0) and reserved(ash, arven) == (0, 0)
            assert held(ash, box) == {arven: '2'}
            fresh = ok(read(ash, trade))['revision']
            retried = accept_trade(ash, trade, revision=fresh) if step_name == 'accept' else confirm(ash, trade)
            assert detail(retried) == (409, {'code': 'STEP_NOT_ALLOWED'})
