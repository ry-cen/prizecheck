"""Published Deck Mass Entry export (ticket 14): anonymous HTTP against a real manifest and record store.

Gateway-level proofs (cookies, zero database connections in the gateway and the API) are in
auth/tests/published-cost.test.ts; the browser journey is web/tests/published-mass-entry.spec.ts. Public calls run with
PostgreSQL forbidden unless the main thread publishes through it concurrently.
"""
import os
import threading
from uuid import uuid4

import psycopg
import pytest

from app.main import app, connect  # noqa: F401  (main first: it includes every router while loading)
from app import deck_mass_entry, public_deck, published_mass_entry
from app.public_catalog import MarketplaceState
from app.public_projection import ProjectionUnavailable
from test_catalog_targets import isolated_rules  # noqa: F401  (autouse: clears rule activations)
from test_prices import client, world
from test_publications import command, legacy_snapshot, stored_decks
from test_published_cost import (USER, body_of, generation, launches, publish, quarantine,  # noqa: F401
                                 rewrite_snapshot, store)  # store and launches are autouse

BASE = "https://www.tcgplayer.com/massentry?productline=Pokemon&c="
SEPARATOR = "%7C%7C"
KEYS = {"version", "digest", "status", "url", "fallback_reason", "text", "inline", "byte_length", "lines", "line_count",
        "less_specific_count", "total_copies"}


def products(*editions):
    with connect() as conn:
        return {row["edition_id"]: row["product_id"] for row in conn.execute(
            "SELECT edition_id,product_id FROM catalog_edition_metadata WHERE edition_id=ANY(%s)", ([e["id"] for e in editions],))}


def printing_ref_of(edition_id):
    with connect() as conn:
        return conn.execute("""SELECT p.public_ref FROM catalog_printing p JOIN catalog_edition e ON e.printing_id=p.id
          WHERE e.id=%s""", (edition_id,)).fetchone()["public_ref"]


def path_of(token, version, kind="tcgplayer"):
    return f"/api/public/decks/{token}/versions/{version}/exports/{kind}"


def public_get(path, *, guard=True):
    if not guard:
        return client.get(path)

    def forbidden(*args, **kwargs):
        raise AssertionError("the public Mass Entry export opened a PostgreSQL connection")
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
    assert response.headers["content-disposition"] == 'attachment; filename="tcgplayer-mass-entry.txt"'
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cache-control"] == "no-store" and response.headers["x-robots-tag"] == "noindex, nofollow"
    return response.text


