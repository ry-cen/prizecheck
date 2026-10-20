"""The one listable rule, migration 142's ``trade_listable`` (Trading #268, spec "Listable, one rule"), called through
SQL against real PostgreSQL; the collector's own Trade List and the Friend read that call it arrive in later tickets.

Per owner and Card Edition: the copies held in For trade Locations (never a Deck, even inside one), less the For trade
copies that reserving Loan and Trade picks take there, bounded by every copy held less every copy reserved, and never
below zero. So reserved copies picked from a Deck don't shrink the Trade List, an out-of-date pick never over-lists, a
marked Location inside a marked one lists each copy once, hiding changes nothing, and lent and Borrowed Copies are never
listed. Everything but the reads goes through signed HTTP, apart from the seeded Trade rows.
"""
from uuid import UUID

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import deck, hold, line
from test_for_trade_locations import deck_in, hide, mark
from test_friend_copies import node, ok, place
from test_handover import handover
from test_lend_offers import offer
from test_loans import accept, pair, sent, view
from test_trade_promises import move, seed_trade
from want_list_swap_fixtures import seed_swap_catalog


def listable(owner, editions=None):
    """``trade_listable`` for one owner, as {Edition id: copies}; Editions with none listed are absent."""
    with connect() as conn:
        return {str(row['edition_id']): row['listable'] for row in conn.execute(
            'SELECT edition_id, listable FROM trade_listable(ARRAY[%s]::text[], %s::uuid[])',
            (owner, None if editions is None else [UUID(edition) for edition in editions]))}


def test_for_trade_copies_are_listed_less_the_copies_reserving_picks_take_there_and_hiding_changes_nothing(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    binder = place(misty, 'Trade Binder')
    hold(misty, binder, iono, 3)
    hold(misty, node(misty, 'Unsorted')['id'], iono, 1)
    hold(misty, node(misty, 'Unsorted')['id'], arven, 1)
    assert listable(misty) == {}
    ok(mark(misty, binder))
    assert listable(misty) == {iono: 3} and listable(misty, [arven]) == {}
    # A hidden For trade Location stays on its owner's Trade List.
    hide(misty, binder)
    assert listable(misty) == {iono: 3}
    # A Trade's pick in the For trade Binder takes a copy off; a Lend Offer's pick from Unsorted takes none there.
    seed_trade(misty, ash, gives=[(iono, 1)], picks=[('proposer', misty, binder, iono, 1)])
    assert listable(misty) == {iono: 2}
    ok(offer(misty, ash, [(node(misty, 'Unsorted')['id'], iono, 1)]), 201)
    assert listable(misty) == {iono: 2}
    # Every copy promised: nothing is listed.
    ok(offer(misty, ash, [(binder, iono, 2)]), 201)
    assert listable(misty) == {}


def test_a_reserved_copy_picked_from_a_deck_does_not_shrink_the_trade_list(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    binder = place(misty, 'Trade Binder')
    hold(misty, binder, iono, 2)
    gardevoir = deck(misty, 'Gardevoir', 0)
    hold(misty, gardevoir, iono, 2)
    line(misty, gardevoir, iono, 2)
    ok(mark(misty, binder))
    assert listable(misty) == {iono: 2}
    ok(offer(misty, ash, [(gardevoir, iono, 1)]), 201)
    assert listable(misty) == {iono: 2}
    ok(offer(misty, ash, [(binder, iono, 1)]), 201)
    assert listable(misty) == {iono: 1}


def test_an_out_of_date_pick_never_over_lists(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    binder, box = place(misty, 'Trade Binder'), place(misty, 'Box')
    hold(misty, binder, iono, 2)
    hold(misty, box, iono, 1)
    ok(mark(misty, binder))
    ok(offer(misty, ash, [(box, iono, 1)]), 201)
    assert listable(misty) == {iono: 2}
    # The offered copy moves into the For trade Binder; its pick still names Box. Three are there, one is promised.
    move(misty, box, binder, iono, 1)
    assert listable(misty) == {iono: 2}


def test_a_marked_location_inside_a_marked_one_lists_each_copy_once_and_a_deck_inside_is_never_listed(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    box = place(misty, 'Trade Box')
    binder = place(misty, 'Trade Binder', 'Trade Box')
    hold(misty, binder, iono, 2)
    gardevoir = deck_in(misty, 'Gardevoir', box)
    hold(misty, gardevoir, arven, 2)
    ok(mark(misty, binder))
    ok(mark(misty, box))
    assert listable(misty) == {iono: 2}
    assert node(misty, gardevoir)['for_trade'] is False


def test_lent_and_borrowed_copies_are_never_listed(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    binder = place(misty, 'Trade Binder')
    hold(misty, binder, iono, 2)
    ok(mark(misty, binder))
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))
    assert listable(misty) == {iono: 1}
    # Handed over: the lent copy is in no Holding, and nothing is reserved any more.
    assert handover(misty, loan).status_code == 200
    assert listable(misty) == {iono: 1}
    # Ash's Borrowed Copy sits in his For trade Unsorted and is never listed.
    unsorted = node(ash, 'Unsorted')['id']
    ok(mark(ash, unsorted))
    assert handover(ash, loan).status_code == 200
    assert listable(ash) == {}
