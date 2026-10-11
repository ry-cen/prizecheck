"""Published Deck cost (ticket 12): signed anonymous HTTP against a real manifest and record store.

The gateway-level proofs (cookies, zero database wakeups in both processes, the 3 s budget measured outside the gateway,
the anonymous ledger, publish/republish/revoke through the real gateway) are in auth/tests/published-cost.test.ts. This
file covers what is cheaper in-process: labels, the input matrix, mid-wait revalidation, legacy rows and durable replay.
Public calls run with PostgreSQL forbidden unless a test must write through it concurrently.
"""
from datetime import timedelta
import json
import os
import threading
import time
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest

from app.main import app, connect  # noqa: F401  (main first: it includes every router while loading)
from app import price_launcher, public_deck, published_cost
from app.public_projection import FilePublicProjection, ProjectionUnavailable
from app.public_records import public_record_store, quarantine_key
from test_catalog_targets import isolated_rules, owner  # noqa: F401  (isolated_rules is autouse)
from test_deck_cost import deck_with, scheduler
from test_holdings import add
from test_prices import ago, client, headers_for, seed, world
from test_publications import command, legacy_snapshot, stored_decks

USER = "published-cost-owner"
ANON = "anon:" + "5a" * 16


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("PUBLIC_PROJECTION_DIR", str(tmp_path))
    monkeypatch.setenv("PUBLIC_PROJECTION_ADAPTER", "filesystem")
    with FilePublicProjection().writer(initialize=True):
        pass
    public_record_store().initialize(deadline=time.monotonic() + 5)
    return public_record_store()


@pytest.fixture(autouse=True)
def launches(monkeypatch):
    calls = []
    monkeypatch.setattr(price_launcher, "spawn", lambda slot, owner: calls.append((slot, owner)) or True)
    return calls


def path_of(token, version):
    return f"/api/public/decks/{token}/versions/{version}/cost"


def public_cost(token, version, *, guard=True, query="", caller=ANON, **options):
    path = path_of(token, version)
    headers = headers_for(b"", method="GET", path=path, user=None, caller=caller, **options)
    if not guard:
        return client.get(path + query, headers=headers)

    def forbidden(*args, **kwargs):
        raise AssertionError("the public cost route opened a PostgreSQL connection")
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(psycopg, "connect", forbidden)
        patch.setenv("DATABASE_URL", "postgresql://unreachable:1/private")
        return client.get(path + query, headers=headers)


def body_of(response):
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-robots-tag"] == "noindex, nofollow"
    return response.json()


def publish(quantities):
    deck = deck_with(quantities, user=USER)
    response = command(USER, deck)
    assert response.status_code == 200, response.text
    return deck, response.json()["token"]


def generation(store):
    return store.read_records([quarantine_key("0" * 48)], deadline=time.monotonic() + 5).generation


def rewrite_snapshot(token, change):
    """Rewrite one stored snapshot in place (same version), atomically, as a mistaken recovery replay would."""
    path = Path(os.environ["PUBLIC_PROJECTION_DIR"]) / "current.json"
    state = json.loads(path.read_text())
    change(state["decks"][token]["snapshot"])
    temporary = path.with_name(".rewrite-" + uuid4().hex)
    temporary.write_text(json.dumps(state))
    os.replace(temporary, path)


def quarantine(store, ref):
    key = quarantine_key(ref)
    row = store.read_records([key], deadline=time.monotonic() + 5).records[key]
    assert store.compare_and_swap({key: row.version}, {key: {**row.value, "state": "quarantined"}},
                                  deadline=time.monotonic() + 5)


def wait_for_permit(store):
    """Until the cost request holds its interactive permit, i.e. it is inside its wait window."""
    deadline = time.monotonic() + 3
    while True:
        try:
            if scheduler(store)["interactive"]:
                return
        except (KeyError, TypeError):
            pass
        assert time.monotonic() < deadline, "the cost request never reached its wait window"
        time.sleep(0.05)


