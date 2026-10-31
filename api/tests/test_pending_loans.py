"""What a borrower's Deck is waiting on from Friends (``GET /api/loans/pending?deck=``, want list pending loans), through
signed HTTP against PostgreSQL.

Per card the Deck's Deck List names: copies asked for in Borrow Requests nobody has answered (``requested``), and copies
promised, by an accepted Borrow Request or a Lend Offer taken for this Deck, that the borrower hasn't confirmed receiving
(``accepted``, ``promised - written_off``), each with the lender's Display Name. It is information only: the Want List,
its revisions and the owner revision never move for it. Only the borrower reads it, for one of their own Decks.

Misty W. lends to Ash K. (``test_loans.pair``); Brock S. is a second lender. Iono PAL 185 and Arven SVI 166 come from
the Swap catalog.
"""
from uuid import uuid4

from app.main import connect  # noqa: F401
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import deck, hold, line
from test_ending_friendship import remove
from test_friend_copies import befriend, block, collector, node, ok, place
from test_handover import handover, take_back
from test_holdings import call
from test_lend_offers import offer, take
from test_loans import accept, pair, revision_of, send, sent, step, view
from test_write_off import write_off
from want_list_swap_fixtures import seed_swap_catalog


def pending(user, deck_id):
    return call('GET', f'/api/loans/pending?deck={deck_id}', user)


def waiting(user, deck_id):
    """{Edition id: (requested, accepted, [(lender, state, copies), ...])}."""
    body = ok(pending(user, deck_id))
    assert body['deck_id'] == deck_id
    return {entry['edition_id']: (entry['requested'], entry['accepted'],
                                  [(who['lender'], who['state'], who['copies']) for who in entry['lenders']])
            for entry in body['lines']}


def want_list(user, deck_id):
    return ok(call('GET', f'/api/want-list?deck={deck_id}', user))


def lending(copies=3, deck_line=4):
    """Misty holds ``copies`` Iono in a Binder; Ash's Deck lists ``deck_line`` of them and holds none."""
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    hold(misty, place(misty, 'Binder'), iono, copies)
    charizard = deck(ash, 'Charizard', 0)
    line(ash, charizard, iono, deck_line)
    return ids, iono, ash, misty, charizard


def named(user, name):
    ok(call('PUT', '/api/profile/display-name', user, {'display_name': name, 'idempotency_key': str(uuid4())}))


def test_a_request_shows_as_asked_for_and_changes_nothing_the_want_list_counts(store):
    _, iono, ash, misty, charizard = lending()
    before, revision = want_list(ash, charizard), revision_of(ash)
    assert waiting(ash, charizard) == {}
    sent(ash, misty, [(iono, 3)], deck_id=charizard)
    assert waiting(ash, charizard) == {iono: ('3', '0', [('Misty W.', 'requested', '3')])}
    # Need, to-get, the revisions and the digest are exactly what they were.
    assert want_list(ash, charizard) == before and revision_of(ash) == revision


def test_a_partial_accept_shows_only_the_promise_and_a_line_left_out_shows_nothing(store):
    ids, iono, ash, misty, charizard = lending()
    arven = ids['SVI 166']
    hold(misty, node(misty, 'Binder')['id'], arven, 1)
    line(ash, charizard, arven, 1)
    loan = sent(ash, misty, [(iono, 3), (arven, 1)], deck_id=charizard)
    ok(accept(misty, view(misty, loan), [(iono, 1), (arven, 0)]))
    assert waiting(ash, charizard) == {iono: ('0', '1', [('Misty W.', 'accepted', '1')])}


def test_decline_withdraw_cancel_and_edit_and_resend_take_the_old_request_away(store):
    _, iono, ash, misty, charizard = lending()
    declined = sent(ash, misty, [(iono, 1)], deck_id=charizard)
    ok(step(misty, view(misty, declined), 'decline'))
    withdrawn = sent(ash, misty, [(iono, 1)], deck_id=charizard)
    ok(step(ash, view(ash, withdrawn), 'withdraw'))
    cancelled = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)], deck_id=charizard)), [(iono, 1)]))
    ok(step(ash, view(ash, cancelled), 'cancel'))
    assert waiting(ash, charizard) == {}
    earlier = sent(ash, misty, [(iono, 1)], deck_id=charizard)
    sent(ash, misty, [(iono, 2)], deck_id=charizard, replaces=earlier['id'])
    assert waiting(ash, charizard) == {iono: ('2', '0', [('Misty W.', 'requested', '2')])}


