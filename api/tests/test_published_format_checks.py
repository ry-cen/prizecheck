"""Published Deck format results (Deck Lists 18, issue #99): anonymous HTTP against a real manifest and record store.

The cards come from minimal TCGdex records through a real catalog import, so their attributes and Reprint Groups come
from the real derivation rules and reach the record store through the catalog outbox; the rules are the real Standard
rules file unless a test deploys a revision of it.
Public calls run with PostgreSQL forbidden unless the main thread changes something through it concurrently. The
absent, forged and valid cookie proof through the real gateway is in auth/tests/published-cost.test.ts.
"""
from datetime import date
import json
import os
import threading
import time
from pathlib import Path

import psycopg
import pytest

from app.main import app, connect  # noqa: F401
from app import public_deck
from app.games.pokemon.formats import format_evaluator
from app.games.pokemon.catalog import public_catalog
from app.games.pokemon.formats import published_format_checks
from app.public_projection import ProjectionUnavailable
from app.public_records import catalog_format_key, public_record_store
from test_card_attributes import BULBASAUR_ME, ENERGY_SV, RARE_CANDY_ME, edition_of
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_deck_format_checks import CARDS
from test_holdings import call
from test_prices import client, headers_for
from test_publications import command, edition_refs, legacy_snapshot, stored_decks
from test_published_cost import (USER, body_of, generation, launches, publish, rewrite_snapshot,  # noqa: F401
                                 store)  # store and launches are autouse

LEGAL = (("me01-001", 1), ("me01-125", 4), ("me01-130", 4), ("sv02-278", 51))
OVER = (("me01-001", 1), ("fixture-sv01-901", 3), ("fixture-sv01-902", 2), ("sv05-157", 1), ("sv05-162", 1),
        ("sv02-278", 52))
UNKNOWN = (("fixture-me06-3", 4), ("fixture-me05-901", 4), ("sv02-278", 52))
ROTATING = (("me01-001", 1), ("sv01-172", 4), ("me01-125", 4), ("sv02-278", 51))
NO_BASIC = (("me01-125", 1), ("me01-130", 1), ("sv02-278", 58))
ON = "?as_of=2026-10-11"  # These snapshots are Standard: the answer is the Target Format only (app redesign #183).


def path_of(token, version, query=""):
    return f"/api/public/decks/{token}/versions/{version}/format-checks{query}"


def public_get(path, *, guard=True, headers=None):
    if not guard:
        return client.get(path, headers=headers or {})

    def forbidden(*args, **kwargs):
        raise AssertionError("the public format checks opened a PostgreSQL connection")
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(psycopg, "connect", forbidden)
        patch.setenv("DATABASE_URL", "postgresql://unreachable:1/private")
        return client.get(path, headers=headers or {})


def refused(response, status, code):
    assert response.status_code == status, response.text
    assert response.json()["detail"]["code"] == code
    assert response.headers["x-robots-tag"] == "noindex, nofollow" and response.headers["cache-control"] == "no-store"


def ref_of(source_id):
    return edition_refs(edition_of(source_id))[0]


def published(cards):
    return publish({edition_of(source_id): quantity for source_id, quantity in cards})


def standard(token, version=1, query=ON, **options):
    body = body_of(public_get(path_of(token, version, query), **options))
    [result] = body["results"]  # The snapshot's Target Format only (app redesign #183).
    assert result["format"] == "standard"
    return result


def issues(result):
    return [(issue["code"], issue["reason"], issue["kind"], issue["effect"], issue["lines"]) for issue in result["issues"]]


def timeless(results):
    """Results without ``computed_at``: each answer computes its own, and the private route may reuse a saved one."""
    return [{key: value for key, value in result.items() if key != "computed_at"} for result in results]


def public_lines(private_results):
    """The private route's results with each Edition ID replaced by its public Edition reference."""
    return timeless([{**result, "issues": [{**issue, "lines": sorted(edition_refs(line)[0] for line in issue["lines"])}
                                           for issue in result["issues"]]} for result in private_results])


