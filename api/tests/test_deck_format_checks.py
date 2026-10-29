"""GET /api/decks/{deck_id}/format-checks against Standard (Deck Lists 12, issue #93), through signed HTTP. The Expanded
and Gym Leader Challenge results of the same route are in test_expanded_format_checks.py and test_glc_format_checks.py.

The cards are imported from minimal TCGdex records, so their attributes come from the real derivation rules, and the
rules are the real Standard rules file. Every check passes an explicit ``as_of`` except the one about the default date.
"""
from datetime import date, datetime, timedelta, timezone
from uuid import uuid4

from app.games.pokemon.formats.format_evaluator import FORMATS

from test_card_attributes import (ACE_SPEC_ENERGY, ACE_SPEC_SV, BULBASAUR_ME, ENERGY_SEARCH, ENERGY_SV, RARE_CANDY_ME,
                                  SWITCH_ME, card, edition_of)
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_deck_lists import add_line
from test_holdings import call
from test_moves import leaf

RESEARCH_JUNIPER = card(id="fixture-sv01-901", name="Professor's Research (Professor Juniper)", localId="901",
                        category="Trainer", set={"id": "sv01", "name": "Scarlet & Violet"}, regulationMark="H",
                        rarity="Common")
RESEARCH_MAGNOLIA = card(id="fixture-sv01-902", name="Professor's Research (Professor Magnolia)", localId="902",
                         category="Trainer", set={"id": "sv01", "name": "Scarlet & Violet"}, regulationMark="H",
                         rarity="Common")
# me06 Delta Reign was unreleased on 2026-10-11, so the rules record no legal date for it. A Pokémon, because a me06
# Trainer's ACE SPEC status is unknown too.
DELTA_POKEMON = card(id="fixture-me06-3", name="Fixture Pokémon", localId="3", category="Pokemon",
                     set={"id": "me06", "name": "Delta Reign"}, regulationMark="J", stage="Basic", rarity="Common",
                     types=["Fire"])
FUTURE_MARK = card(id="fixture-me05-901", name="Fixture Future Trainer", localId="901", category="Trainer",
                   set={"id": "me05", "name": "Pitch Black"}, regulationMark="K", rarity="Common")
# A Pokémon whose record has no stage, so its Basic Pokémon status is unknown.
STAGELESS_POKEMON = card(id="fixture-me01-903", name="Fixture Stageless Pokémon", localId="903", category="Pokemon",
                         set={"id": "me01", "name": "Mega Evolution"}, regulationMark="I", rarity="Common",
                         types=["Grass"])
CARDS = (RARE_CANDY_ME, SWITCH_ME, ENERGY_SV, ENERGY_SEARCH, ACE_SPEC_SV, ACE_SPEC_ENERGY, RESEARCH_JUNIPER,
         RESEARCH_MAGNOLIA, DELTA_POKEMON, FUTURE_MARK, BULBASAUR_ME, STAGELESS_POKEMON)


def deck_with(cards):
    """A fresh owner's Deck whose Deck List holds ``cards``, (TCGdex ID, quantity) pairs."""
    owner = f"format-{uuid4()}"
    created = call("POST", "/api/decks", owner, {"name": "Format deck", "idempotency_key": str(uuid4())})
    assert created.status_code == 201, created.text
    deck = created.json()["location"]["id"]
    revision = 1
    for source_id, quantity in cards:
        response = add_line(owner, deck, edition_of(source_id), str(quantity), revision)
        assert response.status_code == 200, response.text
        revision = response.json()["deck_list"]["revision"]
    return owner, deck


def format_checks(owner, deck, query=""):
    response = call("GET", f"/api/decks/{deck}/format-checks{query}", owner)
    assert response.status_code == 200, response.text
    return response.json()


def standard(owner, deck, as_of):
    body = format_checks(owner, deck, f"?format=standard&as_of={as_of}")
    assert [result["format"] for result in body["results"]] == ["standard"]
    return body["results"][0]


