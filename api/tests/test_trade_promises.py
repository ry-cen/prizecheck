"""What open Trades promise, held to the same invariant as Loans (Trading #268, spec "The shared promise invariant",
ADR 0015), against real PostgreSQL.

A copy a Trade promises is protected as a copy a Loan promises: it is not a Spare Copy and sits at its pick, it can't be
lent, removed, undone away or reassigned (409 PROMISED_TO_TRADE, and PROMISED_TO_LOAN still when only Loans promise),
and Moves stay free but make its pick out of date. Loan and Trade picks share one placement order, so a Lend Offer or a
Loan accept never picks copies a Trade covers, and the other way round, and with no Trades the order is today's. Deck
deletion and leaf conversion carry Trade picks; a deleted pick source becomes NULL; account deletion keeps both names.
Migration 142's deferred triggers on ``trade`` and ``trade_line`` are the backstop for any other write.

No route creates a Trade yet (#269 onward), so the tests seed Trade rows directly, under the givers' owner locks as the
Trade steps will (``owners.lock_owners``), and take every other step through signed HTTP.
"""
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from app.main import connect  # noqa: F401
from app.loan_inventory import replacement_picks
from app.loan_picks import pick_shortfalls, stale_pick_loans
from app.social import counts
from app.social.owners import lock_owners
from test_batch_add import batch, undo, undo_records
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import deck, detail, hold, line
from test_friend_copies import befriend, collector, copies, node, ok, place
from test_handover import code, handover
from test_holdings import call
from test_lend_offers import offer
from test_loan_promises import _hold_pick_insert, _waiting_on_a_row, holding, remove
from test_loans import accept, pair, send, sent, side, view
from test_moves import commit, selected, stage, start
from test_reassign_loans import editions, reassign
from want_list_swap_fixtures import seed_swap_catalog


def insert_trade(conn, proposer, recipient, gives=(), gets=(), picks=(), state='proposed', closed_reason=None,
                 created_at=None, accepted_at=None, proposer_swap_at=None, recipient_swap_at=None):
    """Writes one Trade row, its lines and its picks on ``conn``, as the Trade steps will (#269). ``gives``: (Edition,
    copies) the proposer gives; ``gets``: what the recipient gives; ``picks``: (side, owner, Location id or None,
    Edition, copies). An accepted row is accepted now unless ``accepted_at`` says when. Returns the Trade id."""
    trade_id = uuid4()
    names = {row['user_id']: row['display_name'] for row in conn.execute(
        'SELECT user_id, display_name FROM collector_profile WHERE user_id = ANY(%s)', ([proposer, recipient],))}
    if accepted_at is None and state != 'proposed':
        accepted_at = datetime.now(timezone.utc)
    conn.execute("""INSERT INTO trade(id, state, closed_reason, proposer_id, recipient_id, proposer_name, recipient_name,
        created_at, accepted_at, proposer_swap_at, recipient_swap_at)
      VALUES (%s, %s, %s, %s, %s, %s, %s, coalesce(%s, now()), %s, %s, %s)""",
                 (trade_id, state, closed_reason, proposer, recipient, names[proposer], names[recipient], created_at,
                  accepted_at, proposer_swap_at, recipient_swap_at))
    for side_name, lines in (('proposer', gives), ('recipient', gets)):
        for position, (edition, count) in enumerate(lines):
            conn.execute('INSERT INTO trade_line(trade_id, side, edition_id, position, quantity) VALUES (%s,%s,%s,%s,%s)',
                         (trade_id, side_name, edition, position, count))
    for side_name, owner, location, edition, count in picks:
        conn.execute("""INSERT INTO trade_pick(trade_id, side, owner_id, edition_id, source_location_id, quantity)
          VALUES (%s, %s, %s, %s, %s, %s)""", (trade_id, side_name, owner, edition, location, count))
    return trade_id


def seed_trade(proposer, recipient, **rows):
    """``insert_trade`` in its own transaction, under both collectors' owner locks, committed."""
    with connect() as conn, conn.transaction():
        lock_owners(conn, proposer, recipient)
        return insert_trade(conn, proposer, recipient, **rows)