def matches_private(token, deck, query="?as_of=2026-10-11", version=1):
    """The public result for ``token`` equals the private route's for ``deck``, line references mapped: both answer the
    Target Format only (app redesign #178 for the Deck, #183 for the snapshot). Returns the public result."""
    public = body_of(public_get(path_of(token, version, query)))["results"]
    response = call("GET", f"/api/decks/{deck}/format-checks{query}", USER)
    assert response.status_code == 200, response.text
    assert timeless(public) == public_lines(response.json()["results"])
    [result] = public
    return result


def manifest():
    return (Path(os.environ["PUBLIC_PROJECTION_DIR"]) / "current.json").read_bytes()


def deliver():
    with connect() as conn:
        public_catalog.drain(conn)


def test_published_results_load_anonymously_with_the_private_shape_and_match_the_private_route(store):
    reset_catalog()
    run(Records(*CARDS))
    for cards, status in ((LEGAL, "legal"), (OVER, "not_legal"), (UNKNOWN, "unknown")):
        deck, token = published(cards)
        frozen = stored_decks()["decks"][token]["snapshot"]
        before, generation_before = manifest(), generation(store)
        path = path_of(token, 1)
        variants = ({}, {"cookie": "better-auth.session_token=forged"},
                    headers_for(b"", method="GET", path=path, user=USER, budget=False))
        bodies = [body_of(public_get(path + ON, headers=headers)) for headers in variants]
        assert [{**b, "results": timeless(b["results"])} for b in bodies[1:]] == [
            {**bodies[0], "results": timeless(bodies[0]["results"])}] * 2
        body = bodies[0]
        assert set(body) == {"version", "digest", "results", "disclaimer"}
        assert (body["version"], body["digest"]) == (1, public_deck.snapshot_digest(frozen))
        assert body["disclaimer"].startswith("Advisory format checks")
        assert [set(result) for result in body["results"]] == [
            {"format", "status", "issues", "rules_version", "evaluated_on", "notes", "computed_at"}]
        assert body["results"][0]["status"] == status
        assert all(b["results"][0]["computed_at"].endswith("Z") for b in bodies)  # UTC, computed per request
        private = call("GET", f"/api/decks/{deck}/format-checks{ON}", USER)
        assert private.status_code == 200, private.text
        assert timeless(body["results"]) == public_lines(private.json()["results"])
        text = json.dumps(body)
        for secret in (USER, deck, *(edition_of(source_id) for source_id, _ in cards)):
            assert secret not in text
        # Reads write nothing: the manifest bytes and the record store generation are unchanged.
        assert manifest() == before and generation(store) == generation_before


def test_results_follow_a_rotation_without_republishing(store, monkeypatch):
    reset_catalog()
    run(Records(*CARDS))
    _, token = published(ROTATING)
    snapshot = stored_decks()["decks"][token]
    monkeypatch.setattr(published_format_checks, "today", lambda: date(2026, 4, 9))
    before = body_of(public_get(path_of(token, 1)))
    assert [(r["status"], r["evaluated_on"], r["issues"], r["notes"]) for r in before["results"]] == [
        ("legal", "2026-04-09", [], [])]
    monkeypatch.setattr(published_format_checks, "today", lambda: date(2026, 4, 10))
    after = body_of(public_get(path_of(token, 1)))
    [result] = after["results"]
    assert (result["status"], result["evaluated_on"]) == ("not_legal", "2026-04-10")
    assert issues(result) == [("not_in_card_pool", "regulation mark G rotated out of Standard on 2026-04-10", "card",
                               "not_legal", [ref_of("sv01-172")])]
    # Same token, version and frozen content: nothing was republished.
    assert (after["version"], after["digest"]) == (before["version"], before["digest"])
    assert stored_decks()["decks"][token] == snapshot
    # as_of previews either side of the rotation on any day, and a future date carries the private route's note.
    assert standard(token, query="?as_of=2026-04-09")["status"] == "legal"
    assert standard(token, query="?as_of=2026-04-10")["status"] == "not_legal"
    ahead = standard(token, query="?as_of=2026-12-01")
    assert ahead["notes"] == ["2026-12-01 is in the future: rules published after this rules file (2026-10-11) are "
                              "unknown, so this result assumes no later rule changes."]
    assert standard(token, query="?as_of=2025-04-10")["issues"][0]["code"] == "before_rules_coverage"