def test_receiving_the_copies_ends_the_wait_and_a_take_back_restores_it(store):
    _, iono, ash, misty, charizard = lending()
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 2)], deck_id=charizard)), [(iono, 2)]))
    ok(handover(misty, loan))
    # The lender's confirmation alone moves nothing into Ash's Deck: the copies are still on their way.
    assert waiting(ash, charizard) == {iono: ('0', '2', [('Misty W.', 'accepted', '2')])}
    received = ok(handover(ash, loan))
    assert received['state'] == 'handed_over'
    assert waiting(ash, charizard) == {}
    assert next(entry for entry in want_list(ash, charizard)['sections'][0]['lines']
                if entry['edition_id'] == iono)['borrowed'] == '2'


def test_a_borrowers_take_back_puts_the_promise_back(store):
    _, iono, ash, misty, charizard = lending()
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 2)], deck_id=charizard)), [(iono, 2)]))
    ok(handover(ash, loan))
    assert waiting(ash, charizard) == {}
    ok(take_back(ash, loan))
    assert waiting(ash, charizard) == {iono: ('0', '2', [('Misty W.', 'accepted', '2')])}


def test_a_write_off_before_the_borrower_received_lowers_what_is_on_its_way(store):
    _, iono, ash, misty, charizard = lending()
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 3)], deck_id=charizard)), [(iono, 3)]))
    ok(handover(misty, loan))
    ok(write_off(misty, loan, [(iono, 1)]))
    assert waiting(ash, charizard) == {iono: ('0', '2', [('Misty W.', 'accepted', '2')])}
    ok(write_off(misty, loan, [(iono, 2)]))
    assert waiting(ash, charizard) == {}


def test_a_lend_offer_counts_once_taken_for_the_deck_and_never_while_unanswered_or_for_unsorted(store):
    _, iono, ash, misty, charizard = lending()
    binder = node(misty, 'Binder')['id']
    first = ok(offer(misty, ash, [(binder, iono, 1)]), 201)
    assert waiting(ash, charizard) == {}
    ok(take(ash, first, [(iono, 1)], deck_id=charizard))
    assert waiting(ash, charizard) == {iono: ('0', '1', [('Misty W.', 'accepted', '1')])}
    second = ok(offer(misty, ash, [(binder, iono, 1)]), 201)
    ok(take(ash, second, [(iono, 1)]))
    assert waiting(ash, charizard) == {iono: ('0', '1', [('Misty W.', 'accepted', '1')])}


def test_unsorted_a_deleted_deck_and_a_card_the_deck_list_doesnt_name_show_nothing(store):
    ids, iono, ash, misty, charizard = lending()
    arven = ids['SVI 166']
    hold(misty, node(misty, 'Binder')['id'], arven, 1)
    sent(ash, misty, [(iono, 1)])
    sent(ash, misty, [(arven, 1)], deck_id=charizard)
    assert waiting(ash, charizard) == {}
    gone = deck(ash, 'Gone', 1)
    line(ash, gone, iono, 1)
    sent(ash, misty, [(iono, 1)], deck_id=gone)
    named_deck = node(ash, gone)
    ok(call('DELETE', f'/api/decks/{gone}', ash, {'name': named_deck['name'], 'version': named_deck['version'],
                                                 'idempotency_key': str(uuid4())}))
    assert pending(ash, gone).json()['detail']['code'] == 'DECK_NOT_FOUND'
    assert waiting(ash, charizard) == {}


def test_only_the_borrower_reads_it_for_their_own_deck(store):
    _, iono, ash, misty, charizard = lending()
    sent(ash, misty, [(iono, 1)], deck_id=charizard)
    stranger, _ = collector()
    for reader in (misty, stranger):
        refused = pending(reader, charizard)
        assert (refused.status_code, refused.json()['detail']['code']) == (404, 'DECK_NOT_FOUND')
    binder = node(ash, 'Unsorted')['id']
    assert pending(ash, binder).status_code == 404
    assert pending(ash, uuid4()).status_code == 404
    assert pending(ash, 'not-a-deck').status_code == 422
    body = ok(pending(ash, charizard))
    lender = body['lines'][0]['lenders'][0]
    assert set(body) == {'deck_id', 'lines'} and set(body['lines'][0]) == {'edition_id', 'requested', 'accepted',
                                                                        'lenders'}
    assert set(lender) == {'lender', 'state', 'copies'}