def write(statement, args=()):
    """One direct write, committed."""
    with connect() as conn:
        conn.execute(statement, args)


def close(trade_id, reason='cancelled'):
    """Closes a Trade as ``social.trades.close_trade`` will (#269): its picks are deleted with it."""
    with connect() as conn, conn.transaction():
        conn.execute('DELETE FROM trade_pick WHERE trade_id=%s', (trade_id,))
        conn.execute("UPDATE trade SET state='closed', closed_reason=%s, closed_at=now() WHERE id=%s",
                     (reason, trade_id))


def by_str(found: dict) -> dict:
    return {str(key): value for key, value in found.items()}


def reserved(owner, edition):
    """(reserved_counts, trade_reserved_counts) of one Edition."""
    with connect() as conn:
        return (counts.reserved_counts(conn, owner, [edition]).get(UUID(edition), 0),
                counts.trade_reserved_counts(conn, owner, [edition]).get(UUID(edition), 0))


def trade_picks(trade_id):
    """The Trade's picks as sorted (side, owner, source Location id or None, copies)."""
    with connect() as conn:
        return sorted((row['side'], row['owner_id'], str(row['source_location_id']) if row['source_location_id'] else None,
                       int(row['quantity'])) for row in conn.execute(
            'SELECT side, owner_id, source_location_id, quantity FROM trade_pick WHERE trade_id=%s', (trade_id,)))


def pick_id(trade_id):
    with connect() as conn:
        return conn.execute('SELECT id FROM trade_pick WHERE trade_id=%s', (trade_id,)).fetchone()['id']


def shortfalls(owner, edition):
    """``pick_shortfalls`` for one Edition: (copies short by pick id, copies covered as {Location id: copies})."""
    with connect() as conn:
        _, short, covered = pick_shortfalls(conn, owner, [UUID(edition)])
    return short, by_str(covered.get(UUID(edition), {}))


def loan_pick_ids(loan):
    with connect() as conn:
        return [row['id'] for row in conn.execute('SELECT id FROM loan_pick WHERE loan_id=%s', (loan['id'],))]


def move(owner, source, destination, edition, count):
    manifest = start(owner, source)
    assert stage(owner, manifest, [selected(edition, count, holding(owner, source, edition)['version'])]).status_code == 200
    assert commit(owner, manifest, destination).status_code == 200


def violates(*statements):
    """Runs the statements in one transaction and asserts its commit fails on the promise invariant."""
    with pytest.raises(psycopg.errors.CheckViolation) as refused:
        with psycopg.connect(os.environ['DATABASE_URL']) as conn:
            for statement, args in statements:
                conn.execute(statement, args)
    assert refused.value.diag.constraint_name == 'loan_promises_owned'
    assert refused.value.diag.message_primary.startswith('Open Loans and Trades promise ')