def test_a_reviewed_attribute_correction_changes_published_results_without_republishing(store):
    from test_attribute_corrections import decide, seed
    ids = seed(RARE_CANDY_ME, ENERGY_SV, BULBASAUR_ME)
    _, token = published((("me01-001", 1), ("me01-125", 4), ("sv02-278", 55)))
    digest = body_of(public_get(path_of(token, 1, ON)))["digest"]
    assert standard(token)["status"] == "legal"
    printing = ids["me01-125"]
    corrected = decide(printing, correction={"regulation_mark": "G"})
    assert corrected.status_code == 200, corrected.text
    assert corrected.json()["public_delivery"] == "delivered"
    result = standard(token)
    assert (result["status"], issues(result)) == ("not_legal", [
        ("not_in_card_pool", "regulation mark G rotated out of Standard on 2026-04-10", "card", "not_legal",
         [ref_of("me01-125")])])
    removed = decide(printing, decision="remove")
    assert removed.status_code == 200, removed.text
    assert removed.json()["public_delivery"] == "delivered"
    assert standard(token)["status"] == "legal"
    assert body_of(public_get(path_of(token, 1, ON)))["digest"] == digest


def test_a_reimport_that_changes_a_derived_attribute_changes_published_results(store):
    reset_catalog()
    run(Records(*CARDS))
    _, token = published(LEGAL)
    assert standard(token)["status"] == "legal"
    with connect() as conn:
        edition = conn.execute("SELECT mapping_revision,public_revision FROM catalog_edition_metadata WHERE edition_id=%s",
                               (edition_of("me01-125"),)).fetchone()
    run(Records(*({**record, "regulationMark": "G"} if record["id"] == "me01-125" else record for record in CARDS)))
    result = standard(token)
    assert (result["status"], issues(result)) == ("not_legal", [
        ("not_in_card_pool", "regulation mark G rotated out of Standard on 2026-04-10", "card", "not_legal",
         [ref_of("me01-125")])])
    with connect() as conn:  # Only the Printing was re-stamped: its Edition and mapping revision did not move.
        assert conn.execute("SELECT mapping_revision,public_revision FROM catalog_edition_metadata WHERE edition_id=%s",
                            (edition_of("me01-125"),)).fetchone() == edition


def test_a_card_identity_change_reaches_published_results(store):
    reset_catalog()
    run(Records(*CARDS))
    deck, token = published((("me01-001", 1), ("fixture-sv01-901", 3), ("me01-130", 2), ("sv02-278", 54)))
    assert standard(token)["status"] == "legal"
    # A reviewed identity merge (ticket 14) moves a Printing to another Card Identity; migration 036 re-stamps it.
    with connect() as conn, conn.transaction():
        conn.execute("SELECT catalog_begin_correction()")
        conn.execute("""UPDATE catalog_printing SET identity_id=(SELECT identity_id FROM catalog_printing
          WHERE source_id='fixture-sv01-901') WHERE source_id='me01-130'""")
    deliver()
    lines = sorted([ref_of("fixture-sv01-901"), ref_of("me01-130")])
    result = standard(token)
    assert issues(result) == [("copy_limit", "more than 4 copies of Professor's Research (5)", "card", "not_legal",
                               lines)]
    matches_private(token, deck)
    # Renaming the identity re-stamps every Printing of it.
    with connect() as conn, conn.transaction():
        conn.execute("SELECT catalog_begin_correction()")
        conn.execute("""UPDATE catalog_identity SET display_name='Professor''s Research Merged'
          WHERE id=(SELECT identity_id FROM catalog_printing WHERE source_id='me01-130')""")
    deliver()
    assert issues(standard(token)) == [
        ("copy_limit", "more than 4 copies of Professor's Research Merged (5)", "card", "not_legal", lines)]


