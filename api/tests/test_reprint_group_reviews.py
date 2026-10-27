"""Maintainer-reviewed Reprint Groups and Card Identity merges (Deck Lists 14, issue #95) over signed HTTP.

Only the owner's decision merges or splits Reprint Groups, lets a Printing join one, or merges Card
Identities. Effects are observed through the owner's evidence routes, Standard format checks, Deck checks, Holdings,
catalog search and anonymous Published Deck reads. The Copycat and Rare Candy records are minimal copies of real TCGdex
records; records whose ID starts with "fixture-" are made up.
"""
from uuid import UUID, uuid4

import psycopg
import pytest

from app.main import app, connect  # noqa: F401
import app.catalog as catalog_module
import app.reprint_groups as reprint_groups
from app.card_attributes import attribute_revision
from app.catalog import rederive_card_attributes
from test_card_attributes import BULBASAUR_ME, ENERGY_SV, card, edition_of, printing_ids
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_catalog_search import search
from test_deck_format_checks import issues, standard
from test_deck_lists import add_line, detail
from test_decks import create
from test_holdings import add, call, client
from test_publications import command
from test_published_cost import launches, store  # noqa: F401  (autouse: a records store, no price launches)
from test_reprint_groups import CANDY_ME, CANDY_SM, CANDY_SM_GUARDIANS, CANDY_SV, CANDY_SWSH, RESEARCH, RESEARCH_SV, \
    SM_CANDY, Withdrawing, candy

OWNER, OTHER = "groups-owner", "groups-other"
ADMIN = "/api/admin/card-identities"
GROUPS = "/api/admin/reprint-groups/decisions"

# The handbook's example of a reworded but functionally identical reprint: Copycat CES 127 and TRR 83.
COPYCAT_CES = card(id="sm7-127", name="Copycat", localId="127", category="Trainer",
                   set={"id": "sm7", "name": "Celestial Storm"}, rarity="Uncommon", trainerType="Supporter",
                   effect="Shuffle your hand into your deck. Then, draw a card for each card in your opponent’s "
                          "hand.")
COPYCAT_TRR = card(id="ex7-83", name="Copycat", localId="83", category="Trainer",
                   set={"id": "ex7", "name": "Team Rocket Returns"}, rarity="Uncommon", trainerType="Supporter",
                   effect="You can play only one Supporter card each turn. When you play this card, put it next to "
                          "your Active Pokémon. When your turn ends, discard this card. Shuffle your hand into "
                          "your deck. Then, count the number of cards in your opponent's hand and draw that many "
                          "cards.")
# Rare Candy with the Sun & Moon wording, in a set imported after the maintainer merged the wordings.
CANDY_CES = candy("sm7-142", "sm7", "Celestial Storm", effect=SM_CANDY, rarity="Uncommon")
# Bulbasaur is the Basic Pokémon every deck needs (Deck Lists 20).
CANDIES = (CANDY_ME, CANDY_SV, CANDY_SM, CANDY_SM_GUARDIANS, ENERGY_SV, BULBASAUR_ME)
# A subtitle the parenthetical rule misses, so it is a Card Identity of its own until the maintainer merges it.
RESEARCH_SADA = card(id="fixture-sv04-906", name="Professor's Research [Professor Sada]", localId="906",
                     category="Trainer", set={"id": "sv04", "name": "Paradox Rift"}, regulationMark="G", rarity="Rare",
                     trainerType="Supporter", effect=RESEARCH)
RESEARCH_SADA_LATER = card(id="fixture-sv05-907", name="Professor's Research [Professor Sada]", localId="907",
                           category="Trainer", set={"id": "sv05", "name": "Temporal Forces"}, regulationMark="H",
                           rarity="Rare", trainerType="Supporter", effect=RESEARCH)
RESEARCH_TWILIGHT = card(id="fixture-sv06-908", name="Professor's Research", localId="908", category="Trainer",
                         set={"id": "sv06", "name": "Twilight Masquerade"}, regulationMark="H", rarity="Rare",
                         trainerType="Supporter", effect=RESEARCH)