def test_mass_entry_links_only_when_every_frozen_copy_has_a_current_verified_product_for_the_same_edition(store, monkeypatch):
    editions = world()
    normal, reverse, plain = editions["normal"], editions["reverse-holofoil"], editions["unspecified"]
    _, linked = publish({normal["id"]: 3, reverse["id"]: 2})
    deck, mixed = publish({normal["id"]: 3, reverse["id"]: 2, plain["id"]: 1})
    _, empty = publish({})
    with connect() as conn:  # a private edit after publishing changes nothing
        conn.execute("UPDATE holding SET quantity=quantity+10 WHERE location_id=%s AND edition_id=%s", (deck, normal["id"]))
        conn.execute("UPDATE inventory_owner SET revision=revision+1 WHERE user_id=%s", (USER,))
    ids = products(normal, reverse)
    totals = {}
    for edition, quantity in ((normal, 3), (reverse, 2)):
        totals[ids[edition["id"]]] = totals.get(ids[edition["id"]], 0) + quantity
    url = BASE + SEPARATOR.join(f"{q}-{p}" for p, q in sorted(totals.items()))

    for kind in ("tcgplayer", "tcgplayer.txt"):
        for query in ("?owner_revision=1", "?product_id=1001", "?url=https://example.test", "?quantity=60",
                      "?printing_ref=" + "a" * 48):
            refused(public_get(path_of(linked, 1, kind) + query), 422, "INVALID_REQUEST")
        refused(client.request("GET", path_of(linked, 1, kind), content=b"{}"), 422, "INVALID_REQUEST")
        refused(public_get(path_of(linked, "01", kind)), 404, "PUBLISHED_DECK_NOT_FOUND")
        refused(public_get(path_of("Z" * 32, 1, kind)), 404, "PUBLISHED_DECK_NOT_FOUND")
        refused(public_get(path_of(linked, 2, kind)), 409, "PUBLISHED_DECK_CHANGED")
        assert client.post(path_of(linked, 1, kind)).status_code == 405

    body = body_of(public_get(path_of(linked, 1)))
    assert set(body) == KEYS
    assert (body["status"], body["url"], body["fallback_reason"], body["text"], body["total_copies"], body["line_count"],
            body["less_specific_count"]) == ("link", url, None, None, "5", 1, 1)
    assert body["lines"] == [{"quantity": "5", "text": "5 Furret", "less_specific": True}]
    assert body["digest"] == public_deck.snapshot_digest(stored_decks()["decks"][linked]["snapshot"])

    before = generation(store)
    body = body_of(public_get(path_of(mixed, 1)))
    assert (body["status"], body["url"], body["fallback_reason"], body["total_copies"], body["line_count"],
            body["less_specific_count"]) == ("text", None, "missing_mapping", "6", 2, 2)
    assert sorted(body["text"].split("\n")) == ["1 Furret", "5 Furret"]
    assert text_of(public_get(path_of(mixed, 1, "tcgplayer.txt"))) == body["text"]
    assert generation(store) == before  # an export writes nothing and admits no price work
    full = body["text"]

    with monkeypatch.context() as patch:
        patch.setattr(deck_mass_entry, "MAX_URL_BYTES", len(url) - 1)
        body = body_of(public_get(path_of(linked, 1)))
        assert (body["status"], body["fallback_reason"], body["text"]) == ("text", "encoded_length", "5 Furret")

    with monkeypatch.context() as patch:
        patch.setattr(deck_mass_entry, "INLINE_LIMIT_BYTES", 3)
        body = body_of(public_get(path_of(mixed, 1)))
        assert (body["inline"], body["text"], body["lines"], body["line_count"], body["byte_length"]) == (
            False, None, [], 2, len(full.encode()))
        assert text_of(public_get(path_of(mixed, 1, "tcgplayer.txt"))) == full

    quarantine(store, normal["public_ref"])
    body = body_of(public_get(path_of(linked, 1)))
    assert (body["status"], body["fallback_reason"], body["url"], body["text"]) == ("text", "missing_mapping", None, "5 Furret")

    body = body_of(public_get(path_of(empty, 1)))
    assert (body["status"], body["url"], body["text"], body["lines"], body["total_copies"]) == ("empty", None, None, [], "0")
    refused(public_get(path_of(empty, 1, "tcgplayer.txt")), 422, "DECK_EMPTY")

    def unavailable(*args, **kwargs):
        raise ProjectionUnavailable()
    monkeypatch.setattr(published_mass_entry, "marketplace_states", unavailable)
    refused(public_get(path_of(linked, 1)), 503, "PUBLIC_CATALOG_UNAVAILABLE")


