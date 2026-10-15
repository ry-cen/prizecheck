"""Replace a Deck's list (decklist import #215): ``POST /api/decks/import/review`` with a ``deck_id``, then the existing
``POST /api/decks/{id}/deck-list/changes`` batch, through signed HTTP.

The review checks the Deck is the caller's (404 DECK_NOT_FOUND otherwise), uses the Deck's own copies first (under
Exact printings too, in their own Edition), and answers ``replace``: the Deck List revision, the current lines, the
changes batch (every Edition of the new list at its total, then 0 for every current line it doesn't name) and the
Surplus preview. Saving is that batch at that revision; nothing moves, so the Deck detail's Surplus then equals the
preview. Undo is the inverse batch.

The world (``world``) is the browser spec's: an older Charizard ex keeps 1 Iono PAL 185 for its own line of 2 and holds 2
Iono PAL 254 it no longer lists; the replaced Gardevoir ex holds 2 Iono PAL 185 Reverse Holo, 3 Nest Ball, 2 Basic
Psychic Energy SVE 005 and 1 Basic Darkness Energy SVE 015, all listed; a Binder and an Attic box hold 1 Basic
Psychic Energy MEE 005 each, and the Binder 1 Iono PAL 185.
"""
from uuid import uuid4

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import counting, deck, detail, hold, line, new_owner
from test_deck_import import sql
from test_holdings import call
from test_import_owned import editions, place

REVIEW = "/api/decks/import/review"
PASTE = "4 Iono PAL 185\n1 Nest Ball SVI 181\n4 Basic Psychic Energy SVE 13\n"


def review(owner, text, deck_id, owned=None, fixes=(), expect=200):
    body = {"source": {"text": text}, "fixes": list(fixes), "deck_id": deck_id}
    if owned is not None:
        body["owned"] = owned
    response = call("POST", REVIEW, owner, body)
    assert response.status_code == expect, response.text
    return response.json()


def save(owner, deck_id, changes, revision):
    return call("POST", f"/api/decks/{deck_id}/deck-list/changes", owner,
                {"revision": revision, "idempotency_key": str(uuid4()), "changes": changes})


def lines(deck_list):
    return {entry["edition_id"]: entry["quantity"] for entry in deck_list}


def parts(body, index):
    """A line's parts as (Edition, quantity, source, [(place name, copies)])."""
    return [(part["edition_id"], part["quantity"], part["source"],
             [(where["name"], where["quantity"]) for where in part["places"]])
            for part in body["lines"][index]["parts"]]


def held(owner, location):
    response = call("GET", f"/api/holdings/{location}", owner)
    assert response.status_code == 200, response.text
    return {row["edition_id"]: (row["quantity"], row["version"]) for row in response.json()["holdings"]}


def world():
    e = {**editions(), "NB": sql("""SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
                                    WHERE p.source_id='sv01-181' AND e.descriptor->>'finish'='normal'""")[0][0]}
    e["NB"] = str(e["NB"])
    owner, _ = new_owner()
    binder, attic = place(owner, "Binder"), place(owner, "Attic box")
    charizard, gardevoir = deck(owner, "Charizard ex", 1), deck(owner, "Gardevoir ex", 2)
    hold(owner, binder, e["185"], 1)
    hold(owner, binder, e["PM5"], 1)
    hold(owner, attic, e["PM5"], 1)
    hold(owner, charizard, e["185"], 1)
    line(owner, charizard, e["185"], 2)
    hold(owner, charizard, e["254"], 2)
    line(owner, charizard, e["254"], 0)
    for edition, copies in (("185R", 2), ("NB", 3), ("P5", 2), ("D15", 1)):
        hold(owner, gardevoir, e[edition], copies)
    return e, owner, {"binder": binder, "attic": attic, "charizard": charizard, "gardevoir": gardevoir}