# What a reviewed correction gives a manual Trainer: everything but a regulation mark.
MANUAL_TRAINER = {"card_kind": "trainer", "basic_energy": False, "types": [], "rule_box": False, "ace_spec": False,
                  "radiant": False, "prism_star": False, "basic_pokemon": False}


def seed(*records):
    reset_catalog()
    run(Records(*records))
    with connect() as conn:
        for user in (OWNER, OTHER):
            conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING", (user,))
        conn.execute("DELETE FROM owner_binding")
        conn.execute("INSERT INTO owner_binding(singleton,user_id) VALUES (true,%s)", (OWNER,))
    return ids_of(*(record["id"] for record in records))


def ids_of(*source_ids):
    return {source_id: str(printing_id) for source_id, printing_id in printing_ids(*source_ids).items()}


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def error(response):
    return response.status_code, response.json()["detail"]["code"]


def evidence(identity):
    return ok(call("GET", f"{ADMIN}/{identity}", OWNER))


def identity_of(printing):
    return ok(call("GET", f"{ADMIN}?printing_id={printing}", OWNER))["identity_id"]


def groups(shown):
    """Effective group by Printing ID."""
    return {printing["printing_id"]: printing["group_id"] for printing in shown["printings"]}


def decide(identity, decision, *, group=None, target=None, printings=(), digest=None, user=OWNER, **extra):
    body = {"identity_id": identity, "decision": decision, "printing_ids": list(printings),
            "evidence_digest": digest or evidence(identity)["evidence_digest"],
            "evidence_url": "https://example.org/compendium", "reason": "Same effect, checked against the rulings",
            **extra}
    if group is not None:
        body["group_id"] = group
    if target is not None:
        body["target_group_id"] = target
    return call("POST", GROUPS, user, body)


def merge_identities(merged, survivor, *, user=OWNER, digest=None, into_digest=None, **extra):
    body = {"identity_id": merged, "into_identity_id": survivor,
            "evidence_digest": digest or evidence(merged)["evidence_digest"],
            "into_evidence_digest": into_digest or evidence(survivor)["evidence_digest"],
            "evidence_url": "https://example.org/compendium", "reason": "One card name printed two ways",
            **extra}
    return call("POST", f"{ADMIN}/decisions", user, body)


def revision():
    with connect() as conn:
        return attribute_revision(conn)


def clock():
    with connect() as conn:
        return conn.execute("SELECT revision FROM catalog_public_clock").fetchone()["revision"]


def history(identity):
    return [(row["decision"], row["group_id"], row["target_group_id"], row["into_identity_id"], row["printing_ids"],
             row["affected_printing_ids"], row["reviewer_id"]) for row in ok(call("GET", f"{ADMIN}/{identity}/history",
                                                                                 OWNER))]


def queue():
    return [item["printing_id"] for item in ok(call("GET", f"{ADMIN}/queue", OWNER))["items"]]


def deck_of(*lines):
    """A fresh owner's Deck whose Deck List holds ``lines``, (Edition ID, quantity) pairs."""
    owner = f"groups-deck-{uuid4()}"
    deck = create(owner, "Group deck").json()["location"]["id"]
    list_revision = 1
    for edition, quantity in lines:
        response = add_line(owner, deck, edition, str(quantity), list_revision)
        assert response.status_code == 200, response.text
        list_revision = response.json()["deck_list"]["revision"]
    return owner, deck


def identity_checks(owner, deck):
    """The Deck List's copy-limit checks: (quantity, status) by Card Identity name."""
    rows = detail(owner, deck)["deck_list_checks"]["identities"]
    return {row["name"]: (row["quantity"], row["status"]) for row in rows}