def test_reserved_counts_sum_loan_and_trade_promises_and_count_only_a_side_that_reserves(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    binder = place(misty, 'Binder')
    hold(misty, binder, iono, 4)
    box = place(ash, 'Box')
    hold(ash, box, arven, 2)
    ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))
    trade = seed_trade(misty, ash, gives=[(iono, 2)], gets=[(arven, 2)], picks=[('proposer', misty, binder, iono, 2)])
    with connect() as conn:
        assert by_str(counts.reserved_counts(conn, misty, [iono, arven])) == {iono: 3}
        assert by_str(counts.trade_reserved_counts(conn, misty, [iono, arven])) == {iono: 2}
        assert {(owner, str(edition)): count for (owner, edition), count in
                counts.reserved_by_owner(conn, [misty, ash]).items()} == {(misty, iono): 3}
        assert {str(edition): by_str(found) for edition, found in
                counts.reserved_picks(conn, misty, [iono]).items()} == {iono: {binder: 3}}
        # The recipient's lines reserve nothing until they accept.
        assert counts.reserved_counts(conn, ash, [arven]) == {} and counts.trade_reserved_counts(conn, ash, [arven]) == {}
    # Accepted: the recipient's lines reserve too, at their picks.
    with connect() as conn, conn.transaction():
        lock_owners(conn, misty, ash)
        conn.execute("UPDATE trade SET state='accepted', accepted_at=now() WHERE id=%s", (trade,))
        conn.execute("""INSERT INTO trade_pick(trade_id, side, owner_id, edition_id, source_location_id, quantity)
          VALUES (%s, 'recipient', %s, %s, %s, 2)""", (trade, ash, arven, box))
    assert reserved(ash, arven) == (2, 2)
    with connect() as conn:
        assert {str(edition): by_str(found) for edition, found in
                counts.reserved_picks(conn, ash, [arven]).items()} == {arven: {box: 2}}
    # Each side's reservation ends at its own swap time; the other side's stays.
    write('UPDATE trade SET proposer_swap_at=now() WHERE id=%s', (trade,))
    assert reserved(misty, iono) == (1, 0) and reserved(ash, arven) == (2, 2)
    write("UPDATE trade SET recipient_swap_at=now(), state='closed', closed_reason='swapped' WHERE id=%s", (trade,))
    assert reserved(ash, arven) == (0, 0)
    # A closed Trade reserves nothing on either side.
    other = seed_trade(misty, ash, gives=[(iono, 1)], picks=[('proposer', misty, binder, iono, 1)])
    assert reserved(misty, iono) == (2, 1)
    close(other)
    assert reserved(misty, iono) == (1, 0)


def test_a_trade_promised_copy_stops_being_spare_and_is_placed_at_its_pick(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    a, b = place(misty, 'Binder A'), place(misty, 'Binder B')
    hold(misty, a, iono, 1)
    hold(misty, b, iono, 1)
    gardevoir = deck(misty, 'Gardevoir ex', 0)
    line(misty, gardevoir, iono, 1)

    def suggested():
        [row] = ok(call('GET', f'/api/decks/{gardevoir}/pick-list', misty))['rows']
        return {source['location_id']: source['suggested'] for source in row['sources']}

    assert suggested() == {a: '1', b: '0'} and detail(misty, gardevoir)['to_get'] == '0'
    # Promised from Binder B: the promised copy is Binder B's, so Gather still suggests Binder A's.
    first = seed_trade(misty, ash, gives=[(iono, 1)], picks=[('proposer', misty, b, iono, 1)])
    assert suggested() == {a: '1', b: '0'} and detail(misty, gardevoir)['to_get'] == '0'
    close(first)
    # Promised from Binder A: Gather suggests Binder B's instead.
    seed_trade(misty, ash, gives=[(iono, 1)], picks=[('proposer', misty, a, iono, 1)])
    assert suggested() == {a: '0', b: '1'} and detail(misty, gardevoir)['to_get'] == '0'
    # Both copies promised: neither is a Spare Copy, and the Deck needs its copy.
    seed_trade(misty, ash, gives=[(iono, 1)], picks=[('proposer', misty, b, iono, 1)])
    assert detail(misty, gardevoir)['to_get'] == '1'


def test_a_trade_promised_copy_is_not_lendable_and_a_loan_never_picks_copies_a_trade_covers(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    a, b = place(misty, 'Binder A'), place(misty, 'Binder B')
    hold(misty, a, iono, 2)
    hold(misty, b, iono, 1)
    seed_trade(misty, ash, gives=[(iono, 2)], picks=[('proposer', misty, a, iono, 2)])
    # Ash sees only the copy no Trade promises, and can ask for no more.
    assert copies(ash, [misty]) == {(misty, iono): (1, 0)}
    refused = send(ash, misty, [(iono, 2)])
    assert (refused.status_code, refused.json()['detail']) == (
        409, {'code': 'NOT_LENDABLE', 'edition_id': iono, 'available': '1'})
    # A Lend Offer can't select the copies the Trade picked.
    refused = offer(misty, ash, [(a, iono, 1)])
    assert (refused.status_code, refused.json()['detail']) == (
        409, {'code': 'NOT_ENOUGH_COPIES', 'edition_id': iono, 'available': '0'})
    # Accepting a request picks Binder B's copy, never Binder A's larger Holding the Trade covers.
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))
    assert [(pick['location_id'], pick['copies']) for pick in side(misty, loan)['picks']] == [(b, '1')]
    # Everything is promised now.
    assert code(offer(misty, ash, [(b, iono, 1)])) == (409, 'NOT_ENOUGH_COPIES')
    assert reserved(misty, iono) == (3, 2)