def every_format(owner, deck, as_of="2026-10-11"):
    """One result per Format, in FORMATS order. The read answers the Deck's Target Format (Standard unless the collector
    chose another, app redesign #178) unless ``format`` names one, so each Format is asked for by name."""
    return [format_checks(owner, deck, f"?format={name}&as_of={as_of}")["results"][0] for name in FORMATS]


def issues(result):
    return {(issue["code"], issue["reason"], issue["kind"], issue["effect"], tuple(issue["lines"]))
            for issue in result["issues"]}


def lines(*source_ids):
    return tuple(sorted(edition_of(source_id) for source_id in source_ids))


def test_a_legal_deck_is_standard_legal():
    reset_catalog()
    run(Records(*CARDS))
    owner, deck = deck_with([("me01-001", 1), ("me01-125", 4), ("me01-130", 4), ("sv02-278", 51)])
    body = format_checks(owner, deck, "?as_of=2026-10-11")
    assert body["deck_id"] == deck and body["deck_list_revision"] == 5
    assert isinstance(body["attribute_revision"], int) and body["disclaimer"].startswith("Advisory format checks")
    # The read answers the Target Format, which is Standard for a new Deck.
    assert [result["format"] for result in body["results"]] == ["standard"]
    results = every_format(owner, deck)
    assert [result["format"] for result in results] == list(FORMATS)
    assert [{**result, "computed_at": None} for result in results[:2]] == [
        {"format": name, "status": "legal", "issues": [], "rules_version": version, "evaluated_on": "2026-10-11",
         "notes": [], "computed_at": None} for name, version in (("standard", "1 (2026-10-11)"),
                                                                  ("expanded", "2 (2026-10-11)"))]
    # Four Rare Candy and four Switch break Gym Leader Challenge's one-copy rule.
    assert (results[2]["status"], {issue["code"] for issue in results[2]["issues"]}) == ("not_legal", {"copy_limit"})
    # Naming the Target Format answers the same result, reused from the save.
    assert format_checks(owner, deck, "?format=standard&as_of=2026-10-11") == body


def test_a_deck_over_its_copy_and_ace_spec_limits_is_not_legal():
    reset_catalog()
    run(Records(*CARDS))
    owner, deck = deck_with([("me01-001", 1), ("fixture-sv01-901", 3), ("fixture-sv01-902", 2), ("sv05-157", 1),
                             ("sv05-162", 1), ("sv02-278", 52)])
    result = standard(owner, deck, "2026-10-11")
    assert result["status"] == "not_legal"
    assert issues(result) == {
        ("ace_spec_limit", "more than 1 ACE SPEC in the deck (2)", "deck", "not_legal", lines("sv05-157", "sv05-162")),
        ("copy_limit", "more than 4 copies of Professor's Research (5)", "card", "not_legal",
         lines("fixture-sv01-901", "fixture-sv01-902"))}


def test_an_unrecorded_set_and_an_unknown_mark_make_a_deck_unknown():
    reset_catalog()
    run(Records(*CARDS))
    owner, deck = deck_with([("fixture-me06-3", 4), ("fixture-me05-901", 4), ("sv02-278", 52)])
    result = standard(owner, deck, "2026-10-11")
    assert result["status"] == "unknown"
    assert issues(result) == {
        ("set_date_not_recorded", "set legality date not recorded for me06", "card", "unknown",
         lines("fixture-me06-3")),
        ("regulation_mark_not_in_rules", "regulation mark K not in rules", "card", "unknown",
         lines("fixture-me05-901"))}


def test_standard_legality_flips_on_the_2026_rotation_date():
    reset_catalog()
    run(Records(*CARDS))
    owner, deck = deck_with([("me01-001", 1), ("sv01-172", 4), ("me01-125", 4), ("sv02-278", 51)])
    assert standard(owner, deck, "2026-04-09")["status"] == "legal"
    rotated = standard(owner, deck, "2026-04-10")
    assert rotated["status"] == "not_legal"
    assert issues(rotated) == {("not_in_card_pool", "regulation mark G rotated out of Standard on 2026-04-10", "card",
                                "not_legal", lines("sv01-172"))}
    before = standard(owner, deck, "2025-04-10")
    assert (before["status"], [issue["code"] for issue in before["issues"]]) == ("unknown", ["before_rules_coverage"])


