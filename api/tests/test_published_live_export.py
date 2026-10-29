"""Published Deck Live export (ticket 13): anonymous HTTP against a real manifest and record store.

Gateway-level proofs (cookies, zero database connections in the gateway and the API) are in
auth/tests/published-cost.test.ts; the browser journey is web/tests/published-live-export.spec.ts. Public calls run with
PostgreSQL forbidden unless the main thread publishes through it concurrently.
"""
import os
import threading
from uuid import uuid4

import psycopg
import pytest

from app.main import app, connect  # noqa: F401
from app import public_deck
from app.games.pokemon.exports import deck_live_export
from app.games.pokemon.catalog import public_catalog
from app.games.pokemon.exports import published_live_export
from app.games.pokemon.prices.catalog_targets import LIVE, activate_rule
from app.public_projection import ProjectionUnavailable
from test_catalog_metadata import owner
from test_catalog_targets import isolated_rules  # noqa: F401  (autouse: clears rule activations)
from test_deck_live_export import decide_live
from test_prices import client, world
from test_publications import command, legacy_snapshot, stored_decks
from test_published_cost import (USER, body_of, generation, launches, publish, quarantine,  # noqa: F401
                                 rewrite_snapshot, store)  # store and launches are autouse

IDENTITIES = {"normal": {"name": "Furret", "set_code": "DAA", "number": "136"},
              "unspecified": {"name": "Furret", "set_code": "DAA", "number": "2"}}
TEXT = "Pokémon: 6\n5 Furret DAA 136\n1 Furret DAA 2"


def printing_of(edition_id):
    with connect() as conn:
        return conn.execute("SELECT printing_id FROM catalog_edition WHERE id=%s", (edition_id,)).fetchone()["printing_id"]


def deliver():
    with connect() as conn:
        public_catalog.drain(conn)


def decide(editions, key, reviewer):
    """A maintainer `correct` Live decision for the Printing of editions[key] (the metadata-review path)."""
    decide_live(printing_of(editions[key]["id"]), reviewer,
                {"category": "Pokemon", "name": "Furret", "number": IDENTITIES[key]["number"], "live": IDENTITIES[key]})


def live_world(decided=("normal", "unspecified")):
    """test_prices.world() plus Live eligibility under the shipped rule v1 for the Printings of `decided`, delivered to the
    current record store. "normal" covers the Printing of both verified Editions; "unspecified" the Unspecified Variant's."""
    editions = world()
    reviewer = owner()
    with connect() as conn, conn.transaction():
        activate_rule(conn, LIVE, 1, reviewer, "https://example.org/rule", "Reviewed against the target")
    for key in decided:
        decide(editions, key, reviewer)
    deliver()
    return editions, reviewer


def ui_live_world():
    """Browser seeding (web/tests/published-live-export.spec.ts) against the stack's database and record store."""
    editions, _ = live_world()
    return {key: str(editions[key]["id"]) for key in ("normal", "reverse-holofoil", "unspecified")}


def path_of(token, version, kind="live"):
    return f"/api/public/decks/{token}/versions/{version}/exports/{kind}"


def public_get(path, *, guard=True):
    if not guard:
        return client.get(path)

    def forbidden(*args, **kwargs):
        raise AssertionError("the public Live export opened a PostgreSQL connection")
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(psycopg, "connect", forbidden)
        patch.setenv("DATABASE_URL", "postgresql://unreachable:1/private")
        return client.get(path)


def refused(response, status, code):
    assert response.status_code == status, response.text
    assert response.json()["detail"]["code"] == code
    assert response.headers["x-robots-tag"] == "noindex, nofollow" and response.headers["cache-control"] == "no-store"


def text_of(response):
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/plain") and "charset=utf-8" in response.headers["content-type"]
    assert response.headers["content-disposition"] == 'attachment; filename="deck-live-export.txt"'
    assert response.headers["cache-control"] == "no-store" and response.headers["x-robots-tag"] == "noindex, nofollow"
    return response.text