def test_published_cost_labels_empty_unpriced_and_unreadable_snapshots(store, monkeypatch):
    editions = world()
    normal, plain = editions["normal"], editions["unspecified"]
    seed(store, normal, "0.25")

    _, token = publish({})
    body = body_of(public_cost(token, 1))
    assert (body["status"], body["display_amount"], body["total_copies"], body["priced_copies"], body["version"]) == \
        ("empty", "$0.00", "0", "0", 1)
    assert body["digest"] == public_deck.snapshot_digest(stored_decks()["decks"][token]["snapshot"])
    assert set(body) == {"version", "digest", "status", "reason", "total_copies", "priced_copies", "stale_copies",
                         "unknown_age_copies", "fallback_copies", "amount", "display_amount", "currency"}

    _, token = publish({plain["id"]: 2})
    body = body_of(public_cost(token, 1))
    assert (body["status"], body["priced_copies"], body["total_copies"], body["amount"]) == ("no_quotes", "0", "2", None)

    _, token = publish({normal["id"]: 3, plain["id"]: 1})
    before = generation(store)
    body = body_of(public_cost(token, 1))
    assert (body["display_amount"], body["priced_copies"], body["total_copies"]) == ("$0.75", "3", "4")
    assert generation(store) == before

    def down(*args, **kwargs):
        raise ProjectionUnavailable()
    with monkeypatch.context() as patch:
        patch.setattr(published_cost, "marketplace_states", down)
        body = body_of(public_cost(token, 1))
    assert (body["status"], body["reason"], body["total_copies"], body["priced_copies"], body["amount"]) == \
        ("incomplete", "store_unavailable", "4", None, None)
    assert body["digest"]

    real, calls = public_deck._record, []

    def second_fails(*args, **kwargs):
        calls.append(1)
        if len(calls) >= 2:
            raise ProjectionUnavailable()
        return real(*args, **kwargs)
    monkeypatch.setattr(public_deck, "_record", second_fails)
    body = body_of(public_cost(token, 1))
    assert (body["status"], body["reason"], body["total_copies"], body["digest"]) == \
        ("incomplete", "validation_unavailable", None, None)


def test_only_a_token_and_a_version_reach_the_published_cost(store, monkeypatch):
    editions = world()
    normal = editions["normal"]
    seed(store, normal, "0.25")
    _, token = publish({normal["id"]: 2})
    assert body_of(public_cost(token, 1))["amount"] == "0.5"
    monkeypatch.setattr(published_cost, "public_quotes", lambda *args, **kwargs: pytest.fail("quotes were read"))
    path = path_of(token, 1)
    for query in ("?force=1", "?refresh=true", f"?edition_ids={normal['id']}", "?quantity=60",
                  "?source_url=https://example.test", "?target=tcgplayer", "?caller=user:x", "?deadline_ms=30000",
                  "?version=2"):
        response = public_cost(token, 1, query=query)
        assert response.status_code == 422, query
        assert response.json()["detail"]["code"] == "INVALID_REQUEST"
    assert client.get(path).status_code == 401
    assert public_cost(token, 1, caller=f"user:{USER}").status_code == 401
    assert public_cost(token, 1, caller="anon:short").status_code == 401
    assert public_cost(token, 1, forge="0" * 64).status_code == 401
    headers = headers_for(b"", method="GET", path=path, user=None, caller=ANON)
    headers["x-internal-budget-ms"] = "30000"
    assert client.get(path, headers=headers).status_code == 401
    for bad_token, bad_version in ((token, "0"), (token, "01"), (token, "x"), ("short", "1"), ("Z" * 32, "1")):
        response = public_cost(bad_token, bad_version)
        assert response.status_code == 404, (bad_token, bad_version)
        assert response.headers["x-robots-tag"] == "noindex, nofollow"
    response = public_cost(token, 2)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "PUBLISHED_DECK_CHANGED"
    assert response.headers["cache-control"] == "no-store"
    post = client.post(path, headers=headers_for(b"", method="POST", path=path, user=None, caller=ANON))
    assert post.status_code == 405