def test_legacy_and_unproven_rows_are_unknown_and_never_legal(store):
    reset_catalog()
    run(Records(*CARDS))
    deck, token = published(LEGAL)
    legacy_snapshot(token)
    result = standard(token)
    assert result["status"] == "unknown"
    unavailable = [issue for issue in result["issues"] if issue["code"] == "card_data_unavailable"]
    assert [(i["reason"], i["kind"], i["effect"], i["lines"]) for i in unavailable] == [
        ("card data not available for this published card", "card", "unknown", ["row:0", "row:1", "row:2", "row:3"])]
    assert {issue["code"] for issue in result["issues"]} <= {"card_data_unavailable", "attribute_unknown"}

    assert command(USER, deck, "PUT").status_code == 200
    assert standard(token, version=2)["status"] == "legal"
    key = catalog_format_key(edition_refs(edition_of("me01-130"))[1])
    good = store.read_records([key], deadline=time.monotonic() + 5).records[key]
    for broken in (None, {**good.value, "reprint_group": "a" * 48}, {**good.value, "extra": 1},
                   {**good.value, "attributes": {**good.value["attributes"], "regulation_mark": "i"}},
                   {**good.value, "attributes": {**good.value["attributes"], "basic_pokemon": "yes"}},
                   # A record written before migration 038 has no Basic Pokémon status.
                   {**good.value, "attributes": {key: value for key, value in good.value["attributes"].items()
                                                 if key != "basic_pokemon"}},
                   {**good.value, "identity": {"key": "Switch"}}, {**good.value, "printing_ref": "f" * 48}):
        current = store.read_records([key], deadline=time.monotonic() + 5).records[key]
        assert store.compare_and_swap({key: current.version}, {key: broken}, deadline=time.monotonic() + 5)
        result = standard(token, version=2)
        assert result["status"] == "unknown", broken
        assert ("card_data_unavailable", "card data not available for this published card", "card", "unknown",
                [ref_of("me01-130")]) in issues(result), broken
        assert not any(issue["code"] in ("set_date_not_recorded", "regulation_mark_not_recorded")
                       for issue in result["issues"]), broken


def test_query_body_and_syntax_are_validated_with_public_headers(store):
    reset_catalog()
    run(Records(*CARDS))
    _, token = published(LEGAL)
    # There is no ``format``: the answer is the snapshot's Target Format (app redesign #183), so naming one is refused.
    for query in ("?owner=1", "?format=standard", "?format=expanded", "?format=unlimited", "?format=",
                  "?format=standard&format=standard", "?as_of=2026-10-11&as_of=2026-10-12", "?&",
                  "?printing_ref=" + "a" * 48):
        refused(public_get(path_of(token, 1, query)), 422, "INVALID_REQUEST")
    refused(client.request("GET", path_of(token, 1), content=b"{}"), 422, "INVALID_REQUEST")
    for as_of in ("2026-4-10", "20260410", "2026-02-30", "today", "2026-04-10T00:00", "", "2026-04-10" + "0" * 50):
        refused(public_get(path_of(token, 1, f"?as_of={as_of}")), 422, "INVALID_AS_OF")
    refused(public_get(path_of(token, "01")), 404, "PUBLISHED_DECK_NOT_FOUND")
    refused(public_get(path_of("Z" * 32, 1)), 404, "PUBLISHED_DECK_NOT_FOUND")
    refused(public_get(path_of("short", 1, "?as_of=today")), 404, "PUBLISHED_DECK_NOT_FOUND")
    refused(public_get(path_of(token, 2)), 409, "PUBLISHED_DECK_CHANGED")
    assert client.post(path_of(token, 1)).status_code == 405


def test_revoke_republish_rewrite_and_outages_behave_like_the_published_cost_route(store, monkeypatch):
    reset_catalog()
    run(Records(*CARDS))
    deck, token = published(LEGAL)
    real = published_format_checks.format_facts

    def during(change, version):
        """Hold one check inside its format-fact read, apply `change`, then let it finish; returns its response."""
        entered, release, box = threading.Event(), threading.Event(), {}

        def held(*args, **kwargs):
            entered.set()
            assert release.wait(10)
            return real(*args, **kwargs)
        monkeypatch.setattr(published_format_checks, "format_facts", held)
        thread = threading.Thread(target=lambda: box.update(response=public_get(path_of(token, version, ON), guard=False)))
        thread.start()
        assert entered.wait(10)
        change()
        release.set()
        thread.join(10)
        assert not thread.is_alive()
        monkeypatch.setattr(published_format_checks, "format_facts", real)
        return box["response"]

    def republish():
        assert command(USER, deck, "PUT").status_code == 200

    def rewrite():
        rewrite_snapshot(token, lambda s: s["identities"][0]["editions"][0].update(quantity="4"))

    def revoke():
        assert command(USER, deck, "DELETE").status_code == 200

    refused(during(republish, 1), 409, "PUBLISHED_DECK_CHANGED")
    refused(public_get(path_of(token, 1, ON)), 409, "PUBLISHED_DECK_CHANGED")
    assert standard(token, version=2)["status"] == "legal"
    refused(during(rewrite, 2), 409, "PUBLISHED_DECK_CHANGED")

    def down(*args, **kwargs):
        raise ProjectionUnavailable()
    with monkeypatch.context() as patch:
        patch.setattr(published_format_checks, "format_facts", down)
        refused(public_get(path_of(token, 2, ON)), 503, "PUBLIC_CATALOG_UNAVAILABLE")
    with monkeypatch.context() as patch:
        patch.setattr(public_deck, "_record", down)
        refused(public_get(path_of(token, 2, ON)), 503, "PUBLIC_PROJECTION_UNAVAILABLE")

    refused(during(revoke, 2), 404, "PUBLISHED_DECK_NOT_FOUND")
    for version in (1, 2, 3):
        refused(public_get(path_of(token, version, ON)), 404, "PUBLISHED_DECK_NOT_FOUND")


