"""Deck art warm-up (#396, ADR 0020): saving Deck List lines queues background stores of the small art of the deck's
Printings, through the art route's fetcher and limits. It never blocks or fails the save. ``seed`` replaces the catalog,
so these tests live in their own file."""
import threading

import httpx
import pytest

from app.core.art import store as art_store
from app.core.art.store import ArtFetcher, RateLimiter
from app.games.pokemon.art import route as art_route
from app.games.pokemon.art.hosts import ALLOWED_HOST
from app.main import connect
from test_art_store import Upstream, webp
from test_card_attributes import BULBASAUR_ME, ENERGY_SV, SWITCH_ME, edition_of
from test_attribute_corrections import seed
from test_deck_cover import collector, new_deck
from test_deck_lists import add_line, change_line, detail

BULBASAUR_ART = {**BULBASAUR_ME, 'image': 'https://assets.tcgdex.net/en/me/me01/001'}
SWITCH_ART = {**SWITCH_ME, 'image': 'https://assets.tcgdex.net/en/me/me01/130'}


@pytest.fixture
def stub(monkeypatch, tmp_path):
    monkeypatch.setenv('ART_STORE_DIR', str(tmp_path))
    monkeypatch.setenv('ART_WARM_UP', '1')
    upstream = Upstream()
    monkeypatch.setattr(art_route, '_fetcher',
                        ArtFetcher(allowed_host=ALLOWED_HOST, transport=httpx.MockTransport(upstream.handler), limiter=RateLimiter(100000)))
    return upstream


def stored():
    with connect() as conn:
        return {row['source_url'] for row in conn.execute("SELECT source_url FROM art_object WHERE size='small'")}


def hits():
    with connect() as conn:
        return conn.execute('SELECT count(*) AS n FROM art_hit').fetchone()['n']


def test_saving_a_line_stores_the_small_art_of_the_decks_printings_once(stub):
    seed(BULBASAUR_ART, SWITCH_ART, ENERGY_SV)
    owner = collector()
    deck = new_deck(owner)
    bulbasaur, switch, energy = (edition_of(card) for card in ('me01-001', 'me01-130', 'sv02-278'))
    assert add_line(owner, deck, bulbasaur, '2', 1).status_code == 200
    art_store.join_warmups()
    assert stored() == {'https://assets.tcgdex.net/en/me/me01/001/low.webp'}
    assert stub.urls == ['https://assets.tcgdex.net/en/me/me01/001/low.webp']
    assert hits() == 0  # a warm-up is not a view
    # The next save fetches only what is not stored yet; the energy has no image.
    assert add_line(owner, deck, switch, '1', 2).status_code == 200
    assert add_line(owner, deck, energy, '1', 3).status_code == 200
    art_store.join_warmups()
    assert stored() == {'https://assets.tcgdex.net/en/me/me01/001/low.webp', 'https://assets.tcgdex.net/en/me/me01/130/low.webp'}
    assert stub.count == 2


def test_a_failed_warm_up_never_fails_the_save_and_backs_off(stub):
    seed(BULBASAUR_ART)
    stub.responder = lambda request: httpx.Response(404)
    owner = collector()
    deck = new_deck(owner)
    bulbasaur = edition_of('me01-001')
    assert add_line(owner, deck, bulbasaur, '1', 1).status_code == 200
    art_store.join_warmups()
    assert stored() == set() and stub.count == 1
    # In backoff: the next save does not ask upstream again.
    assert change_line(owner, deck, bulbasaur, '2', 2).status_code == 200
    art_store.join_warmups()
    assert stub.count == 1


def test_an_error_in_the_warm_up_never_fails_the_save(stub, monkeypatch):
    seed(BULBASAUR_ART)
    owner = collector()
    deck = new_deck(owner)

    def broken(*args):
        raise RuntimeError('pool is gone')

    monkeypatch.setattr(art_store, '_warm_executor', broken)
    assert add_line(owner, deck, edition_of('me01-001'), '1', 1).status_code == 200
    assert stub.count == 0