def test_checks_default_to_today_and_a_future_date_carries_a_note():
    reset_catalog()
    run(Records(*CARDS))
    owner, deck = deck_with([("me01-001", 1), ("me01-125", 4), ("sv02-278", 55)])
    before = datetime.now(timezone.utc).date()
    [result] = format_checks(owner, deck, "?format=standard")["results"]
    after = datetime.now(timezone.utc).date()
    assert result["evaluated_on"] in (before.isoformat(), after.isoformat()) and result["notes"] == []
    future = (after + timedelta(days=400)).isoformat()
    [ahead] = format_checks(owner, deck, f"?format=standard&as_of={future}")["results"]
    assert ahead["evaluated_on"] == future and ahead["status"] == "legal"
    assert ahead["notes"] == [f"{future} is in the future: rules published after this rules file (2026-10-11) are "
                              "unknown, so this result assumes no later rule changes."]
    assert date.fromisoformat(future) > after


def test_format_checks_are_private_and_validate_their_query():
    reset_catalog()
    run(Records(*CARDS))
    owner, deck = deck_with([("me01-125", 4)])
    other = f"format-other-{uuid4()}"
    binder = leaf(owner)
    for user, target in ((other, deck), (owner, binder), (owner, str(uuid4()))):
        response = call("GET", f"/api/decks/{target}/format-checks?as_of=2026-10-11", user)
        assert response.status_code == 404 and response.json()["detail"]["code"] == "DECK_NOT_FOUND"
    response = call("GET", f"/api/decks/{deck}/format-checks?format=unlimited", owner)
    assert response.status_code == 422 and response.json()["detail"]["code"] == "UNKNOWN_FORMAT"
    response = call("GET", f"/api/decks/{deck}/format-checks?format={'x' * 100}", owner)
    assert response.status_code == 422 and response.json()["detail"]["code"] == "UNKNOWN_FORMAT"
    for as_of in ("2026-4-10", "20260410", "2026-02-30", "today", "2026-04-10T00:00", "2026-04-10" + "0" * 50):
        response = call("GET", f"/api/decks/{deck}/format-checks?as_of={as_of}", owner)
        assert response.status_code == 422 and response.json()["detail"]["code"] == "INVALID_AS_OF", as_of


def test_a_deck_of_only_trainers_and_energy_is_not_legal_in_any_format():
    reset_catalog()
    run(Records(*CARDS))
    trainers = [("me01-125", 1), ("me01-130", 1)]
    owner, deck = deck_with([*trainers, ("sv02-278", 58)])
    every = lines("me01-125", "me01-130", "sv02-278")
    assert {result["format"]: (result["status"], issues(result)) for result in every_format(owner, deck)} == {
        name: ("not_legal", {("no_basic_pokemon", f"{deck_name} deck has at least one Basic Pokémon; this one has none",
                              "deck", "not_legal", every)})
        for name, deck_name in (("standard", "a Standard"), ("expanded", "an Expanded"),
                                ("glc", "a Gym Leader Challenge"))}
    # One Basic Pokémon makes the same deck legal in every format.
    owner, deck = deck_with([*trainers, ("me01-001", 1), ("sv02-278", 57)])
    assert [result["status"] for result in every_format(owner, deck)] == ["legal"] * 3
    # A Pokémon whose Basic Pokémon status is unknown leaves the deck unknown, never legal.
    owner, deck = deck_with([*trainers, ("fixture-me01-903", 1), ("sv02-278", 57)])
    unknown = ("attribute_unknown", "Basic Pokémon status unknown", "card", "unknown", lines("fixture-me01-903"))
    assert [(result["status"], issues(result)) for result in every_format(owner, deck)] == [("unknown", {unknown})] * 3