# ------------------------------------------------------------------ Reprint Groups (ticket 13)


def reprint_catalog():
    """The Reprint Group fixture of test_reprint_groups.py, imported and delivered; returns its module."""
    import test_reprint_groups as groups  # Imported here: it needs app.main loaded first.
    reset_catalog()
    run(Records(*groups.CARDS))
    return groups


def format_record(source_id):
    with connect() as conn:
        ref = conn.execute("SELECT public_ref FROM catalog_printing WHERE source_id=%s", (source_id,)).fetchone()["public_ref"]
    key = catalog_format_key(ref)
    return key, ref, public_record_store().read_records([key], deadline=time.monotonic() + 5).records[key]


def printing_revisions(*source_ids):
    with connect() as conn:
        return {row["source_id"]: row["public_revision"] for row in conn.execute(
            """SELECT p.source_id,m.public_revision FROM catalog_printing p JOIN catalog_printing_metadata m
              ON m.printing_id=p.id WHERE p.source_id=ANY(%s)""", (list(source_ids),))}


def test_reprint_inherited_legality_matches_the_private_route_and_follows_group_changes(store):
    groups = reprint_catalog()
    # Each is out of Standard on its own on 2026-10-11; me01-125 (mark I) in their group makes all of them legal.
    deck, token = published((("sv01-191", 2), ("swsh1-180", 1), ("swsh12.5-141", 1), ("svp-225", 1), ("sv02-278", 55)))
    result = matches_private(token, deck)
    assert (result["status"], result["issues"]) == ("legal", [])
    # The group is published by its public reference and its printings' public references, never its internal ID.
    _, _, record = format_record("sv01-191")
    group_id = groups.groups_of("sv01-191")["sv01-191"]
    members = sorted(format_record(source_id)[1] for source_id in
                     ("me01-125", "sv01-191", "swsh1-180", "swsh12.5-141", "fixture-sv04.5-901"))
    assert record.value["reprint_group"] == {"ref": public_catalog.reprint_group_ref(group_id), "printings": members}
    assert str(group_id) not in json.dumps(record.value)
    assert format_record("sv02-278")[2].value["reprint_group"] is None  # Basic Energy is in no group
    # Rewording me01-125 moves it to a group of its own. sv01-191's own group row never changes, but its record lists
    # one printing fewer, so the published result changes without a republish.
    reworded = groups.edited(groups.CANDY_ME, effect=groups.ME_CANDY.replace("first turn", "first two turns"))
    run(Records(*(reworded if card is groups.CANDY_ME else card for card in groups.CARDS)))
    listed = format_record("sv01-191")[2].value["reprint_group"]["printings"]
    assert listed == [ref for ref in members if ref != format_record("me01-125")[1]]
    result = matches_private(token, deck)
    assert result["status"] == "not_legal"
    assert {(code, reason, kind, effect, tuple(lines)) for code, reason, kind, effect, lines in issues(result)} == {
        ("not_in_card_pool", "regulation mark G rotated out of Standard on 2026-04-10", "card", "not_legal",
         (ref_of("sv01-191"),)),
        ("not_in_card_pool", "not in the Standard card pool: Sword & Shield era, regulation marks D to F, all rotated "
                             "out by 2025-04-11", "card", "not_legal",
         tuple(sorted([ref_of("swsh1-180"), ref_of("swsh12.5-141")])))}


