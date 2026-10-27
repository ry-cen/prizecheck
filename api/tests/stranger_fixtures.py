"""Shared fixtures for the Stage 2 stranger tests (Trading #299): two collectors who are not Friends but are both in
open discovery within range, and the helpers that address a Trade Proposal by trader id.

A helper module, not collected as tests. It must not import ``test_trades``, ``test_trade_lists`` or
``test_conversations``: ``test_trades`` imports ``test_trade_lists`` and ``test_conversations`` imports ``test_trades``,
so a helper there would make an import cycle for the files that need it.
"""
from uuid import uuid4

from app.main import connect  # noqa: F401
from test_deck_counting import hold
from test_for_trade_locations import mark
from test_friend_copies import collector, ok, place
from test_holdings import call
from test_open_discovery import discoverable
from want_list_swap_fixtures import seed_swap_catalog


def trader_of(user):
    with connect() as conn:
        return str(conn.execute('SELECT trader_id FROM collector_profile WHERE user_id = %s', (user,)).fetchone()['trader_id'])


def strangers():
    """Misty W. (3 Iono PAL 185 in her For trade Trade Binder) and Ash K. (2 Arven SVI 166 in his For trade Box), who are
    not Friends but both in open discovery, about 7 miles apart (zips 00010 and 00011). Returns
    (ids, ash, misty, binder, box)."""
    ids = seed_swap_catalog()
    (ash, _), (misty, _) = collector('Ash K.'), collector('Misty W.')
    binder, box = place(misty, 'Trade Binder'), place(ash, 'Box')
    hold(misty, binder, ids['PAL 185'], 3)
    hold(ash, box, ids['SVI 166'], 2)
    ok(mark(misty, binder))
    ok(mark(ash, box))
    discoverable(misty, '00010')
    discoverable(ash, '00011')
    return ids, ash, misty, binder, box


def propose_to(sender, trader_id, give=(), get=(), key=None, cash=None):
    """A Trade Proposal addressed by trader id."""
    def lines(cards):
        return [{'edition_id': edition, 'quantity': str(count)} for edition, count in cards]

    body = {'recipient_trader_id': str(trader_id), 'you_give': lines(give), 'you_get': lines(get),
            'idempotency_key': str(key or uuid4())}
    if cash is not None:
        body['cash'] = cash
    return call('POST', '/api/trades', sender, body)


def far_zip():
    """Upserts zip 00019 at (45.0, -100.0), about 345 miles from 00010, and returns it."""
    with connect() as conn:
        conn.execute("""INSERT INTO zip_centroid (zip, lat, lon, source) VALUES ('00019', 45.0, -100.0, 'census')
          ON CONFLICT (zip) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, source = EXCLUDED.source""")
    return '00019'