def test_the_decks_own_copies_come_first_and_the_answer_carries_the_revision_the_current_list_and_the_batch(launches):
    e, owner, at = world()
    before = detail(owner, at["gardevoir"])["deck_list"]
    body = review(owner, PASTE, at["gardevoir"])
    # Iono: the Deck's own Reverse Holos first, then Charizard ex's 2 PAL 254, which it no longer lists (spare).
    assert [part[:3] for part in parts(body, 0)] == [(e["185R"], "2", "in_deck"), (e["254"], "2", "elsewhere")]
    assert parts(body, 0)[0][3] == [] and [copies for _, copies in parts(body, 0)[1][3]] == ["2"]
    assert parts(body, 0)[1][3][0][0].startswith("Charizard ex")
    assert parts(body, 1) == [(e["NB"], "1", "in_deck", [])]
    assert parts(body, 2) == [(e["P5"], "2", "in_deck", []),
                              (e["PM5"], "2", "elsewhere", [("Attic box", "1"), ("Binder", "1")])]
    assert body["totals"]["owned"] == "9" and body["totals"]["to_get"] == "0"
    replace = body["replace"]
    assert replace["deck_id"] == at["gardevoir"] and replace["name"].startswith("Gardevoir ex")
    assert replace["deck_list_revision"] == before["revision"]
    assert lines(replace["current"]) == {row["edition_id"]: row["quantity"] for row in before["lines"]}
    assert [row["edition_id"] for row in replace["current"]] == sorted(row["edition_id"] for row in before["lines"])
    # Every Edition of the new list at its total, in the new list's order, then 0 for the current line it drops.
    assert [(row["edition_id"], row["quantity"]) for row in replace["changes"]] == [
        *((row["edition_id"], row["quantity"]) for row in body["deck_list"]), (e["D15"], "0")]
    assert lines(body["deck_list"]) == {e["185R"]: "2", e["254"]: "2", e["NB"]: "1", e["P5"]: "2", e["PM5"]: "2"}
    assert launches == []
    # Without a deck_id the review is a new Deck's, with no replace.
    assert review(owner, PASTE, None)["replace"] is None


def test_exact_printings_keeps_the_decks_copies_of_the_named_printing_in_their_own_edition():
    e, owner, at = world()
    body = review(owner, "4 Iono PAL 185\n", at["gardevoir"], "exact")
    assert [part[:3] for part in parts(body, 0)] == [(e["185R"], "2", "in_deck"), (e["185"], "2", "new")]
    # Copies another Deck keeps are noted, singular: Charizard ex keeps 1 for its own line and counts the Binder's 1.
    assert [(kept["deck_id"], kept["quantity"], kept["reason"]) for kept in body["lines"][0]["kept"]] == [
        (at["charizard"], "1", "own_line"), (at["charizard"], "1", "counted")]
    # A new Deck has no copies of its own: the same paste takes no Reverse Holo.
    assert [part[2] for part in parts(review(owner, "4 Iono PAL 185\n", None, "exact"), 0)] == ["new"]


def test_the_surplus_preview_includes_cards_no_line_reaches_and_equals_the_deck_detail_after_saving():
    e, owner, at = world()
    # Nest Ball held beyond its line before the Replace: already Surplus, and still Surplus after it.
    line(owner, at["gardevoir"], e["NB"], 2)
    for owned, expected in (("owned", {e["NB"]: "2", e["D15"]: "1"}),
                            ("exact", {e["NB"]: "2", e["P5"]: "2", e["D15"]: "1"})):
        body = review(owner, PASTE, at["gardevoir"], owned)
        preview = body["replace"]["surplus"]
        # Basic Darkness Energy is in no pasted line's reach: the capture never reads it, the preview still names it.
        assert lines(preview) == expected
        assert [row["edition_id"] for row in preview] == sorted(expected)
        assert preview[0]["name"] and preview[0]["set_name"] and "version" in preview[0]
    saved = save(owner, at["gardevoir"], body["replace"]["changes"], body["replace"]["deck_list_revision"])
    assert saved.status_code == 200, saved.text
    assert lines(saved.json()["deck_list"]["lines"]) == lines(body["deck_list"])
    assert detail(owner, at["gardevoir"])["surplus"] == preview