def test_a_ban_on_one_printing_reaches_its_identical_reprints_like_the_private_route(store, monkeypatch):
    reprint_catalog()
    deck, token = published((("sv01-191", 4), ("svp-225", 1), ("sv02-278", 55)))
    assert matches_private(token, deck)["status"] == "legal"
    # A deployed rules revision bans me01-125 from 2026-10-01: sv01-191, legal only through it, is banned with it.
    source = (format_evaluator.RULES_DIR / "standard.toml").read_text()
    assert source.count("bans = []") == 1
    banned = format_evaluator.load_rules(source.replace("bans = []", 'bans = [\n  { set = "me01", number = "125", '
                                                        'name = "Rare Candy", banned_from = 2026-10-01 },\n]').encode())
    real_rules = format_evaluator.format_rules
    monkeypatch.setattr(format_evaluator, "format_rules",
                        lambda name: banned if name == "standard" else real_rules(name))
    result = matches_private(token, deck)
    assert issues(result) == [("banned", "banned in Standard from 2026-10-01 as an identical reprint of Rare Candy "
                                         "(me01 125)", "card", "not_legal", [ref_of("sv01-191")])]
    assert matches_private(token, deck, "?as_of=2026-09-30")["status"] == "legal"


def test_a_pokemon_with_a_legal_identical_reprint_stays_not_legal_publicly(store):
    reprint_catalog()
    deck, token = published((("svp-101", 4), ("sv02-278", 56)))
    assert format_record("svp-101")[2].value["reprint_group"] is not None
    assert issues(matches_private(token, deck)) == [
        ("not_in_card_pool", "regulation mark G rotated out of Standard on 2026-04-10", "card", "not_legal",
         [ref_of("svp-101")])]
    deck, token = published((("svp-225", 4), ("sv02-278", 56)))
    assert matches_private(token, deck)["status"] == "legal"


def test_an_unproven_reprint_makes_its_line_unknown_never_legal_or_not_legal(store):
    reprint_catalog()
    _, token = published((("sv01-191", 4), ("svp-225", 1), ("sv02-278", 55)))
    assert standard(token)["status"] == "legal"
    unavailable = ("card_data_unavailable", "card data not available for this published card", "card", "unknown",
                   [ref_of("sv01-191")])

    def unproven(result):
        """Unknown through the one unavailable line: its unknown attributes may add attribute gaps, nothing else."""
        return (result["status"] == "unknown" and unavailable in issues(result)
                and {issue["code"] for issue in result["issues"]} <= {"card_data_unavailable", "attribute_unknown"})

    def swap(source_id, value):
        key, _, current = format_record(source_id)
        assert store.compare_and_swap({key: current.version}, {key: value}, deadline=time.monotonic() + 5)

    # A printing of the line's group whose record is missing, malformed, names another group or none: records
    # delivered at different times. The line is unknown, never legal through the group nor not legal without it.
    me01 = format_record("me01-125")[2].value
    group = me01["reprint_group"]
    for broken in (None, {**me01, "extra": 1}, {**me01, "reprint_group": {**group, "ref": "b" * 48}},
                   {**me01, "reprint_group": None}):
        swap("me01-125", broken)
        assert unproven(standard(token)), broken
    swap("me01-125", me01)
    assert standard(token)["status"] == "legal"
    # The line's own group malformed: an unsorted or repeated list, a bad reference, a missing list, a bare reference.
    sv01 = format_record("sv01-191")[2].value
    for broken in ({**group, "printings": list(reversed(group["printings"]))},
                   {**group, "printings": group["printings"] * 2}, {**group, "ref": "B" * 48},
                   {"ref": group["ref"]}, group["ref"]):
        swap("sv01-191", {**sv01, "reprint_group": broken})
        assert unproven(standard(token)), broken
    swap("sv01-191", sv01)
    assert standard(token)["status"] == "legal"