def test_legacy_and_unproven_rows_keep_complete_name_text_and_never_get_a_product(store):
    editions = world()
    normal, reverse, plain = editions["normal"], editions["reverse-holofoil"], editions["unspecified"]
    deck, token = publish({normal["id"]: 3, reverse["id"]: 2, plain["id"]: 1})
    legacy_snapshot(token)
    assert client.get(f"/api/public/decks/{token}").status_code == 200
    body = body_of(public_get(path_of(token, 1)))
    assert (body["status"], body["fallback_reason"], body["total_copies"]) == ("text", "missing_mapping", "6")
    assert sorted(line["text"] for line in body["lines"]) == ["1 Furret", "2 Furret", "3 Furret"]  # never merged without proof
    assert all(line["less_specific"] for line in body["lines"])

    assert command(USER, deck, "PUT").status_code == 200
    body = body_of(public_get(path_of(token, 2)))
    assert sorted(line["text"] for line in body["lines"]) == ["1 Furret", "5 Furret"]

    _, linked = publish({normal["id"]: 3, reverse["id"]: 2})
    assert body_of(public_get(path_of(linked, 1)))["status"] == "link"

    def change(snapshot):
        rows = [e for i in snapshot["identities"] for e in i["editions"] if e["edition_ref"] == normal["public_ref"]]
        assert len(rows) == 1
        rows[0]["printing_ref"] = printing_ref_of(plain["id"])  # a real, other Printing
    rewrite_snapshot(linked, change)
    body = body_of(public_get(path_of(linked, 1)))
    assert (body["status"], body["fallback_reason"]) == ("text", "missing_mapping")
    assert sorted(line["text"] for line in body["lines"]) == ["2 Furret", "3 Furret"]


def test_republish_rewrite_revoke_and_replay_during_a_mass_entry_export_are_never_answered_with_other_content(store, monkeypatch):
    editions = world()
    normal = editions["normal"]
    deck, token = publish({normal["id"]: 3})
    real = published_mass_entry.marketplace_states

    def during(change, version):
        """Hold one export inside its eligibility read, apply `change`, then let it finish; returns its response."""
        entered, release, box = threading.Event(), threading.Event(), {}

        def held(*args, **kwargs):
            entered.set()
            assert release.wait(10)
            return real(*args, **kwargs)
        monkeypatch.setattr(published_mass_entry, "marketplace_states", held)
        thread = threading.Thread(target=lambda: box.update(response=public_get(path_of(token, version), guard=False)))
        thread.start()
        assert entered.wait(10)
        change()
        release.set()
        thread.join(10)
        assert not thread.is_alive()
        monkeypatch.setattr(published_mass_entry, "marketplace_states", real)
        return box["response"]

    def republish():
        assert command(USER, deck, "PUT").status_code == 200

    def revoke():
        assert command(USER, deck, "DELETE").status_code == 200

    def rewrite():
        rewrite_snapshot(token, lambda s: s["identities"][0]["editions"][0].update(quantity="4"))

    refused(during(republish, 1), 409, "PUBLISHED_DECK_CHANGED")
    refused(during(rewrite, 2), 409, "PUBLISHED_DECK_CHANGED")
    stale = uuid4()
    with monkeypatch.context() as patch:
        patch.setattr(os, "replace", lambda *args, **kwargs: (_ for _ in ()).throw(OSError("injected")))
        assert command(USER, deck, "PUT", key=stale).status_code == 503
    refused(during(revoke, 2), 404, "PUBLISHED_DECK_NOT_FOUND")
    assert command(USER, deck, "PUT", key=stale).status_code == 200  # durable replay of the stale republish
    for version in (1, 2, 3):
        for kind in ("tcgplayer", "tcgplayer.txt"):
            refused(public_get(path_of(token, version, kind)), 404, "PUBLISHED_DECK_NOT_FOUND")


def test_an_unspecified_variant_never_gets_a_product_even_when_its_edition_is_verified():
    ref, printing = "a" * 48, "b" * 48

    def rows_for(variant):
        row = public_deck.FrozenRow(name="Pikachu", set_id="s", set_name="Set", collector_number="1", variant=variant,
                                    image_url=None, quantity=1, edition_ref=ref, printing_ref=printing)
        active = public_deck.ActiveSnapshot(token="t", version=1, digest="d", visibility="public", snapshot=None,
                                            rows=(row,))
        states = {ref: MarketplaceState("verified", product_id=1001, printing_ref=printing)}
        return published_mass_entry._rows(active, states)

    (unspecified,) = rows_for({"kind": "unspecified", "label": "Unspecified Variant"})
    assert unspecified.product_id is None
    assert unspecified.printing_key == printing
    (known,) = rows_for({"finish": "normal"})
    assert known.product_id == 1001