def test_two_lenders_and_two_decks_are_each_counted_where_they_belong(store):
    _, iono, ash, misty, charizard = lending()
    (brock, _) = collector()
    named(brock, 'Brock S.')
    befriend(ash, brock)
    hold(brock, place(brock, 'Box'), iono, 2)
    second = deck(ash, 'Gardevoir', 1)
    line(ash, second, iono, 1)
    ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)], deck_id=charizard)), [(iono, 1)]))
    sent(ash, brock, [(iono, 2)], deck_id=charizard)
    sent(ash, misty, [(iono, 1)], deck_id=second)
    assert waiting(ash, charizard) == {iono: ('2', '1', [('Misty W.', 'accepted', '1'),
                                                         ('Brock S.', 'requested', '2')])}
    assert waiting(ash, second) == {iono: ('1', '0', [('Misty W.', 'requested', '1')])}


def test_ending_the_friendship_drops_what_nobody_handed_over_and_keeps_what_the_lender_did(store):
    _, iono, ash, misty, charizard = lending(copies=4)
    sent(ash, misty, [(iono, 1)], deck_id=charizard)
    untouched = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)], deck_id=charizard)), [(iono, 1)]))
    on_its_way = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 2)], deck_id=charizard)), [(iono, 2)]))
    ok(handover(misty, on_its_way))
    ok(remove(misty, ash))
    assert view(ash, untouched)['state'] == 'closed'
    # The lender confirmed handing these over, so they are still on their way, Friend or not.
    assert waiting(ash, charizard) == {iono: ('0', '2', [('Misty W.', 'accepted', '2')])}


def test_a_block_keeps_a_loan_the_lender_already_handed_over(store):
    _, iono, ash, misty, charizard = lending()
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 2)], deck_id=charizard)), [(iono, 2)]))
    sent(ash, misty, [(iono, 1)], deck_id=charizard)
    ok(handover(misty, loan))
    block(ash, misty)
    assert waiting(ash, charizard) == {iono: ('0', '2', [('Misty W.', 'accepted', '2')])}


def test_the_read_is_one_statement_whatever_the_loans_and_takes_no_owner_lock(store, monkeypatch):
    from app import loan_inventory
    ids, iono, ash, misty, charizard = lending(copies=6, deck_line=6)
    arven = ids['SVI 166']
    hold(misty, node(misty, 'Binder')['id'], arven, 2)
    line(ash, charizard, arven, 2)
    real = loan_inventory.connect
    statements: list[str] = []

    class Counting:
        def __init__(self, conn):
            self.conn = conn

        def __enter__(self):
            self.inner = self.conn.__enter__()
            return self

        def __exit__(self, *args):
            return self.conn.__exit__(*args)

        def transaction(self):
            return self.inner.transaction()

        def execute(self, query, *args, **kwargs):
            statements.append(str(query))
            return self.inner.execute(query, *args, **kwargs)

    def count():
        statements.clear()
        monkeypatch.setattr(loan_inventory, 'connect', lambda: Counting(real()))
        ok(pending(ash, charizard))
        monkeypatch.setattr(loan_inventory, 'connect', real)
        return list(statements)

    few = count()
    for _ in range(3):
        sent(ash, misty, [(iono, 1), (arven, 1)], deck_id=charizard)
    ok(accept(misty, view(misty, sent(ash, misty, [(iono, 2)], deck_id=charizard)), [(iono, 2)]))
    many = count()
    assert len(few) == len(many) == 1
    assert 'FOR UPDATE' not in many[0] and 'FOR SHARE' not in many[0] and 'price' not in many[0].lower()


def test_a_failed_request_to_send_shows_nothing_pending(store):
    _, iono, ash, misty, charizard = lending(copies=1)
    refused = send(ash, misty, [(iono, 2)], deck_id=charizard)
    assert refused.json()['detail']['code'] == 'NOT_LENDABLE'
    assert waiting(ash, charizard) == {}
