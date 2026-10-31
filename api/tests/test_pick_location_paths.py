"""Full Location paths on the Gather, Loan and Trade pickers: each source or pick names its Location's whole path
("Shelf / Binder A / Page 1") as well as its leaf ``name``, because Location names are unique only among siblings.
Paths are read for the reader's own Locations only; the other side of a Loan or Trade never sees one.

Through signed HTTP against PostgreSQL."""
from uuid import uuid4

from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import deck, hold
from test_deck_lists import put_line
from test_deck_pick_list import pick_list, rows
from test_for_trade_locations import mark
from test_friend_copies import node, ok, place
from test_holdings import add, call, fixture
from test_loans import accept, pair, sent, side as loan_side, view
from test_trade_promises import move
from test_trades import accept_trade, proposed
from want_list_swap_fixtures import seed_swap_catalog


def binders(owner, root):
    """``root`` / Binder A / Page 1 and ``root`` / Binder B / Page 1: two Storage Leaves with the same leaf name.
    Returns (root id, Binder A's Page 1, Binder B's Page 1)."""
    top = place(owner, root)
    first, second = place(owner, 'Binder A', top), place(owner, 'Binder B', top)
    return top, place(owner, 'Page 1', first), place(owner, 'Page 1', second)


def test_gather_sources_name_full_paths_for_same_named_deep_and_root_locations():
    owner, _, unsorted, _, edition, _ = fixture()
    target = deck(owner, 'Target', 0)
    _, page_a, page_b = binders(owner, 'Shelf')
    deep = place(owner, 'Row 1', place(owner, 'Tray', place(owner, 'Box', place(owner, 'Closet'))))
    other = deck(owner, 'Spare', 0)
    for location, copies in ((page_a, '3'), (page_b, '2'), (deep, '1'), (unsorted, '1'), (other, '1')):
        ok(add(owner, location, edition, copies))
    put_line(owner, target, edition, '8')
    sources = {source['location_id']: source for source in rows(pick_list(owner, target))[edition]['sources']}
    assert {location: (source['name'], source['path']) for location, source in sources.items()} == {
        page_a: ('Page 1', 'Shelf / Binder A / Page 1'),
        page_b: ('Page 1', 'Shelf / Binder B / Page 1'),
        deep: ('Row 1', 'Closet / Box / Tray / Row 1'),
        # A root Storage Leaf and a root Deck: the path is the name.
        unsorted: (node(owner, unsorted)['name'], node(owner, unsorted)['name']),
        other: (node(owner, other)['name'], node(owner, other)['name']),
    }
    # The path is display only: the ids, kinds and versions a confirmation sends back are unchanged.
    assert sources[other]['kind'] == 'deck' and sources[page_a]['kind'] == 'storage_leaf'


def test_loan_picks_name_full_paths_only_on_the_lenders_own_side(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    _, page_a, page_b = binders(misty, 'Misty Secret Shelf')
    hold(misty, page_a, iono, 1)
    hold(misty, page_b, iono, 3)
    hold(misty, node(misty, 'Unsorted')['id'], iono, 1)
    loan = sent(ash, misty, [(iono, 5)])
    ok(accept(misty, view(misty, loan), [(iono, 5)]))
    picks = loan_side(misty, loan)['picks']
    assert [(pick['location_id'], pick['name'], pick['path'], pick['copies']) for pick in picks] == [
        (page_b, 'Page 1', 'Misty Secret Shelf / Binder B / Page 1', '3'),
        (page_a, 'Page 1', 'Misty Secret Shelf / Binder A / Page 1', '1'),
        (node(misty, 'Unsorted')['id'], 'Unsorted', 'Unsorted', '1'),
    ]
    # The borrower's side names none of the lender's Locations, by leaf or by path.
    seen = ' '.join(call('GET', path, ash).text for path in (
        '/api/social/loans', f"/api/social/loans/{loan['id']}", f"/api/loans/{loan['id']}/side"))
    for secret in ('Misty Secret Shelf', 'Binder A', 'Binder B', page_a, page_b):
        assert secret not in seen, secret


def test_trade_picks_name_full_paths_only_on_the_givers_own_side(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    top, page_a, page_b = binders(misty, 'Misty Trade Shelf')
    hold(misty, page_a, iono, 2)
    hold(misty, page_b, iono, 1)
    ok(mark(misty, top))
    trade = ok(accept_trade(ash, proposed(misty, ash, give=[(iono, 3)])))
    picks = ok(call('GET', f"/api/trades/{trade['id']}/side", misty))['picks']
    assert [(pick['location_id'], pick['name'], pick['path'], pick['copies']) for pick in picks] == [
        (page_a, 'Page 1', 'Misty Trade Shelf / Binder A / Page 1', '2'),
        (page_b, 'Page 1', 'Misty Trade Shelf / Binder B / Page 1', '1'),
    ]
    seen = ' '.join(call('GET', path, ash).text for path in (
        f"/api/social/trades/{trade['id']}", f"/api/trades/{trade['id']}/side"))
    for secret in ('Misty Trade Shelf', 'Binder A', 'Binder B', page_a, page_b):
        assert secret not in seen, secret


def test_a_pick_whose_location_was_deleted_reads_unsorted_as_its_path(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    _, page_a, _ = binders(misty, 'Shelf')
    hold(misty, page_a, iono, 1)
    loan = sent(ash, misty, [(iono, 1)])
    ok(accept(misty, view(misty, loan), [(iono, 1)]))
    # Its copy moves out, then the Location goes: the pick's source becomes NULL and reads as Unsorted.
    move(misty, page_a, node(misty, 'Unsorted')['id'], iono, 1)
    current = node(misty, page_a)
    deleted = call('DELETE', f'/api/location-tree/{page_a}', misty,
                   {'name': 'Page 1', 'version': current['version'], 'idempotency_key': str(uuid4())})
    assert deleted.status_code == 200, deleted.text
    picks = loan_side(misty, loan)['picks']
    assert [(pick['location_id'], pick['name'], pick['path']) for pick in picks] == [(None, 'Unsorted', 'Unsorted')]
