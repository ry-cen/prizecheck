"""Publishing starts a background price refresh for the snapshot's Editions (app redesign #181; spec, "Publishing and
public routes"), through the HTTP API against a real record store.

The refresh runs after the publish or republish response, as one ordinary access over the snapshot's priced rows for the
owner's caller (``user:<id>``) within the existing admission caps, and never waits. What a caller can observe is the shared
scheduler record: the jobs it holds and whose caller they name. No real runner starts here (``launches`` records spawns).
"""
from datetime import timedelta
from uuid import uuid4

from app import publish_refresh
from app.public_projection import ProjectionUnavailable
from test_deck_cost import scheduler
from test_holdings import call
from test_prices import ago, seed_quote as seed, world
from test_publications import command, stored_decks
from test_published_cost import USER, launches, listed_deck, store  # noqa: F401  (store, launches: autouse)

CALLER = f"user:{USER}"


def job_of(edition):
    return f"{edition['public_ref']}:{edition['mapping_revision']}"


def jobs(store):
    record = scheduler(store)
    return {} if record is None else record["jobs"]


def stale(store, edition, hours):
    """A quote whose last successful check was ``hours`` ago (1 h or more is soft, 24 h or more hard)."""
    seed(store, edition, "0.25", checked=ago(timedelta(hours=hours)))


def test_publish_admits_the_snapshots_stale_rows_for_the_owner_and_answers_as_before(store, launches):
    editions = world()
    normal, reverse, plain = editions["normal"], editions["reverse-holofoil"], editions["unspecified"]
    stale(store, normal, 2)
    seed(store, reverse, "0.43")  # checked ten minutes ago: fresh, nothing to do
    deck = listed_deck({normal["id"]: 3, reverse["id"]: 2, plain["id"]: 1})

    response = command(USER, deck)
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"token", "version", "revoked"}
    assert (body["version"], body["revoked"]) == (1, False)
    assert body["token"] in stored_decks()["decks"]

    queued = jobs(store)
    # Only the stale row; the fresh row and the Unspecified Variant (no quote lookup) admit nothing.
    assert set(queued) == {job_of(normal)}
    assert queued[job_of(normal)]["caller"] == CALLER
    # The refresh never waits: its interactive permit is gone once the response is out, and a runner was asked for.
    assert scheduler(store)["interactive"] == {}
    assert len(launches) == 1


def test_republish_refreshes_a_row_that_went_stale_and_fresh_rows_never_force_one(store, launches):
    editions = world()
    normal = editions["normal"]
    seed(store, normal, "0.25")
    deck = listed_deck({normal["id"]: 2})
    assert command(USER, deck).status_code == 200
    # Every row fresh: publishing is no way to refresh prices on demand (ADR 0006).
    assert jobs(store) == {}
    assert launches == []

    stale(store, normal, 25)
    visibility = call("PATCH", f"/api/decks/{deck}/publication/visibility", USER,
                      {"visibility": "listed", "idempotency_key": str(uuid4())})
    assert visibility.status_code == 200, visibility.text
    assert jobs(store) == {}  # visibility admits nothing

    republished = command(USER, deck, method="PUT")
    assert republished.status_code == 200, republished.text
    assert republished.json()["version"] == 2
    assert set(jobs(store)) == {job_of(normal)}
    assert jobs(store)[job_of(normal)]["caller"] == CALLER


def test_revoke_admits_nothing(store, launches):
    editions = world()
    normal = editions["normal"]
    seed(store, normal, "0.25")
    deck = listed_deck({normal["id"]: 2})
    assert command(USER, deck).status_code == 200
    stale(store, normal, 25)
    assert command(USER, deck, method="DELETE").status_code == 200
    assert jobs(store) == {}
    assert launches == []


def test_a_publish_refused_by_the_gate_admits_nothing(store, launches):
    editions = world()
    normal = editions["normal"]
    stale(store, normal, 25)
    deck = listed_deck({normal["id"]: 2})
    # Not exempt: two cards are not a legal Standard Deck List.
    refused = call("POST", f"/api/decks/{deck}/publication", USER,
                   {"title": "Public deck", "idempotency_key": str(uuid4())})
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "TARGET_FORMAT_NOT_LEGAL"
    assert jobs(store) == {}
    assert launches == []


def test_a_failed_refresh_never_fails_the_publish(store, launches, monkeypatch):
    editions = world()
    normal = editions["normal"]
    stale(store, normal, 25)
    deck = listed_deck({normal["id"]: 2})

    def down(*args, **kwargs):
        raise ProjectionUnavailable()
    monkeypatch.setattr(publish_refresh, "marketplace_states", down)
    response = command(USER, deck)
    assert response.status_code == 200, response.text
    assert response.json()["token"] in stored_decks()["decks"]
    assert jobs(store) == {}
    assert launches == []
