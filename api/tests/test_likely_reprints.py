"""Likely reprints compare structure, while dismissals follow the normalized text keys."""
from copy import deepcopy

import pytest

from app.main import connect
from app.games.pokemon.catalog.card_attributes import attribute_revision
from test_card_attributes import card
from test_holdings import call, client  # noqa: F401
from test_reprint_group_reviews import OWNER, OTHER, seed, ok, decide, identity_of, evidence, groups

ROUTE = "/api/admin/card-identities/likely-reprints"


def records():
    left = card(id="fixture-sv01-901", localId="901", name="Psyduck", category="Pokemon",
                set={"id": "sv01", "name": "Scarlet & Violet"}, hp=70, types=["Water"], regulationMark="G",
                attacks=[{"name": "Collision", "cost": ["Water", "Colorless"], "damage": "10×"}],
                abilities=[{"type": "Ability", "name": "Damp", "effect": "Older wording."}])
    right = deepcopy(left)
    right.update(id="fixture-sv02-902", localId="902", set={"id": "sv02", "name": "Paldea Evolved"})
    right["attacks"] = [{"name": "Ram", "cost": ["Colorless", "Water"], "damage": "10x"}]
    right["abilities"][0]["effect"] = "New wording."
    return left, right


def queue():
    return ok(call("GET", ROUTE, OWNER))["items"]


def test_positive_dismiss_undo_and_changed_text_key():
    seed(*records())
    pair, = queue()
    assert len(pair["printings"]) == 2
    with connect() as conn:
        revision = attribute_revision(conn)
    decision = ok(call("POST", ROUTE + "/dismiss", OWNER, {"key": pair["key"], "evidence_digest": pair["evidence_digest"]}))
    assert queue() == []
    with connect() as conn:
        assert attribute_revision(conn) == revision
    ok(call("POST", ROUTE + f'/{decision["id"]}/undo', OWNER, {"evidence_digest": pair["evidence_digest"]}))
    assert len(queue()) == 1
    ok(call("POST", ROUTE + "/dismiss", OWNER, {"key": pair["key"], "evidence_digest": pair["evidence_digest"]}))
    with connect() as conn:
        conn.execute("UPDATE catalog_derived_reprint_group SET text_key=%s WHERE printing_id=%s",
                     ("a" * 64, pair["printings"][0]["printing_id"]))
    assert len(queue()) == 1


@pytest.mark.parametrize("negative", ["damage", "mark", "unknown", "merged", "withdrawn"])
def test_negative(negative):
    left, right = records()
    left["attacks"][0]["name"] = f"Negative {negative}"
    if negative == "damage":
        right["attacks"][0]["damage"] = "20"
    elif negative == "mark":
        right["regulationMark"] = "H"
    elif negative == "unknown":
        right.pop("regulationMark")
    ids = seed(left, right)
    if negative == "merged":
        identity = identity_of(ids[left["id"]])
        memberships = groups(evidence(identity))
        ok(decide(identity, "merge", group=memberships[ids[left["id"]]], target=memberships[ids[right["id"]]]))
    with connect() as conn:
        if negative == "withdrawn":
            conn.execute("UPDATE catalog_generation_printing SET tombstoned=true WHERE printing_id=%s",
                         (ids[right["id"]],))
    assert queue() == []


def test_owner_only():
    left, right = records()
    left["attacks"][0]["name"] = "Owner test"
    seed(left, right)
    pair, = queue()
    for method, path, body in [("GET", ROUTE, None), ("POST", ROUTE + "/dismiss", {"key": pair["key"], "evidence_digest": pair["evidence_digest"]}),
                               ("POST", ROUTE + "/00000000-0000-0000-0000-000000000000/undo", {"evidence_digest": pair["evidence_digest"]})]:
        response = call(method, path, OTHER, body) if body is not None else call(method, path, OTHER)
        assert response.status_code == 403


def test_stale_text_evidence_and_repeated_undo():
    left, right = records()
    left["attacks"][0]["name"] = "Stale test"
    seed(left, right)
    pair, = queue()
    body = {"key": pair["key"], "evidence_digest": pair["evidence_digest"]}
    first = ok(call("POST", ROUTE + "/dismiss", OWNER, body))
    ok(call("POST", ROUTE + f'/{first["id"]}/undo', OWNER, body))
    ok(call("POST", ROUTE + "/dismiss", OWNER, body))
    assert call("POST", ROUTE + f'/{first["id"]}/undo', OWNER, body).status_code == 409
    assert queue() == []
    with connect() as conn:
        conn.execute("UPDATE catalog_derived_reprint_group SET text_key=%s WHERE printing_id=%s",
                     ("b" * 64, pair["printings"][0]["printing_id"]))
    assert call("POST", ROUTE + "/dismiss", OWNER, body).status_code == 409
    assert call("POST", ROUTE + f'/{first["id"]}/undo', OWNER, body).status_code == 409
    assert len(queue()) == 1


def test_undo_resurfaced_pair_preserves_earlier_transitions():
    left, right = records()
    left["attacks"][0]["name"] = "Resurfaced test"
    seed(left, right)
    pair, = queue()
    body = {"key": pair["key"], "evidence_digest": pair["evidence_digest"]}
    ok(call("POST", ROUTE + "/dismiss", OWNER, body))
    # Add another text to the same effective group: the pair now includes old and new cross keys.
    third = deepcopy(left)
    third.update(id="fixture-sv01-903", localId="903")
    third["abilities"][0]["effect"] = "Third wording."
    from test_reprint_group_reviews import run, Records, ids_of
    run(Records(left, right, third))
    ids = ids_of(left["id"], right["id"], third["id"])
    with connect() as conn:
        group = conn.execute("SELECT group_id FROM catalog_reprint_group_member WHERE printing_id=%s",
                             (ids[left["id"]],)).fetchone()["group_id"]
        conn.execute("UPDATE catalog_reprint_group_member SET group_id=%s WHERE printing_id=%s",
                     (group, ids[third["id"]]))
    resurfaced, = queue()
    body = {"key": resurfaced["key"], "evidence_digest": resurfaced["evidence_digest"]}
    decision = ok(call("POST", ROUTE + "/dismiss", OWNER, body))
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_likely_reprint_decision WHERE batch_id=%s",
                            (decision["id"],)).fetchone()["n"] == 1
    ok(call("POST", ROUTE + f'/{decision["id"]}/undo', OWNER, body))
    from app.games.pokemon.catalog.reprint_group_reviews import dismissed_keys
    with connect() as conn:
        assert tuple(sorted(p["text_key"] for p in pair["printings"])) in dismissed_keys(conn)