def test_live_exports_every_frozen_copy_from_current_reviewed_rules_for_the_same_printing(store, monkeypatch):
    editions, reviewer = live_world(decided=("normal",))
    normal, reverse, plain = editions["normal"], editions["reverse-holofoil"], editions["unspecified"]
    deck, token = publish({normal["id"]: 3, reverse["id"]: 2, plain["id"]: 1})
    _, empty = publish({})

    # A private Deck List edit after publishing changes nothing.
    with connect() as conn, conn.transaction():
        conn.execute("UPDATE deck_list_line SET quantity=quantity+10 WHERE owner_id=%s AND deck_id=%s AND edition_id=%s",
                     (USER, deck, normal["id"]))
        conn.execute("UPDATE deck_list SET revision=revision+1 WHERE owner_id=%s AND deck_id=%s", (USER, deck))
        reason = conn.execute("SELECT live_reason FROM catalog_printing_metadata WHERE printing_id=%s",
                              (printing_of(plain["id"]),)).fetchone()["live_reason"]
    frozen = stored_decks()["decks"][token]["snapshot"]
    path = path_of(token, 1)

    for kind in ("live", "live.txt"):
        refused(public_get(path_of(token, 1, kind) + "?owner_revision=1"), 422, "INVALID_REQUEST")
        refused(public_get(path_of(token, 1, kind) + "?printing_ref=" + "a" * 48), 422, "INVALID_REQUEST")
        refused(client.request("GET", path_of(token, 1, kind), content=b"{}"), 422, "INVALID_REQUEST")
        refused(public_get(path_of(token, "01", kind)), 404, "PUBLISHED_DECK_NOT_FOUND")
        refused(public_get(path_of("Z" * 32, 1, kind)), 404, "PUBLISHED_DECK_NOT_FOUND")
        refused(public_get(path_of(token, 2, kind)), 409, "PUBLISHED_DECK_CHANGED")
        assert client.post(path_of(token, 1, kind)).status_code == 405

    # Blocked: the Unspecified Variant's Printing has no reviewed identity yet.
    body = body_of(public_get(path))
    assert set(body) == {"version", "digest", "status", "text", "inline", "byte_length", "total_copies", "blockers"}
    assert (body["status"], body["text"], body["total_copies"], body["version"]) == ("blocked", None, "6", 1)
    assert [(b["name"], b["quantity"], b["reason"]) for b in body["blockers"]] == [("Furret", "1", reason)]
    assert set(body["blockers"][0]) == {"name", "set_name", "collector_number", "descriptor", "quantity", "reason"}
    refused(public_get(path_of(token, 1, "live.txt")), 409, "LIVE_EXPORT_BLOCKED")

    # A maintainer decision delivered to the store unblocks the same version.
    decide(editions, "unspecified", reviewer)
    deliver()
    before = generation(store)
    body = body_of(public_get(path))
    assert (body["status"], body["text"], body["inline"], body["byte_length"], body["total_copies"], body["blockers"]) == (
        "ok", TEXT, True, len(TEXT.encode()), "6", [])
    assert body["digest"] == public_deck.snapshot_digest(frozen)
    assert stored_decks()["decks"][token]["snapshot"] == frozen
    assert text_of(public_get(path_of(token, 1, "live.txt"))) == TEXT
    assert generation(store) == before

    # A marketplace quarantine of the Edition leaves the Live text unchanged.
    quarantine(store, normal["public_ref"])
    assert body_of(public_get(path))["text"] == TEXT

    with monkeypatch.context() as patch:
        patch.setattr(deck_live_export, "INLINE_LIMIT_BYTES", 8)
        body = body_of(public_get(path))
        assert (body["inline"], body["text"], body["byte_length"]) == (False, None, len(TEXT.encode()))
        assert text_of(public_get(path_of(token, 1, "live.txt"))) == TEXT

    # A suspension blocks every row of that Printing with its reviewed reason.
    with connect() as conn, conn.transaction():
        conn.execute("UPDATE catalog_printing_metadata SET live_state='suspended',live_reason='source_changed',"
                     "live_identity=NULL,live_claim=NULL WHERE printing_id=%s", (printing_of(normal["id"]),))
    deliver()
    body = body_of(public_get(path))
    assert body["status"] == "blocked"
    assert sorted((b["quantity"], b["reason"]) for b in body["blockers"]) == [("2", "source_changed"), ("3", "source_changed")]

    body = body_of(public_get(path_of(empty, 1)))
    assert (body["status"], body["text"], body["total_copies"], body["blockers"]) == ("empty", None, "0", [])
    refused(public_get(path_of(empty, 1, "live.txt")), 422, "DECK_EMPTY")

    def catalog_down(*args, **kwargs):
        raise ProjectionUnavailable()
    monkeypatch.setattr(published_live_export, "live_states", catalog_down)
    refused(public_get(path), 503, "PUBLIC_CATALOG_UNAVAILABLE")
    monkeypatch.setattr(public_deck, "_record", catalog_down)
    refused(public_get(path), 503, "PUBLIC_PROJECTION_UNAVAILABLE")