def test_removal_and_add_undo_refuse_copies_a_trade_promises_and_say_a_loan_when_only_loans_promise(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    binder = place(misty, 'Binder')
    hold(misty, binder, iono, 4)
    ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))
    trade = seed_trade(misty, ash, gives=[(iono, 2)], picks=[('proposer', misty, binder, iono, 2)])
    # Removal: the detail counts every promised copy, Loans and Trades together.
    refused = remove(misty, binder, iono, 2)
    assert (refused.status_code, refused.json()['detail']) == (
        409, {'code': 'PROMISED_TO_TRADE', 'edition_id': iono, 'promised': '3'})
    assert holding(misty, binder, iono)['quantity'] == '4'
    assert remove(misty, binder, iono, 1).status_code == 200
    # With the Trade closed only the Loan promises, and the refusal says so.
    close(trade)
    assert remove(misty, binder, iono, 3).json()['detail'] == {
        'code': 'PROMISED_TO_LOAN', 'edition_id': iono, 'promised': '1'}
    # Undo of an add.
    box = place(misty, 'Box')
    added = ok(batch(misty, box, [(arven, '2')]))
    seed_trade(misty, ash, gives=[(arven, 1)], picks=[('proposer', misty, box, arven, 1)])
    [record] = [entry for entry in undo_records(misty) if entry['id'] == added['undo_id']]
    refused = undo(misty, record['id'])
    assert (refused.status_code, refused.json()['detail']['code']) == (409, 'PROMISED_TO_TRADE')
    assert holding(misty, box, arven)['quantity'] == '2'


def test_edition_reassignment_refuses_copies_a_trade_promises(store):
    ash, misty = pair()
    iono, fixed = editions()
    binder = place(misty, 'Binder')
    hold(misty, binder, iono, 2)
    seed_trade(misty, ash, gives=[(iono, 2)], picks=[('proposer', misty, binder, iono, 2)])
    refused = reassign(misty, binder, iono, fixed, 1)
    assert (refused.status_code, refused.json()['detail']) == (
        409, {'code': 'PROMISED_TO_TRADE', 'edition_id': iono, 'promised': '2'})
    assert holding(misty, binder, iono)['quantity'] == '2'


def test_moves_are_free_and_make_a_trade_pick_out_of_date(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    binder, box = place(misty, 'Binder'), place(misty, 'Box')
    hold(misty, binder, iono, 2)
    trade = seed_trade(misty, ash, gives=[(iono, 2)], picks=[('proposer', misty, binder, iono, 2)])
    assert shortfalls(misty, iono) == ({pick_id(trade): 0}, {binder: 2})
    move(misty, binder, box, iono, 1)
    assert shortfalls(misty, iono) == ({pick_id(trade): 1}, {binder: 1})
    # A Location doesn't matter to a promise: the moved copy is still promised.
    assert remove(misty, box, iono, 1).json()['detail']['code'] == 'PROMISED_TO_TRADE'


def test_loan_and_trade_picks_share_one_order_oldest_accepted_first_unaccepted_last(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    binder, box = place(misty, 'Binder'), place(misty, 'Box')
    hold(misty, binder, iono, 2)
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))
    [loan_pick] = loan_pick_ids(loan)
    trade = seed_trade(misty, ash, gives=[(iono, 1)], picks=[('proposer', misty, binder, iono, 1)])
    move(misty, binder, box, iono, 1)
    # The unanswered proposal sorts after the accepted Loan: the Trade's pick is the one out of date.
    assert shortfalls(misty, iono) == ({loan_pick: 0, pick_id(trade): 1}, {binder: 1})
    with connect() as conn:
        assert stale_pick_loans(conn, misty, [UUID(loan['id'])]) == set()
    # A Trade accepted before the Loan sorts first, and then the Loan's pick is out of date.
    write("UPDATE trade SET state='accepted', accepted_at='2000-01-01T00:00:00Z' WHERE id=%s", (trade,))
    assert shortfalls(misty, iono) == ({pick_id(trade): 0, loan_pick: 1}, {binder: 1})
    with connect() as conn:
        assert stale_pick_loans(conn, misty, [UUID(loan['id'])]) == {UUID(loan['id'])}
    assert code(handover(misty, loan)) == (409, 'PICKS_OUT_OF_DATE')