def test_a_save_queues_at_most_the_warm_limit(stub, monkeypatch):
    seed(BULBASAUR_ART, SWITCH_ART)
    monkeypatch.setattr(art_store, 'WARM_LIMIT', 1)
    owner = collector()
    deck = new_deck(owner)
    assert add_line(owner, deck, edition_of('me01-001'), '1', 1).status_code == 200
    art_store.join_warmups()
    assert stub.urls == ['https://assets.tcgdex.net/en/me/me01/001/low.webp']
    assert add_line(owner, deck, edition_of('me01-130'), '1', 2).status_code == 200
    art_store.join_warmups()
    # One Printing a save: the second save skips the stored one and takes the other.
    assert stub.urls == ['https://assets.tcgdex.net/en/me/me01/001/low.webp',
                         'https://assets.tcgdex.net/en/me/me01/130/low.webp']


def test_a_sql_failure_in_the_warm_up_leaves_the_save_whole(stub, monkeypatch):
    seed(BULBASAUR_ART)
    monkeypatch.setattr(art_store, 'WARM_LIMIT', -1)  # PostgreSQL rejects a negative LIMIT
    owner = collector()
    deck = new_deck(owner)
    bulbasaur = edition_of('me01-001')
    saved = add_line(owner, deck, bulbasaur, '2', 1)
    assert saved.status_code == 200
    art_store.join_warmups()
    assert stub.count == 0
    kept = detail(owner, deck)['deck_list']
    assert kept['revision'] == 2 and [(line['edition_id'], line['quantity']) for line in kept['lines']] == [(bulbasaur, '2')]


def test_shutdown_stops_a_running_job_and_drops_what_it_had_queued(stub, monkeypatch):
    seed(BULBASAUR_ART, SWITCH_ART)
    monkeypatch.setattr(art_store, '_warm_stop', threading.Event())
    monkeypatch.setattr(art_store, '_warm_pool', None)
    owner = collector()
    deck = new_deck(owner)
    art_store._warm_stop.set()
    assert add_line(owner, deck, edition_of('me01-001'), '1', 1).status_code == 200
    art_store.join_warmups()
    assert stub.count == 0 and art_store._warm_pending == set()
    # The lifespan's shutdown sets the flag and closes the pool without waiting for it.
    monkeypatch.setattr(art_store, '_warm_stop', threading.Event())
    monkeypatch.setattr(art_store, '_warm_pool', None)
    pool = art_store._warm_executor()
    art_store.stop_warmups()
    assert art_store._warm_stop.is_set() and art_store._warm_pool is None
    with pytest.raises(RuntimeError):
        pool.submit(print)
    # The next start (the lifespan's, or the suite's) lets warm-ups run again on a new pool.
    art_store.start_warmups()
    assert not art_store._warm_stop.is_set() and art_store._warm_executor() is not pool


def test_a_failed_queueing_does_not_leave_printings_pending(stub, monkeypatch):
    seed(BULBASAUR_ART)
    owner = collector()
    deck = new_deck(owner)

    def broken():
        raise RuntimeError('pool is gone')

    monkeypatch.setattr(art_store, '_warm_executor', broken)
    assert add_line(owner, deck, edition_of('me01-001'), '1', 1).status_code == 200
    assert art_store._warm_pending == set()


def test_the_warm_up_is_off_when_disabled(stub, monkeypatch):
    seed(BULBASAUR_ART)
    monkeypatch.setenv('ART_WARM_UP', '0')
    owner = collector()
    deck = new_deck(owner)
    assert add_line(owner, deck, edition_of('me01-001'), '1', 1).status_code == 200
    art_store.join_warmups()
    assert stub.count == 0


def test_publish_warms_small_and_large(stub, tmp_path, monkeypatch):
    from test_publications import command, list_cards
    from app.public_projection import FilePublicProjection
    from app.core.art.public import read_pointer
    monkeypatch.setenv("PUBLIC_PROJECTION_DIR", str(tmp_path / "public"))
    # Initialize the publication store independently of the art store fixture.
    with FilePublicProjection().writer(initialize=True):
        pass
    seed(BULBASAUR_ART)
    owner = collector()
    deck = new_deck(owner)
    edition = edition_of('me01-001')
    list_cards(owner, deck, {edition: 1})
    response = command(owner, deck)
    assert response.status_code == 200, response.text
    art_store.join_warmups()
    with connect() as conn:
        ref = conn.execute('SELECT public_ref FROM catalog_printing WHERE source_id=%s', ('me01-001',)).fetchone()['public_ref']
    assert read_pointer(ref, 'small') is not None
    assert read_pointer(ref, 'large') is not None
    assert stub.count == 2
