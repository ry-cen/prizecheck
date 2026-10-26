"""Scanner batch Printing route and the finish rule's starting Edition (#310; plumbing D8)."""
import hashlib
import hmac
import json
import os
import time
from uuid import uuid4

from fastapi.testclient import TestClient

from app.catalog_search import EditionView
from app.main import app, connect
from app.scanner import default_edition
from test_catalog import headers
from test_catalog_search import promote

client = TestClient(app)
USER = "scanner-printings"
UNSPECIFIED = {"kind": "unspecified", "label": "Unspecified Variant"}


def editions(*specs):
    """EditionViews in the order given: a descriptor, or (descriptor, active)."""
    return [EditionView(id=uuid4(), descriptor=spec[0] if isinstance(spec, tuple) else spec,
                        active=spec[1] if isinstance(spec, tuple) else True, source="tcgdex") for spec in specs]


def test_no_active_edition_means_none():
    assert default_edition([]) is None
    assert default_edition(editions(({"type": "normal"}, False), ({"type": "holo"}, False))) is None


def test_the_only_active_edition_wins_even_when_inactive_ones_would_fit_better():
    found = editions(({"type": "normal"}, False), {"type": "reverse"}, ({"type": "holo"}, False))
    assert default_edition(found) == found[1].id


def test_an_active_unspecified_variant_beats_a_normal():
    found = editions({"type": "normal"}, UNSPECIFIED, {"type": "holo"})
    assert default_edition(found) == found[1].id
    found = editions({"type": "normal"}, (UNSPECIFIED, False), {"type": "holo"})
    assert default_edition(found) == found[0].id


def test_a_normal_beats_earlier_editions_and_a_subtype_of_none_is_preferred():
    found = editions({"type": "holo"}, {"type": "reverse"}, {"type": "normal"})
    assert default_edition(found) == found[2].id
    found = editions({"type": "normal", "subtype": "unlimited"}, {"type": "normal"}, {"type": "holo"})
    assert default_edition(found) == found[1].id
    found = editions({"finish": "normal"}, {"finish": "reverse"})
    assert default_edition(found) == found[0].id


def test_several_normals_take_the_first_without_a_subtype_in_order_else_the_first():
    found = editions({"type": "holo"}, {"type": "normal", "variantId": "a"}, {"type": "normal", "variantId": "b"})
    assert default_edition(found) == found[1].id
    found = editions({"type": "normal", "subtype": "x"}, {"type": "normal", "subtype": "y"}, {"type": "holo"})
    assert default_edition(found) == found[0].id
    found = editions({"type": "normal", "subtype": "x", "variantId": "1"}, {"type": "normal", "variantId": "2"},
                     {"type": "normal", "variantId": "3"})
    assert default_edition(found) == found[1].id


def test_without_a_normal_the_first_active_edition_in_order_wins():
    found = editions(({"type": "normal"}, False), {"type": "reverse"}, {"type": "holo"})
    assert default_edition(found) == found[1].id
    # A stamped Normal is not a plain Normal.
    found = editions({"type": "holo"}, {"type": "normal", "stamp": ["1st-edition"]})
    assert default_edition(found) == found[0].id
    found = editions({"type": "normal", "size": "jumbo"}, {"type": "holo"})
    assert default_edition(found) == found[0].id


def post(ids, user=USER):
    path = "/api/scanner/printings"
    body = json.dumps({"printing_ids": [str(value) for value in ids]}, separators=(",", ":"))
    return client.post(path, content=body, headers={**sign_body(user, path, body), "content-type": "application/json"})


def sign_body(user, path, body):
    stamp = str(int(time.time()))
    payload = f"POST\n{path}\n{hashlib.sha256(body.encode()).hexdigest()}\n{user}\n{stamp}".encode()
    signature = hmac.new(os.environ["INTERNAL_AUTH_SECRET"].encode(), payload, hashlib.sha256).hexdigest()
    return {"x-internal-user": user, "x-internal-time": stamp, "x-internal-signature": signature}


def seeded():
    promote({"card-1": "Pikachu", "card-2": "Raichu", "card-3": "Mew"})
    with connect() as conn:
        rows = conn.execute("SELECT id, source_id FROM catalog_printing").fetchall()
        generation = conn.execute("SELECT active_generation FROM catalog_state").fetchone()["active_generation"]
    return {row["source_id"]: row["id"] for row in rows}, generation


def test_printings_resolve_with_a_starting_edition_and_list_missing_ids():
    ids, generation = seeded()
    with connect() as conn:
        conn.execute("UPDATE catalog_generation_printing SET tombstoned=true WHERE generation_id=%s AND printing_id=%s",
                     (generation, ids["card-3"]))
        revision = conn.execute("SELECT revision FROM catalog_state").fetchone()["revision"]
    unknown = uuid4()
    response = post([ids["card-2"], unknown, ids["card-1"], ids["card-3"], ids["card-2"]])
    assert response.status_code == 200
    body = response.json()
    assert body["catalog_revision"] == revision
    assert [item["id"] for item in body["printings"]] == [str(ids["card-2"]), str(ids["card-1"])]
    assert body["missing"] == [str(unknown), str(ids["card-3"])]
    pikachu = body["printings"][1]
    assert pikachu["name"] == "Pikachu" and pikachu["low_image_url"].endswith("/low.webp") and len(pikachu["editions"]) == 2
    normal = next(edition for edition in pikachu["editions"] if edition["descriptor"].get("finish") == "normal")
    assert pikachu["default_edition_id"] == normal["id"]
    only = body["printings"][0]
    assert len(only["editions"]) == 1 and only["default_edition_id"] == only["editions"][0]["id"]


def test_inactive_editions_are_never_chosen():
    ids, generation = seeded()
    with connect() as conn:
        conn.execute("""UPDATE catalog_generation_edition SET active=false WHERE generation_id=%s AND printing_id=%s
          AND edition_id IN (SELECT id FROM catalog_edition WHERE descriptor->>'finish'='normal')""",
                     (generation, ids["card-1"]))
        conn.execute("UPDATE catalog_generation_edition SET active=false WHERE generation_id=%s AND printing_id=%s",
                     (generation, ids["card-2"]))
    body = post([ids["card-1"], ids["card-2"]]).json()
    first, second = body["printings"]
    reverse = next(edition for edition in first["editions"] if edition["active"])
    assert first["default_edition_id"] == reverse["id"] and reverse["descriptor"]["finish"] == "reverse"
    assert second["default_edition_id"] is None and not any(edition["active"] for edition in second["editions"])


def test_one_to_a_hundred_ids_and_no_catalog():
    ids, _ = seeded()
    assert post([]).status_code == 422
    assert post([uuid4() for _ in range(101)]).status_code == 422
    assert post([uuid4() for _ in range(100)]).json()["missing"].__len__() == 100
    assert client.post("/api/scanner/printings", json={"printing_ids": [str(ids["card-1"])]}).status_code == 401
    with connect() as conn:
        conn.execute("UPDATE catalog_state SET active_generation=NULL")
    body = post([ids["card-1"]]).json()
    assert body["printings"] == [] and body["missing"] == [str(ids["card-1"])]
