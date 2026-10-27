"""What Owner controls' Reprints review card reads (#171) over signed HTTP: when each queued Printing began waiting,
each Printing's regulation mark, and each Reprint Group's legality in every Format on a given day. A decision on the
card advances the revision the format checks read, and an affected Deck List's format result follows it.
"""
from datetime import datetime

from app.main import app, connect  # noqa: F401
from test_card_attributes import edition_of
from test_deck_format_checks import format_checks, standard
from test_holdings import call
from test_published_cost import launches, store  # noqa: F401  (autouse: a records store, no price launches)
from test_reprint_group_reviews import ADMIN, CANDIES, OWNER, correct_attributes, deck_of, decide, error, \
    groups, identity_of, ok, revision, seed, seed_manual_printing

FORMATS = ["standard", "expanded", "glc"]


def evidence(identity, as_of=None):
    return ok(call("GET", f"{ADMIN}/{identity}" + (f"?as_of={as_of}" if as_of else ""), OWNER))


def marks(shown):
    """Regulation mark by Printing ID."""
    return {printing["printing_id"]: printing["regulation_mark"] for printing in shown["printings"]}


def legality(shown, printing):
    """The legality of a Printing's group, {format: status}; None for a Printing in no group."""
    group = groups(shown)[printing]
    if group is None:
        return None
    [view] = [view for view in shown["groups"] if view["group_id"] == group]
    assert [entry["format"] for entry in view["legality"]] == FORMATS
    return {entry["format"]: entry["status"] for entry in view["legality"]}


def test_the_queue_says_when_each_printing_began_waiting_for_a_group():
    ids = seed(*CANDIES)
    manual, _ = seed_manual_printing("me01-125", "Rare Candy")
    [item] = ok(call("GET", f"{ADMIN}/queue", OWNER))["items"]
    with connect() as conn:
        created = conn.execute("SELECT created_at FROM catalog_printing WHERE id=%s", (manual,)).fetchone()
    assert (item["printing_id"], item["identity_id"]) == (manual, identity_of(ids["me01-125"]))
    assert datetime.fromisoformat(item["opened_at"].replace("Z", "+00:00")) == created["created_at"]


def test_the_evidence_shows_regulation_marks_and_each_groups_legality_on_a_day():
    ids = seed(*CANDIES)
    manual, _ = seed_manual_printing("me01-125", "Rare Candy")
    identity = identity_of(ids["me01-125"])
    shown = evidence(identity, "2026-10-11")
    assert shown["legality_on"] == "2026-10-11"
    assert marks(shown) == {ids["me01-125"]: "I", ids["sv01-191"]: "G", ids["sm1-129"]: None,
                            ids["sm2-165"]: None, manual: None}
    # Rare Candy is a Trainer, so a group is legal through any member: me01-125 (mark I) carries sv01-191 (mark G,
    # rotated out of Standard on 2026-04-10). The Sun & Moon wording's group is in no Standard set.
    assert legality(shown, ids["me01-125"]) == legality(shown, ids["sv01-191"]) == {
        "standard": "legal", "expanded": "legal", "glc": "legal"}
    assert legality(shown, ids["sm1-129"]) == legality(shown, ids["sm2-165"]) == {
        "standard": "not_legal", "expanded": "legal", "glc": "legal"}
    assert legality(shown, manual) is None
    # The day changes the legality but not the digest a decision binds to; today in UTC is the default.
    earlier = evidence(identity, "2024-01-01")
    assert legality(earlier, ids["me01-125"])["standard"] == "not_legal"
    assert earlier["evidence_digest"] == shown["evidence_digest"] == evidence(identity)["evidence_digest"]
    assert call("GET", f"{ADMIN}/{identity}?as_of=soon", OWNER).status_code == 422
    assert ok(call("GET", f"{ADMIN}?printing_id={manual}&as_of=2026-10-11", OWNER))["groups"] == shown["groups"]


def test_a_regulation_mark_correction_changes_the_evidence_a_decision_binds_to():
    ids = seed(*CANDIES)
    manual, _ = seed_manual_printing("me01-125", "Rare Candy")
    identity = identity_of(ids["me01-125"])
    shown = evidence(identity)
    correct_attributes(manual, {"regulation_mark": "H"})
    after = evidence(identity)
    assert marks(after)[manual] == "H" and after["evidence_digest"] != shown["evidence_digest"]
    me = groups(after)[ids["me01-125"]]
    stale = decide(identity, "join", target=me, printings=[manual], digest=shown["evidence_digest"])
    assert error(stale) == (409, "IDENTITY_EVIDENCE_CHANGED")


def test_a_group_merge_from_the_card_moves_the_legality_and_the_deck_format_result_with_it():
    ids = seed(*CANDIES)
    seed_manual_printing("me01-125", "Rare Candy")  # puts Rare Candy in the queue
    owner, deck = deck_of((edition_of("sm1-129"), 4), (edition_of("me01-001"), 1), (edition_of("sv02-278"), 55))
    assert standard(owner, deck, "2026-10-11")["status"] == "not_legal"
    identity = identity_of(ids["me01-125"])
    shown = evidence(identity, "2026-10-11")
    me, sm = groups(shown)[ids["me01-125"]], groups(shown)[ids["sm1-129"]]
    before = revision()
    body = ok(decide(identity, "merge", group=sm, target=me))
    assert body["attribute_revision"] == before + 1
    after = evidence(identity, "2026-10-11")
    assert groups(after)[ids["sm1-129"]] == groups(after)[ids["sm2-165"]] == me
    assert legality(after, ids["sm1-129"]) == {"standard": "legal", "expanded": "legal", "glc": "legal"}
    assert [view["group_id"] for view in after["groups"]] == [me]
    checks = format_checks(owner, deck, "?format=standard&as_of=2026-10-11")
    assert checks["attribute_revision"] == body["attribute_revision"]
    assert (checks["results"][0]["status"], checks["results"][0]["issues"]) == ("legal", [])