@pytest.mark.parametrize("change, status", [("republish", 409), ("rewrite", 409), ("quarantine", 200)])
def test_an_answer_is_withheld_when_the_snapshot_or_eligibility_changes_during_the_wait(store, change, status):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal, "0.25")
    deck, token = publish({normal["id"]: 3, reverse["id"]: 2})
    box = {}
    thread = threading.Thread(target=lambda: box.update(response=public_cost(token, 1, guard=False)))
    thread.start()
    wait_for_permit(store)
    if change == "republish":
        assert command(USER, deck, "PUT").status_code == 200
    elif change == "rewrite":
        rewrite_snapshot(token, lambda s: s["identities"][0]["editions"][0].update(quantity="4"))
    else:
        quarantine(store, reverse["public_ref"])
    seed(store, reverse, "0.43")
    thread.join(10)
    assert not thread.is_alive()
    response = box["response"]
    assert response.status_code == status, response.text
    if status == 409:
        assert response.json()["detail"]["code"] == "PUBLISHED_DECK_CHANGED"
    else:
        body = body_of(response)
        assert (body["status"], body["amount"], body["priced_copies"], body["total_copies"]) == ("priced", "0.75", "3", "5")


def test_legacy_and_unproven_rows_stay_readable_and_unpriced_until_a_republish_captures_them(store):
    editions = world()
    normal, reverse, plain = editions["normal"], editions["reverse-holofoil"], editions["unspecified"]
    seed(store, normal, "0.25")
    seed(store, reverse, "0.43", updated=ago(timedelta(hours=72)))
    deck, token = publish({normal["id"]: 3, reverse["id"]: 2, plain["id"]: 1})
    legacy_snapshot(token)
    assert client.get(f"/api/public/decks/{token}").status_code == 200
    body = body_of(public_cost(token, 1))
    assert (body["status"], body["priced_copies"], body["total_copies"]) == ("no_quotes", "0", "6")
    assert command(USER, deck, "PUT").status_code == 200
    body = body_of(public_cost(token, 2))
    assert (body["display_amount"], body["priced_copies"], body["total_copies"], body["stale_copies"]) == ("$1.61", "5", "6", "2")

    def unprove(snapshot):
        for identity in snapshot["identities"]:
            for edition in identity["editions"]:
                if edition["edition_ref"] == normal["public_ref"]:
                    edition["printing_ref"] = "f" * 48
                elif edition["edition_ref"] == reverse["public_ref"]:
                    edition["edition_ref"] = "e" * 48
    rewrite_snapshot(token, unprove)
    body = body_of(public_cost(token, 2))
    assert (body["status"], body["priced_copies"], body["total_copies"]) == ("no_quotes", "0", "6")


def test_a_replayed_stale_republish_cannot_restore_the_cost_of_a_revoked_token(store, monkeypatch):
    editions = world()
    normal = editions["normal"]
    seed(store, normal, "0.25")
    deck, token = publish({normal["id"]: 1})
    stale = uuid4()
    with monkeypatch.context() as patch:
        def broken(*args, **kwargs):
            raise OSError("injected")
        patch.setattr(os, "replace", broken)
        assert command(USER, deck, "PUT", key=stale).status_code == 503
    assert command(USER, deck, "DELETE").status_code == 200
    assert command(USER, deck, "PUT", key=stale).status_code == 200
    for version in (1, 2):
        response = public_cost(token, version)
        assert response.status_code == 404, (version, response.text)
        assert response.json()["detail"]["code"] == "PUBLISHED_DECK_NOT_FOUND"


@pytest.mark.serial(reason="wall-clock: asserts an upper bound on elapsed time")
def test_a_stalled_snapshot_read_answers_inside_the_budget(store, monkeypatch):
    editions = world()
    normal = editions["normal"]
    seed(store, normal, "0.25")
    _, token = publish({normal["id"]: 1})
    release, real = threading.Event(), public_deck._record

    def stalled(*args, **kwargs):
        release.wait(5)
        return real(*args, **kwargs)
    monkeypatch.setattr(public_deck, "_record", stalled)
    # The wait window of a 1 s budget ends 0.5 s after receipt, so the adapter's 5 s timeout never bounds this route.
    started = time.monotonic()
    response = public_cost(token, 1, ms=1000)
    elapsed = time.monotonic() - started
    release.set()
    body = body_of(response)
    assert (body["status"], body["reason"], body["digest"], body["total_copies"]) == ("incomplete", "deadline", None, None)
    assert 0.4 < elapsed < 0.9, elapsed