def test_an_offered_lend_offer_still_yields_to_an_accepted_loan_for_picks(store):
    # With no Trades the pick order is today's (spec "Testing", the pick order): an offered Lend Offer sorts after every
    # accepted Loan, whenever it was created. A single coalesced time would make R2 the stale one.
    ids = seed_swap_catalog()
    ash, misty = pair()
    brock, _ = collector('Brock S.')
    befriend(brock, misty)
    iono = ids['PAL 185']
    b, c = place(misty, 'Binder B'), place(misty, 'Binder C')
    hold(misty, b, iono, 3)
    o1 = ok(offer(misty, ash, [(b, iono, 1)]), 201)
    r2 = ok(accept(misty, view(misty, sent(brock, misty, [(iono, 2)])), [(iono, 2)]))
    assert (o1['state'], r2['state']) == ('offered', 'accepted')
    assert [(pick['location_id'], pick['copies']) for pick in side(misty, r2)['picks']] == [(b, '2')]
    move(misty, b, c, iono, 1)
    with connect() as conn:
        assert stale_pick_loans(conn, misty, [UUID(o1['id']), UUID(r2['id'])]) == {UUID(o1['id'])}
        assert {(str(edition), str(location)): count for (edition, location), count in
                replacement_picks(conn, misty, UUID(o1['id'])).items()} == {(iono, c): 1}
        _, _, covered = pick_shortfalls(conn, misty, [UUID(iono)])
    assert by_str(covered[UUID(iono)]) == {b: 2}
    handed = handover(misty, r2)
    assert handed.status_code == 200, handed.text