def test_a_reprint_group_change_restamps_every_printing_of_the_groups_it_touches(store):
    groups = reprint_catalog()
    old_group = ("me01-125", "swsh1-180", "swsh12.5-141", "fixture-sv04.5-901")
    bystanders = ("sm1-129", "sm2-165", "svp-101", "sv02-278")
    every = ("sv01-191", *old_group, *bystanders)
    before = printing_revisions(*every)
    # Rewriting a row's text key or rules version keeps its group: no fact changes, nothing is stamped.
    with connect() as conn, conn.transaction():
        conn.execute("SELECT catalog_begin_correction()")
        conn.execute("""UPDATE catalog_derived_reprint_group SET text_key=repeat('0',64),rules_version=rules_version+1
          WHERE printing_id=(SELECT id FROM catalog_printing WHERE source_id='sv01-191')""")
    assert printing_revisions(*every) == before
    # sv01-191 leaves its group: it and every printing still in that group are stamped once; other groups are not.
    with connect() as conn, conn.transaction():
        conn.execute("SELECT catalog_begin_correction()")
        conn.execute("""DELETE FROM catalog_derived_reprint_group
          WHERE printing_id=(SELECT id FROM catalog_printing WHERE source_id='sv01-191')""")
    after = printing_revisions(*every)
    stamped = {source_id for source_id in every if after[source_id] != before[source_id]}
    assert stamped == {"sv01-191", *old_group}
    assert len({after[source_id] for source_id in stamped}) == 1
    deliver()
    assert format_record("sv01-191")[2].value["reprint_group"] is None
    listed = format_record("me01-125")[2].value["reprint_group"]["printings"]
    assert format_record("sv01-191")[1] not in listed and len(listed) == len(old_group)
    # A rederivation puts it back: the same printings are stamped again, and the records list it again.
    with connect() as conn:
        from app.games.pokemon.catalog.catalog import rederive_card_attributes
        rederive_card_attributes(conn)
    again = printing_revisions(*every)
    assert {source_id for source_id in every if again[source_id] != after[source_id]} == {"sv01-191", *old_group}
    deliver()
    assert format_record("sv01-191")[2].value["reprint_group"]["ref"] == public_catalog.reprint_group_ref(
        groups.groups_of("sv01-191")["sv01-191"])


def test_a_deck_without_a_basic_pokemon_is_not_legal_publicly_like_the_private_route(store):
    reset_catalog()
    run(Records(*CARDS))
    deck, token = published(NO_BASIC)
    result = matches_private(token, deck)
    assert (result["status"], issues(result)) == ("not_legal", [
        ("no_basic_pokemon", "a Standard deck has at least one Basic Pokémon; this one has none", "deck", "not_legal",
         sorted(ref_of(source_id) for source_id, _ in NO_BASIC))])
    # The format record carries the Basic Pokémon status the private route reads.
    key = catalog_format_key(edition_refs(edition_of("me01-001"))[1])
    deck, token = published(LEGAL)
    assert store.read_records([key], deadline=time.monotonic() + 5).records[key].value["attributes"][
        "basic_pokemon"] is True
    assert matches_private(token, deck)["status"] == "legal"


def test_records_published_before_basic_pokemon_status_are_unproven_until_the_backfill(store):
    """A store written by a release before migration 038 holds format records without ``basic_pokemon``. The strict
    reader refuses them (unknown, never legal), and scripts/backfill_public_catalog.py rewrites them at their revision
    without calling them recovery conflicts."""
    reset_catalog()
    run(Records(*CARDS))
    deck, token = published(LEGAL)
    keys = [catalog_format_key(edition_refs(edition_of(source_id))[1]) for source_id, _ in LEGAL]
    for key, record in store.read_records(keys, deadline=time.monotonic() + 5).records.items():
        old = {**record.value, "attributes": {name: value for name, value in record.value["attributes"].items()
                                              if name != "basic_pokemon"}}
        assert store.compare_and_swap({key: record.version}, {key: old}, deadline=time.monotonic() + 5)
    result = standard(token)
    assert result["status"] == "unknown"
    assert ("card_data_unavailable", "card data not available for this published card", "card", "unknown",
            sorted(ref_of(source_id) for source_id, _ in LEGAL)) in issues(result)
    with connect() as conn:
        rebuilt = public_catalog.rebuild(conn, store)
    assert rebuilt.conflicts == 0 and rebuilt.written >= len(LEGAL)
    assert matches_private(token, deck)["status"] == "legal"