def test_legacy_and_unresolved_printings_block_the_complete_live_export_while_the_snapshot_stays_readable(store):
    editions, _ = live_world()
    normal, reverse, plain = editions["normal"], editions["reverse-holofoil"], editions["unspecified"]
    deck, token = publish({normal["id"]: 3, reverse["id"]: 2, plain["id"]: 1})
    legacy_snapshot(token)
    assert client.get(f"/api/public/decks/{token}").status_code == 200
    body = body_of(public_get(path_of(token, 1)))
    assert body["status"] == "blocked" and body["total_copies"] == "6"
    assert sorted((b["quantity"], b["reason"]) for b in body["blockers"]) == [
        ("1", "unproven_reference"), ("2", "unproven_reference"), ("3", "unproven_reference")]

    assert command(USER, deck, "PUT").status_code == 200
    body = body_of(public_get(path_of(token, 2)))
    assert (body["status"], body["text"]) == ("ok", TEXT)

    def change(snapshot):
        for identity in snapshot["identities"]:
            for edition in identity["editions"]:
                if edition["edition_ref"] == normal["public_ref"]:
                    edition["printing_ref"] = "f" * 48
    rewrite_snapshot(token, change)
    body = body_of(public_get(path_of(token, 2)))
    assert body["status"] == "blocked"
    assert [(b["quantity"], b["reason"]) for b in body["blockers"]] == [("3", "unproven_reference")]


def test_republish_rewrite_revoke_and_replay_during_a_live_export_are_never_answered_with_other_content(store, monkeypatch):
    editions, _ = live_world()
    normal = editions["normal"]
    deck, token = publish({normal["id"]: 3})
    real = published_live_export.live_states

    def during(change, version):
        """Hold one export inside its eligibility read, apply `change`, then let it finish; returns its response."""
        entered, release, box = threading.Event(), threading.Event(), {}

        def held(*args, **kwargs):
            entered.set()
            assert release.wait(10)
            return real(*args, **kwargs)
        monkeypatch.setattr(published_live_export, "live_states", held)
        thread = threading.Thread(target=lambda: box.update(response=public_get(path_of(token, version), guard=False)))
        thread.start()
        assert entered.wait(10)
        change()
        release.set()
        thread.join(10)
        assert not thread.is_alive()
        monkeypatch.setattr(published_live_export, "live_states", real)
        return box["response"]

    def republish():
        assert command(USER, deck, "PUT").status_code == 200
    refused(during(republish, 1), 409, "PUBLISHED_DECK_CHANGED")

    refused(during(lambda: rewrite_snapshot(token, lambda s: s["identities"][0]["editions"][0].update(quantity="4")), 2),
            409, "PUBLISHED_DECK_CHANGED")

    stale = uuid4()
    with monkeypatch.context() as patch:
        def broken(*args, **kwargs):
            raise OSError("disk")
        patch.setattr(os, "replace", broken)
        assert command(USER, deck, "PUT", key=stale).status_code == 503

    def revoke():
        assert command(USER, deck, "DELETE").status_code == 200
    refused(during(revoke, 2), 404, "PUBLISHED_DECK_NOT_FOUND")

    assert command(USER, deck, "PUT", key=stale).status_code == 200
    for version in (1, 2, 3):
        for kind in ("live", "live.txt"):
            refused(public_get(path_of(token, version, kind)), 404, "PUBLISHED_DECK_NOT_FOUND")