def test_a_direct_write_that_breaks_a_trade_promise_fails_at_commit_through_each_trigger(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    brock, _ = collector('Brock S.')
    iono, arven = ids['PAL 185'], ids['SVI 166']
    binder = place(misty, 'Binder')
    hold(misty, binder, iono, 2)
    box = place(ash, 'Box')
    hold(ash, box, arven, 1)
    trade = seed_trade(misty, ash, gives=[(iono, 2)], gets=[(arven, 2)], picks=[('proposer', misty, binder, iono, 2)])
    # The holding trigger (migration 106) sees the Trade's promise.
    violates(('UPDATE holding SET quantity=1 WHERE owner_id=%s AND edition_id=%s', (misty, iono)))
    # trade_line_promise_guard: a line raised while its side reserves.
    violates(("UPDATE trade_line SET quantity=3 WHERE trade_id=%s AND side='proposer'", (trade,)))
    # trade_promise_guard on insert: a new proposal beyond what the proposer holds.
    with pytest.raises(psycopg.errors.CheckViolation) as refused:
        with psycopg.connect(os.environ['DATABASE_URL'], row_factory=dict_row) as conn:
            insert_trade(conn, misty, ash, gives=[(iono, 1)])
    assert refused.value.diag.constraint_name == 'loan_promises_owned'
    # trade_promise_guard on accept: the recipient's lines (2 Arven) above what Ash holds (1).
    violates(("UPDATE trade SET state='accepted', accepted_at=now() WHERE id=%s", (trade,)))
    # trade_promise_guard on an owner change: Brock holds none of Misty's Iono.
    violates(('UPDATE trade SET proposer_id=%s WHERE id=%s', (brock, trade)))
    assert reserved(misty, iono) == (2, 2)
    # A swap: the proposer's swap time set while the copies leave, in one commit, checks nothing ...
    swapped = seed_trade(ash, misty, gives=[(arven, 1)], picks=[('proposer', ash, box, arven, 1)], state='accepted')
    with connect() as conn, conn.transaction():
        conn.execute('UPDATE trade SET proposer_swap_at=now() WHERE id=%s', (swapped,))
        conn.execute("DELETE FROM trade_pick WHERE trade_id=%s AND side='proposer'", (swapped,))
        conn.execute('DELETE FROM holding WHERE owner_id=%s AND edition_id=%s', (ash, arven))
    # ... and a direct write that clears it again, re-reserving copies that are gone, fails at commit.
    violates(('UPDATE trade SET proposer_swap_at=NULL WHERE id=%s', (swapped,)))
    # Closing a row checks nothing.
    write("UPDATE trade SET state='closed', closed_reason='swapped', recipient_swap_at=now() WHERE id=%s", (swapped,))


def test_deck_deletion_and_leaf_conversion_carry_trade_picks_and_a_deleted_source_becomes_null(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    gardevoir = deck(misty, 'Gardevoir', 0)
    hold(misty, gardevoir, iono, 2)
    line(misty, gardevoir, iono, 2)
    in_deck = seed_trade(misty, ash, gives=[(iono, 1)], picks=[('proposer', misty, gardevoir, iono, 1)])
    found = node(misty, gardevoir)
    assert call('DELETE', f'/api/decks/{gardevoir}', misty,
                {'name': found['name'], 'version': found['version'], 'idempotency_key': str(uuid4())}).status_code == 200
    unsorted = node(misty, 'Unsorted')['id']
    assert trade_picks(in_deck) == [('proposer', misty, unsorted, 1)]
    # Leaf conversion: Binder's copies move to its new child, and so does the Trade's pick.
    binder = place(misty, 'Binder')
    hold(misty, binder, iono, 1)
    in_binder = seed_trade(misty, ash, gives=[(iono, 1)], picks=[('proposer', misty, binder, iono, 1)])
    parent = node(misty, binder)
    child = call('POST', '/api/location-tree', misty, {
        'name': 'Page 1', 'parent_id': binder, 'conversion': 'move_holdings_to_child',
        'parent_version': parent['version'], 'idempotency_key': str(uuid4())})
    assert child.status_code == 201, child.text
    assert trade_picks(in_binder) == [('proposer', misty, child.json()['location']['id'], 1)]
    # A Location deleted once its copies moved out: the pick's source becomes NULL and the pick is out of date.
    box = place(misty, 'Box')
    hold(misty, box, iono, 1)
    in_box = seed_trade(misty, ash, gives=[(iono, 1)], picks=[('proposer', misty, box, iono, 1)])
    move(misty, box, unsorted, iono, 1)
    current = node(misty, box)
    deleted = call('DELETE', f'/api/location-tree/{box}', misty,
                   {'name': 'Box', 'version': current['version'], 'idempotency_key': str(uuid4())})
    assert deleted.status_code == 200, deleted.text
    assert trade_picks(in_box) == [('proposer', misty, None, 1)]
    assert shortfalls(misty, iono)[0][pick_id(in_box)] == 1


def test_a_trade_pick_in_a_deck_changes_no_deck_line_label(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    gardevoir = deck(misty, 'Gardevoir', 0)
    hold(misty, gardevoir, iono, 2)
    line(misty, gardevoir, iono, 2)
    seed_trade(misty, ash, gives=[(iono, 1)], picks=[('proposer', misty, gardevoir, iono, 1)])
    # Deck lines show Loan reservations only (Stage 1): the Trade's pick reads nothing.
    assert detail(misty, gardevoir)['loans'] == []
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))
    assert [(pick['location_id'], pick['copies']) for pick in side(misty, loan)['picks']] == [(gardevoir, '1')]
    assert detail(misty, gardevoir)['loans'] == [
        {'edition_id': iono, 'reserved': [{'name': 'Ash K.', 'copies': '1'}], 'lent': [], 'borrowed': []}]


def test_a_trade_outlives_both_accounts_and_keeps_both_names(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    binder, box = place(misty, 'Binder'), place(ash, 'Box')
    hold(misty, binder, iono, 1)
    hold(ash, box, arven, 1)
    trade = seed_trade(misty, ash, gives=[(iono, 1)], gets=[(arven, 1)], state='accepted',
                       picks=[('proposer', misty, binder, iono, 1), ('recipient', ash, box, arven, 1)])
    # A Display Name change reaches the names kept on the Trade.
    ok(call('PUT', '/api/profile/display-name', ash, {'display_name': 'Ash Ketchum', 'idempotency_key': str(uuid4())}))
    write('DELETE FROM inventory_owner WHERE user_id=%s', (misty,))
    assert trade_picks(trade) == [('recipient', ash, box, 1)]
    write('DELETE FROM inventory_owner WHERE user_id=%s', (ash,))
    assert trade_picks(trade) == []
    with connect() as conn:
        row = conn.execute('SELECT proposer_id, recipient_id, proposer_name, recipient_name FROM trade WHERE id=%s',
                           (trade,)).fetchone()
        lines = conn.execute('SELECT count(*) AS n FROM trade_line WHERE trade_id=%s', (trade,)).fetchone()['n']
    assert row == {'proposer_id': None, 'recipient_id': None, 'proposer_name': 'Misty W.', 'recipient_name': 'Ash Ketchum'}
    assert lines == 2


def test_a_loan_accept_waits_for_a_trade_promising_the_same_copies_and_then_finds_none_left(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    binder = place(misty, 'Binder')
    hold(misty, binder, iono, 2)
    loan = view(misty, sent(ash, misty, [(iono, 2)]))
    # The Trade's transaction takes Misty's owner lock first, as a Trade send will, and stays open.
    seeding = psycopg.connect(os.environ['DATABASE_URL'], row_factory=dict_row)
    try:
        lock_owners(seeding, misty, ash)
        insert_trade(seeding, misty, ash, gives=[(iono, 2)], picks=[('proposer', misty, binder, iono, 2)])
        with ThreadPoolExecutor(max_workers=1) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            accepted = executor.submit(accept, misty, loan, [(iono, 2)])
            _waiting_on_a_row(watch, [accepted])
            seeding.commit()
            accepted = accepted.result()
    finally:
        seeding.close()
    # The accept ran after the Trade committed and saw its promise.
    assert (accepted.status_code, accepted.json()['detail']) == (
        409, {'code': 'NOT_ENOUGH_COPIES', 'edition_id': iono, 'available': '0'})
    assert view(misty, loan)['state'] == 'requested'
    assert reserved(misty, iono) == (2, 2)


def test_a_trade_promise_waits_for_a_loan_accept_and_then_fails_at_commit(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    binder = place(misty, 'Binder')
    hold(misty, binder, iono, 2)
    loan = view(misty, sent(ash, misty, [(iono, 2)]))
    held, hold_until = _hold_pick_insert(misty)
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            accepted = executor.submit(accept, misty, loan, [(iono, 2)])
            hold_until(watch, accepted)
            seeding = executor.submit(seed_trade, misty, ash, gives=[(iono, 2)],
                                      picks=[('proposer', misty, binder, iono, 2)])
            _waiting_on_a_row(watch, [accepted, seeding])
            accepted = accepted.result()
            with pytest.raises(psycopg.errors.CheckViolation) as refused:
                seeding.result()
    finally:
        held()
    assert accepted.status_code == 200, accepted.text
    assert refused.value.diag.constraint_name == 'loan_promises_owned'
    # The Trade rolled back whole: only the Loan promises the copies.
    assert reserved(misty, iono) == (2, 0)
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM trade WHERE proposer_id=%s', (misty,)).fetchone()['n'] == 0
