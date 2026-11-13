"""Owner-approved lender-only Deck context: allocated own copies, including loose copies, and remaining need."""
import pytest

from test_catalog_targets import isolated_rules  # noqa: F401
from test_deck_cost import store  # noqa: F401
from test_deck_counting import counting, deck, hold, line
from test_friend_copies import collector, node, ok
from test_holdings import call, client
from test_handover import handover
from test_lend_offers import offer
from test_loans import accept, pair, sent, side, view
from want_list_swap_fixtures import seed_swap_catalog


@pytest.mark.parametrize('held,loose,wanted,allocated,need', [
    (2, 0, 4, '2', '2'), (2, 2, 4, '4', '0'), (0, 2, 4, '2', '2'), (0, 3, 0, '0', '0')])
def test_lender_sees_physical_and_loose_allocated_copies_and_need(store, held, loose, wanted, allocated, need):
    ids = seed_swap_catalog()
    borrower, lender = pair()
    edition = ids['PAL 185']
    location = deck(lender, 'Lender private Deck', 0)
    if held:
        hold(lender, location, edition, held)
    if loose:
        hold(lender, node(lender, 'Unsorted')['id'], edition, loose)
    if wanted:
        line(lender, location, edition, wanted)
    loan = sent(borrower, lender, [(edition, 1)])
    assert side(lender, loan)['deck_use'] == [{'edition_id': edition, 'for_decks': allocated, 'need': need}]
    assert side(borrower, loan)['deck_use'] is None


@pytest.mark.parametrize('setting,need', [('all_at_once', '3'), ('one_at_a_time', '0')])
def test_shared_copies_are_counted_once_and_need_follows_counting(store, setting, need):
    ids = seed_swap_catalog()
    borrower, lender = pair()
    edition = ids['PAL 185']
    first, second = deck(lender, 'First', 0), deck(lender, 'Second', 1)
    hold(lender, first, edition, 1)
    hold(lender, node(lender, 'Unsorted')['id'], edition, 2)
    line(lender, first, edition, 3)
    line(lender, second, edition, 3)
    counting(lender, setting)
    loan = sent(borrower, lender, [(edition, 1)])
    assert side(lender, loan)['deck_use'] == [{'edition_id': edition, 'for_decks': '3', 'need': need}]


def test_every_loan_edition_is_present_and_borrower_state_is_private(store):
    ids = seed_swap_catalog()
    borrower, lender = pair()
    editions = [ids['PAL 185'], ids['SVI 166']]
    for edition in editions:
        hold(lender, node(lender, 'Unsorted')['id'], edition, 3)
    own = deck(lender, 'Private lender Deck', 0)
    line(lender, own, editions[0], 4)
    loan = sent(borrower, lender, [(edition, 1) for edition in editions])
    before = side(lender, loan)
    assert before['deck_use'] == [
        {'edition_id': editions[0], 'for_decks': '3', 'need': '1'},
        {'edition_id': editions[1], 'for_decks': '0', 'need': '0'}]
    secret = deck(borrower, 'Borrower secret Deck', 0)
    line(borrower, secret, editions[0], 99)
    hold(borrower, secret, editions[0], 5)
    assert side(lender, loan) == before
    assert side(borrower, loan)['deck_use'] is None
    stranger, _ = collector()
    assert call('GET', f"/api/loans/{loan['id']}/side", stranger).status_code == 404
    assert client.get(f"/api/loans/{loan['id']}/side").status_code == 401
    assert secret not in str(before) and 'Borrower secret Deck' not in str(before)


def test_lend_offer_context_is_lender_only_and_uses_current_reservations(store):
    ids = seed_swap_catalog()
    borrower, lender = pair()
    edition = ids['PAL 185']
    location = deck(lender, 'Own Deck', 0)
    hold(lender, location, edition, 1)
    loose = node(lender, 'Unsorted')['id']
    hold(lender, loose, edition, 1)
    line(lender, location, edition, 2)
    loan = ok(offer(lender, borrower, [(loose, edition, 1)]), 201)
    # The offered loose copy is now reserved, so it no longer covers a Deck line as a Spare Copy.
    assert side(lender, loan)['deck_use'] == [{'edition_id': edition, 'for_decks': '1', 'need': '1'}]
    assert side(borrower, loan)['deck_use'] is None


def test_already_lent_copies_cover_need_but_are_not_for_decks_held_copies(store):
    ids = seed_swap_catalog()
    borrower, lender = pair()
    edition = ids['PAL 185']
    own = deck(lender, 'Own Deck', 0)
    hold(lender, own, edition, 2)
    outgoing = sent(borrower, lender, [(edition, 1)])
    ok(accept(lender, view(lender, outgoing), [(edition, 1)]))
    ok(handover(lender, outgoing))
    incoming = sent(borrower, lender, [(edition, 1)])
    # One owned copy is still held; the other is lent and still covers its Deck line in the Want List.
    assert side(lender, incoming)['deck_use'] == [{'edition_id': edition, 'for_decks': '1', 'need': '0'}]


def test_borrowed_copies_cover_need_but_are_never_for_decks_own_copies(store):
    ids = seed_swap_catalog()
    borrower, lender = pair()
    edition = ids['PAL 185']
    own = deck(lender, 'Own Deck', 0)
    hold(lender, own, edition, 1)
    line(lender, own, edition, 3)
    hold(borrower, node(borrower, 'Unsorted')['id'], edition, 1)
    borrowed = sent(lender, borrower, [(edition, 1)], deck_id=own)
    ok(accept(borrower, view(borrower, borrowed), [(edition, 1)]))
    ok(handover(borrower, borrowed))
    ok(handover(lender, borrowed))
    incoming = sent(borrower, lender, [(edition, 1)])
    # The lender holds one own copy and one Borrowed Copy against a line of three.
    assert side(lender, incoming)['deck_use'] == [{'edition_id': edition, 'for_decks': '1', 'need': '1'}]