def test_saving_moves_no_holding_and_the_inverse_batch_restores_the_old_list_exactly():
    e, owner, at = world()
    before = detail(owner, at["gardevoir"])
    holdings = {name: held(owner, location) for name, location in at.items()}
    revision = call("GET", "/api/collection/revision", owner).json()["owner_revision"]
    undo_records = call("GET", "/api/moves/undo", owner).json()
    replace = review(owner, PASTE, at["gardevoir"])["replace"]
    saved = save(owner, at["gardevoir"], replace["changes"], replace["deck_list_revision"])
    assert saved.status_code == 200, saved.text
    assert saved.json()["deck_list"]["revision"] == replace["deck_list_revision"] + 1
    assert {name: held(owner, location) for name, location in at.items()} == holdings
    assert call("GET", "/api/collection/revision", owner).json()["owner_revision"] == revision
    assert call("GET", "/api/moves/undo", owner).json() == undo_records
    # Undo: every Edition of the batch back to its current quantity, or 0, at the revision the save answered.
    current = lines(replace["current"])
    inverse = [{"edition_id": row["edition_id"], "quantity": current.get(row["edition_id"], "0")}
               for row in replace["changes"]]
    undone = save(owner, at["gardevoir"], inverse, saved.json()["deck_list"]["revision"])
    assert undone.status_code == 200, undone.text
    after = detail(owner, at["gardevoir"])
    assert lines(after["deck_list"]["lines"]) == lines(before["deck_list"]["lines"])
    assert after["surplus"] == before["surplus"]
    assert {name: held(owner, location) for name, location in at.items()} == holdings


def test_a_save_after_another_edit_is_stale_and_a_fresh_review_saves():
    e, owner, at = world()
    replace = review(owner, PASTE, at["gardevoir"])["replace"]
    line(owner, at["gardevoir"], e["NB"], 4)
    stale = save(owner, at["gardevoir"], replace["changes"], replace["deck_list_revision"])
    assert (stale.status_code, stale.json()["detail"]["code"]) == (409, "STALE_DECK_LIST")
    assert lines(detail(owner, at["gardevoir"])["deck_list"]["lines"])[e["NB"]] == "4"
    fresh = review(owner, PASTE, at["gardevoir"])["replace"]
    assert fresh["deck_list_revision"] == replace["deck_list_revision"] + 1
    assert lines(fresh["current"])[e["NB"]] == "4"
    assert save(owner, at["gardevoir"], fresh["changes"], fresh["deck_list_revision"]).status_code == 200


def test_dropping_every_line_removes_every_current_line_and_every_held_card_becomes_surplus():
    e, owner, at = world()
    body = review(owner, "1 Nest Ball SVI 181\n", at["gardevoir"], fixes=[{"line": 1, "drop": True}])
    assert body["deck_list"] == []
    assert lines(body["replace"]["changes"]) == {e["185R"]: "0", e["NB"]: "0", e["P5"]: "0", e["D15"]: "0"}
    assert lines(body["replace"]["surplus"]) == {e["185R"]: "2", e["NB"]: "3", e["P5"]: "2", e["D15"]: "1"}


def test_one_deck_at_a_time_uses_the_decks_own_copies_then_copies_other_decks_hold():
    e, owner, at = world()
    counting(owner, "one_at_a_time")
    body = review(owner, "6 Iono PAL 185\n", at["gardevoir"])
    assert [part[:3] for part in parts(body, 0)] == [
        (e["185R"], "2", "in_deck"), (e["185"], "2", "elsewhere"), (e["254"], "2", "elsewhere")]
    assert body["lines"][0]["kept"] == []


def test_a_deck_that_isnt_the_callers_answers_404_and_the_review_creates_no_owner():
    e, owner, at = world()
    stranger, _ = new_owner()
    for caller, deck_id in ((stranger, at["gardevoir"]), (owner, at["binder"]), (owner, str(uuid4()))):
        body = review(caller, PASTE, deck_id, expect=404)
        assert body["detail"]["code"] == "DECK_NOT_FOUND"
    first_time = f"replace-{uuid4()}"
    assert review(first_time, PASTE, at["gardevoir"], expect=404)["detail"]["code"] == "DECK_NOT_FOUND"
    assert sql("SELECT count(*) FROM inventory_owner WHERE user_id=%s", (first_time,))[0][0] == 0