def seed_manual_printing(member_source_id, name, set_id="future", number="1"):
    """A manually approved Printing in the Card Identity of ``member_source_id``, as a missing-card approval would."""
    with connect() as conn:
        identity = conn.execute("SELECT identity_id FROM catalog_printing WHERE source_id=%s",
                                (member_source_id,)).fetchone()["identity_id"]
        generation = conn.execute("SELECT active_generation FROM catalog_state").fetchone()["active_generation"]
        printing = conn.execute("INSERT INTO catalog_printing(source,identity_id) VALUES ('manual',%s) RETURNING id",
                                (identity,)).fetchone()["id"]
        edition = conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
          VALUES (%s,'normal','{"finish":"normal"}') RETURNING id""", (printing,)).fetchone()["id"]
        conn.execute("""INSERT INTO catalog_generation_printing(generation_id,printing_id,source_id,set_id,set_name,
          collector_number,display_name,search_name,source_fingerprint,basic_energy)
          VALUES (%s,%s,%s,%s,'Future Set',%s,%s,%s,'manual','unresolved')""",
                     (generation, printing, f"manual:{printing}", set_id, number, name, name.casefold()))
        conn.execute("INSERT INTO catalog_generation_edition VALUES (%s,%s,%s,true)", (generation, edition, printing))
    return str(printing), str(edition)


def correct_attributes(printing, correction):
    """Give a Printing reviewed card attributes through the attribute correction route (ticket 11)."""
    shown = ok(call("GET", f"/api/admin/card-attributes/{printing}", OWNER))
    ok(call("POST", "/api/admin/card-attributes/decisions", OWNER, {
        "printing_id": printing, "decision": "correct", "correction": correction,
        "evidence_digest": shown["evidence_digest"], "evidence_url": "https://example.org/scan",
        "reason": "Checked the printed card"}))


# ------------------------------------------------------------------ merges


def test_copycat_merge_joins_reworded_printings_and_survives_reimports_and_renamed_groups(monkeypatch):
    ids = seed(COPYCAT_CES, COPYCAT_TRR)
    ces, trr = ids["sm7-127"], ids["ex7-83"]
    identity = identity_of(ces)
    assert identity_of(trr) == identity  # one Card Identity, "Copycat"
    found = groups(evidence(identity))
    assert None not in (found[ces], found[trr]) and found[ces] != found[trr]  # the wording differs
    target, before = found[ces], revision()
    body = ok(decide(identity, "merge", group=found[trr], target=target))
    assert (body["group_id"], body["affected_printing_ids"]) == (target, [trr])
    assert body["attribute_revision"] == before + 1 == revision()
    assert groups(evidence(identity)) == {ces: target, trr: target}
    assert history(identity) == [("merge", found[trr], target, None, [], [trr], OWNER)]
    # Identical re-imports and re-derivation keep the reviewed group and the revision.
    run(Records(COPYCAT_CES, COPYCAT_TRR))
    with connect() as conn:
        rederive_card_attributes(conn)
    assert (groups(evidence(identity)), revision()) == ({ces: target, trr: target}, before + 1)
    # A rules change that renames every derived group keeps the reviewed group, which names Printings.
    monkeypatch.setattr(reprint_groups, "GROUP_NAMESPACE", UUID("0f1e2d3c-4b5a-5978-8a6b-5c4d3e2f1a0b"))
    with connect() as conn:
        rederive_card_attributes(conn)
    shown = evidence(identity)
    assert groups(shown) == {ces: target, trr: target}
    assert target not in {printing["derived_group_id"] for printing in shown["printings"]}


def test_merging_rare_candy_sm1_129_into_me01_125_makes_it_standard_legal_and_later_reprints_follow():
    ids = seed(*CANDIES)
    owner, deck = deck_of((edition_of("sm1-129"), 4), (edition_of("me01-001"), 1), (edition_of("sv02-278"), 55))
    assert standard(owner, deck, "2026-10-11")["status"] == "not_legal"
    identity = identity_of(ids["me01-125"])
    found = groups(evidence(identity))
    me, sm = found[ids["me01-125"]], found[ids["sm1-129"]]
    assert me != sm and found[ids["sm2-165"]] == sm
    before = revision()
    body = ok(decide(identity, "merge", group=sm, target=me))
    assert body["affected_printing_ids"] == sorted([ids["sm1-129"], ids["sm2-165"]])
    assert body["attribute_revision"] == before + 1
    result = standard(owner, deck, "2026-10-11")
    assert (result["status"], result["issues"]) == ("legal", [])
    # A reprint with the Sun & Moon wording imported after the merge joins the merged group.
    run(Records(*CANDIES, CANDY_CES))
    ces = ids_of("sm7-142")["sm7-142"]
    assert groups(evidence(identity))[ces] == me
    owner, deck = deck_of((edition_of("sm7-142"), 4), (edition_of("me01-001"), 1), (edition_of("sv02-278"), 55))
    assert standard(owner, deck, "2026-10-11")["status"] == "legal"
    # Undoing the merge restores every linked member; one alone changes nothing while its sibling's link holds.
    assert error(decide(identity, "restore", printings=[ids["sm1-129"]])) == (422, "NO_CHANGE")
    body = ok(decide(identity, "restore", printings=[ids["sm1-129"], ids["sm2-165"]]))
    assert body["affected_printing_ids"] == sorted([ids["sm1-129"], ids["sm2-165"], ces])  # sm7-142 followed the links
    found = groups(evidence(identity))
    assert found[ids["sm1-129"]] == found[ids["sm2-165"]] == found[ces] == sm
    assert standard(owner, deck, "2026-10-11")["status"] == "not_legal"


def test_a_reviewed_merge_reaches_published_format_results_without_a_republish():
    from test_published_format_checks import published, standard as published_standard  # needs app.main loaded
    ids = seed(*CANDIES)
    _, token = published((("sm1-129", 4), ("me01-001", 1), ("sv02-278", 55)))
    assert published_standard(token)["status"] == "not_legal"
    identity = identity_of(ids["me01-125"])
    found = groups(evidence(identity))
    body = ok(decide(identity, "merge", group=found[ids["sm1-129"]], target=found[ids["me01-125"]]))
    assert body["public_delivery"] == "delivered"
    result = published_standard(token)
    assert (result["status"], result["issues"]) == ("legal", [])


# ------------------------------------------------------------------ splits and restores


def test_a_split_moves_printings_into_a_new_group_that_survives_reimport_until_restored():
    ids = seed(*CANDIES)
    sv = ids["sv01-191"]
    owner, deck = deck_of((edition_of("sv01-191"), 4), (edition_of("me01-001"), 1), (edition_of("sv02-278"), 55))
    assert standard(owner, deck, "2026-10-11")["status"] == "legal"  # through me01-125
    identity = identity_of(sv)
    me = groups(evidence(identity))[ids["me01-125"]]
    before = revision()
    body = ok(decide(identity, "split", group=me, printings=[sv]))
    split = body["group_id"]
    assert split not in (None, me) and body["affected_printing_ids"] == [sv]
    assert body["attribute_revision"] == before + 1
    found = groups(evidence(identity))
    assert (found[sv], found[ids["me01-125"]]) == (split, me)
    result = standard(owner, deck, "2026-10-11")
    assert issues(result) == {("not_in_card_pool", "regulation mark G rotated out of Standard on 2026-04-10", "card",
                               "not_legal", (edition_of("sv01-191"),))}
    run(Records(*CANDIES))
    assert groups(evidence(identity))[sv] == split
    assert error(decide(identity, "split", group=split, printings=[sv])) == (422, "SPLIT_WHOLE_GROUP")
    assert error(decide(identity, "split", group=me, printings=[sv])) == (422, "PRINTING_NOT_IN_GROUP")
    body = ok(decide(identity, "restore", printings=[sv]))  # the refusals changed nothing
    assert (body["group_id"], body["affected_printing_ids"], body["attribute_revision"]) == (None, [sv], before + 2)
    assert groups(evidence(identity))[sv] == me
    assert standard(owner, deck, "2026-10-11")["status"] == "legal"
    assert error(decide(identity, "restore", printings=[sv])) == (422, "NO_REVIEWED_GROUP")
    assert [row[0] for row in history(identity)] == ["restore", "split"]


# ------------------------------------------------------------------ manual Printings


def test_a_manual_printing_joins_a_group_only_through_review():
    ids = seed(*CANDIES)
    manual, edition = seed_manual_printing("me01-125", "Rare Candy")
    identity = identity_of(manual)
    assert identity == identity_of(ids["me01-125"])
    shown = {printing["printing_id"]: printing for printing in evidence(identity)["printings"]}[manual]
    assert (shown["source"], shown["derived_group_id"], shown["group_id"]) == ("manual", None, None)
    assert queue() == [manual]
    # Neither an import nor a re-derivation gives a manual Printing a group.
    run(Records(*CANDIES))
    with connect() as conn:
        rederive_card_attributes(conn)
    assert groups(evidence(identity))[manual] is None and queue() == [manual]
    correct_attributes(manual, MANUAL_TRAINER)
    owner, deck = deck_of((edition, 4), (edition_of("me01-001"), 1), (edition_of("sv02-278"), 55))
    result = standard(owner, deck, "2026-10-11")
    # On its own the manual Printing has no regulation mark and a set without a recorded legal date.
    assert (result["status"], {issue["code"] for issue in result["issues"]}) == (
        "unknown", {"set_date_not_recorded", "regulation_mark_not_recorded"})
    me = groups(evidence(identity))[ids["me01-125"]]
    before = revision()
    body = ok(decide(identity, "join", target=me, printings=[manual]))
    assert (body["group_id"], body["affected_printing_ids"], body["attribute_revision"]) == (me, [manual], before + 1)
    assert standard(owner, deck, "2026-10-11")["status"] == "legal"
    assert queue() == []
    # Imports and re-derivation never derive a group for a manual Printing, and leave its reviewed one alone.
    run(Records(*CANDIES))
    with connect() as conn:
        rederive_card_attributes(conn)
    assert groups(evidence(identity))[manual] == me
    assert error(decide(identity, "join", target=me, printings=[manual])) == (422, "ALREADY_IN_GROUP")
    assert error(decide(identity, "join", target=me, printings=[ids["sv02-278"]])) == (422, "PRINTING_NOT_IN_IDENTITY")


def test_a_withdrawn_printing_leaves_its_reviewed_group_in_private_and_published_results():
    from test_published_format_checks import format_record, matches_private, published  # needs app.main loaded
    ids = seed(*CANDIES, CANDY_SWSH)
    sv, swsh = ids["sv01-191"], ids["swsh1-180"]
    identity = identity_of(sv)
    split = ok(decide(identity, "split", group=groups(evidence(identity))[ids["me01-125"]], printings=[sv, swsh]))
    split = split["group_id"]
    deck, token = published((("sv01-191", 4), ("sv02-278", 56)))
    refs = {source_id: format_record(source_id)[1] for source_id in ("sv01-191", "swsh1-180")}
    assert format_record("sv01-191")[2].value["reprint_group"]["printings"] == sorted(refs.values())
    # swsh1-180 is withdrawn: it leaves the split group, and its group-mate's public record stops listing it.
    run(Withdrawing(*CANDIES, excluded_ids={"swsh1-180"}, excluded_sets={"swsh1"}))
    found = groups(evidence(identity))
    assert (found[swsh], found[sv]) == (None, split)
    assert format_record("sv01-191")[2].value["reprint_group"]["printings"] == [refs["sv01-191"]]
    matches_private(token, deck)  # private and published Standard results agree
    assert error(decide(identity, "join", target=split, printings=[swsh])) == (422, "PRINTING_NOT_GROUPABLE")
    # Held again by a later import, it rejoins its assigned group.
    run(Records(*CANDIES, CANDY_SWSH))
    assert groups(evidence(identity))[swsh] == split
    matches_private(token, deck)


# ------------------------------------------------------------------ Card Identity merges


def test_an_identity_merge_keeps_holdings_and_published_decks_and_later_printings_join_the_survivor(monkeypatch):
    ids = seed(RESEARCH_SV, RESEARCH_SADA, ENERGY_SV)
    plain, sada = ids["sv01-189"], ids["fixture-sv04-906"]
    owner = f"identity-merge-{uuid4()}"
    deck = create(owner, "Research deck").json()["location"]["id"]
    list_revision = ok(add_line(owner, deck, edition_of("sv01-189"), "3", 1))["deck_list"]["revision"]
    ok(add_line(owner, deck, edition_of("fixture-sv04-906"), "2", list_revision))
    ok(add(owner, deck, edition_of("fixture-sv04-906"), "2"))
    token = ok(command(owner, deck))["token"]
    published = ok(client.get(f"/api/public/decks/{token}"))
    held = ok(call("GET", f"/api/holdings/{deck}", owner))["holdings"]
    checks = identity_checks(owner, deck)
    assert checks == {"Professor's Research": ("3", "within_limit"),
                      "Professor's Research [Professor Sada]": ("2", "within_limit")}
    survivor, merged = identity_of(plain), identity_of(sada)
    assert survivor != merged
    before = revision()
    body = ok(merge_identities(merged, survivor))
    assert (body["moved_printing_ids"], body["affected_printing_ids"]) == ([sada], [sada])
    assert body["attribute_revision"] == before + 1 == revision()
    # Copy limits now count both names together; Holdings and the Published Deck are untouched.
    checks = identity_checks(owner, deck)
    assert checks == {"Professor's Research": ("5", "over_limit")}
    assert ok(call("GET", f"/api/holdings/{deck}", owner))["holdings"] == held
    assert ok(client.get(f"/api/public/decks/{token}")) == published
    [found] = search(name="Professor's Research [Professor").json()["printings"]
    assert (found["identity_id"], found["identity_name"], found["name"]) == (
        survivor, "Professor's Research", "Professor's Research [Professor Sada]")
    # The same text in one Card Identity is one Reprint Group.
    together = groups(evidence(survivor))
    assert together[sada] == together[plain] is not None
    shown = evidence(merged)
    assert (shown["merged_into"], shown["printings"]) == (survivor, [])
    assert history(survivor) == [("merge_identity", None, None, survivor, [sada], [sada], OWNER)]
    # A later printing with the merged name joins the survivor, even from an older release whose identity upsert
    # does not read merged_into (the database trigger redirects it).
    monkeypatch.setattr(catalog_module, "IDENTITY_UPSERT", catalog_module.IDENTITY_UPSERT.replace(
        "coalesce(merged_into,id)", "id"))
    run(Records(RESEARCH_SV, RESEARCH_SADA, RESEARCH_SADA_LATER, ENERGY_SV))
    later = ids_of("fixture-sv05-907")["fixture-sv05-907"]
    assert identity_of(later) == survivor
    assert groups(evidence(survivor))[later] == together[plain]


def test_identity_merges_refuse_the_same_or_a_merged_identity_and_reviewed_group_records():
    ids = seed(*CANDIES, RESEARCH_SV, RESEARCH_SADA, COPYCAT_CES)
    candy_identity, research, sada = (identity_of(ids[source_id]) for source_id in
                                      ("me01-125", "sv01-189", "fixture-sv04-906"))
    copycat = identity_of(ids["sm7-127"])
    assert error(merge_identities(sada, sada)) == (422, "SAME_IDENTITY")
    # A Card Identity with reviewed group records cannot be merged away until they are restored.
    ok(decide(candy_identity, "split", group=groups(evidence(candy_identity))[ids["me01-125"]],
              printings=[ids["sv01-191"]]))
    assert error(merge_identities(candy_identity, copycat)) == (422, "REPRINT_GROUP_OVERRIDES")
    ok(merge_identities(sada, research))  # the earlier refusal changed nothing
    assert error(merge_identities(sada, research)) == (422, "IDENTITY_MERGED")
    assert error(merge_identities(copycat, sada)) == (422, "IDENTITY_MERGED")
    assert error(decide(sada, "restore", printings=[ids["sm7-127"]])) == (422, "IDENTITY_MERGED")
    missing = str(uuid4())
    response = call("POST", f"{ADMIN}/decisions", OWNER, {
        "identity_id": missing, "into_identity_id": research, "evidence_digest": "0" * 64,
        "into_evidence_digest": "0" * 64, "evidence_url": "https://example.org/x", "reason": "x"})
    assert error(response) == (404, "IDENTITY_NOT_FOUND")


# ------------------------------------------------------------------ the review pattern


def test_identity_merges_bind_to_both_evidences_and_only_the_owner_merges():
    ids = seed(RESEARCH_SV, RESEARCH_SADA, COPYCAT_CES)
    research, sada, copycat = (identity_of(ids[source_id]) for source_id in
                               ("sv01-189", "fixture-sv04-906", "sm7-127"))
    before = (revision(), clock())
    assert merge_identities(sada, research, user=OTHER).status_code == 403  # not the owner
    assert (revision(), clock()) == before
    # The survivor's evidence changes after the owner looked: a new printing joins it.
    shown = evidence(research)["evidence_digest"]
    run(Records(RESEARCH_SV, RESEARCH_SADA, COPYCAT_CES, RESEARCH_TWILIGHT))
    assert error(merge_identities(sada, research, into_digest=shown)) == (409, "IDENTITY_EVIDENCE_CHANGED")
    # No code is asked for; one left in the body by an older web bundle is ignored.
    assert ok(merge_identities(sada, research, code="654321"))["moved_printing_ids"] == [ids["fixture-sv04-906"]]


def test_decisions_are_append_only():
    ids = seed(*CANDIES)
    identity = identity_of(ids["me01-125"])
    found = groups(evidence(identity))
    ok(decide(identity, "merge", group=found[ids["sm1-129"]], target=found[ids["me01-125"]]))
    for statement in ("UPDATE catalog_card_identity_decision SET reason='rewritten'",
                      "DELETE FROM catalog_card_identity_decision"):
        with pytest.raises(psycopg.errors.RaiseException, match="append-only"):
            with connect() as conn:
                conn.execute(statement)
    assert [row[0] for row in history(identity)] == ["merge"]


def test_decisions_bind_to_the_evidence_and_only_the_owner_decides():
    ids = seed(*CANDIES, COPYCAT_CES)
    identity = identity_of(ids["me01-125"])
    found = groups(evidence(identity))
    me, sm = found[ids["me01-125"]], found[ids["sm1-129"]]
    before = (revision(), clock())
    assert decide(identity, "merge", group=sm, target=me, user=OTHER).status_code == 403  # not the owner
    assert (revision(), clock()) == before and groups(evidence(identity)) == found
    # Malformed and impossible decisions are refused without changing anything.
    for kwargs, expected in (({"group": sm}, (422, "INVALID_DECISION")),
                             ({"group": sm, "target": me, "printings": [ids["sm1-129"]]}, (422, "INVALID_DECISION")),
                             ({"group": sm, "target": sm}, (422, "SAME_GROUP")),
                             ({"group": sm, "target": str(uuid4())}, (422, "GROUP_NOT_FOUND")),
                             ({"group": groups(evidence(identity_of(ids["sm7-127"])))[ids["sm7-127"]], "target": me},
                              (422, "GROUP_NOT_FOUND"))):
        assert error(decide(identity, "merge", **kwargs)) == expected, kwargs
    # New evidence after the owner looked: a reprint joins the identity.
    shown = evidence(identity)["evidence_digest"]
    run(Records(*CANDIES, COPYCAT_CES, CANDY_CES))
    stale = decide(identity, "merge", group=sm, target=me, digest=shown)
    assert error(stale) == (409, "IDENTITY_EVIDENCE_CHANGED")
    # No code is asked for; one left in the body by an older web bundle is ignored.
    assert decide(identity, "merge", group=sm, target=me, code="654321").status_code == 200


def test_owner_routes_refuse_everyone_else():
    ids = seed(*CANDIES)
    identity = identity_of(ids["me01-125"])
    for path in (f"{ADMIN}/{identity}", f"{ADMIN}/{identity}/history", f"{ADMIN}/queue",
                 f"{ADMIN}?printing_id={ids['me01-125']}"):
        assert call("GET", path, OTHER).status_code == 403, path
        assert call("GET", path, OWNER).status_code == 200, path
    assert error(call("GET", f"{ADMIN}/{uuid4()}", OWNER)) == (404, "IDENTITY_NOT_FOUND")
    assert error(call("GET", f"{ADMIN}?printing_id={uuid4()}", OWNER)) == (404, "PRINTING_NOT_FOUND")
