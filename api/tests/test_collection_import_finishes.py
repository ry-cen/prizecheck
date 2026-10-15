"""Collection Import finishes (#230): each tracker's finish words and name tags choose the Card Edition, a card with one
Edition always gets it, and an unknown finish lands on the Unspecified Variant (Finish unknown) or, for a card without
one, waits for the collector's pick. The changes route sets a finish or skips and restores rows, by row numbers or by
filter, in order and in one transaction at the draft's revision. Signed HTTP against PostgreSQL, with
test_collection_import's catalog seed: its Fixture Finishes cards are described as TCGdex describes cards today.
"""
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from app.main import connect  # first: app.main imports the routers, and they import it
from test_batch_add import held, revision
from test_collection_import import (LOOKUP_ID, all_rows, code, collector, edition, save, seed_import_catalog,
                                    started)
from test_collection_import_reading import TRACKER
from test_holdings import call

TCGPLAYER = ("Quantity,Name,Simple Name,Set,Card Number,Set Code,Printing,Condition,Language,Rarity,Product ID,"
             "SKU\n")
COLLECTR = ("Portfolio Name,Category,Set,Product Name,Card Number,Rarity,Variance,Grade,Card Condition,"
            "Average Cost Paid,Quantity,Market Price (As of 2026-10-01),Watchlist,Date Added\n")
PRICECHARTING = ("id,product-name,console-name,price-in-pennies,include-string,condition-string,sku,notes,"
                 "cost-basis-in-pennies,quantity,date-entered,date-purchased,grading-company,grading-cert-id,folder\n")
TCG_COLLECTOR = ("TCG region,Expansion,Card number,Card number sorting order,Card name,Rarity,Card variant,"
                 "Card language,Card condition,Note,Quantity\n")
DRAGON_SHIELD = ('"sep=,"\nFolder Name,Quantity,Trade Quantity,Card Name,Set Code,Set Name,Card Number,Condition,'
                 "Printing,Language,Price Bought,Date Bought,LOW,MID,MARKET\n")
SORTED = ("List Type,List Name,Collection,Format,Board,Quantity,Card Name,Set Code,Set Name,Card Number,Condition,"
          "Printing,Rarity,Language,Price Bought,Date Bought,Parent List Type,Parent List Name,"
          "Current Price (tcgplayer_marketsellprice),List Cover Image,Parent List Cover Image\n")
OTHER_APP = "Qty,Card,Expansion,Collector #,Finish\n"
SETS = {"Exeggcute": ("Fixture Finishes", "1"), "Suicune": ("Fixture Finishes", "2"),
        "Pineco": ("Fixture Finishes", "3"), "Clefairy": ("Fixture Finishes", "4"),
        "Celebi V": ("Fixture Finishes", "5"), "Weepinbell": ("Jungle", "48"),
        "Dark Golduck": ("Team Rocket Returns", "35"), "Starmie": ("Base Set", "64"),
        "Flying Pikachu": ("Rising Rivals", "113")}
SOURCE_IDS = {"Exeggcute": "fixturefin-1", "Suicune": "fixturefin-2", "Pineco": "fixturefin-3",
              "Clefairy": "fixturefin-4", "Celebi V": "fixturefin-5", "Weepinbell": "base2-48",
              "Dark Golduck": "ex7-35", "Starmie": "base1-64"}
UNSPECIFIED = {"kind": "unspecified", "label": "Unspecified Variant"}


def card_of(name: str) -> str:
    """The card a name (with any tag in parentheses) is a row of."""
    return name.split(" (")[0]


def tcgplayer(*rows):
    """The TCGplayer app's 12 columns, one (name, printing) per row, one copy each."""
    lines = [f'1,"{name}","{card_of(name)}",{SETS[card_of(name)][0]},{SETS[card_of(name)][1]},FF,{printing},'
             f"Near Mint,English,Rare,1,1" for name, printing in rows]
    return (TCGPLAYER + "\n".join(lines) + "\n").encode()


def collectr(*rows):
    lines = [f'Main,Pokemon,{SETS[card_of(name)][0]},"{name}",{SETS[card_of(name)][1]},Rare,{variance},Ungraded,'
             f"Near Mint,0,1,0.10,false,2026-10-01" for name, variance in rows]
    return (COLLECTR + "\n".join(lines) + "\n").encode()


def pricecharting(*rows):
    """(product-name, set) rows: the name already holds its [Variant] and #number."""
    lines = [f'500000{index},"{product}",Pokemon {set_name},10,Ungraded,Normal wear,,,0,1,2026-10-01,,,,Collection'
             for index, (product, set_name) in enumerate(rows)]
    return (PRICECHARTING + "\n".join(lines) + "\n").encode()


def tcg_collector(*rows):
    lines = [f"International,{SETS[name][0]},{SETS[name][1]},1,{name},Rare,{variant},English,Near Mint,,1"
             for name, variant in rows]
    return (TCG_COLLECTOR + "\r\n".join(lines) + "\r\n").encode()


def dragon_shield(*rows):
    lines = [f"Binder,1,0,{name},FF,{SETS[name][0]},{SETS[name][1]},NearMint,{printing},English,0,2026-10-01,0,0,0"
             for name, printing in rows]
    return (DRAGON_SHIELD + "\n".join(lines) + "\n").encode()


def sorted_list(*rows):
    lines = [f"Folder,Binder,pok,,,1,{name},FF,{SETS[name][0]},{SETS[name][1]},NearMint,{printing},Rare,en,0,"
             f"2026-10-01,,,0.10,1," for name, printing in rows]
    return (SORTED + "\n".join(lines) + "\n").encode()


def other_app(*rows):
    lines = [f'1,"{name}",{SETS[card_of(name)][0]},{SETS[card_of(name)][1]},{finish}' for name, finish in rows]
    return (OTHER_APP + "\n".join(lines) + "\n").encode()


def edition_where(source_id, **facets):
    """The Edition of this Printing whose descriptor, without lookup IDs or a standard size, is exactly `facets`."""
    with connect() as conn:
        found = conn.execute("""SELECT e.id,e.descriptor FROM catalog_edition e
          JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id=%s""", (source_id,)).fetchall()
    for row in found:
        physical = {key: value for key, value in row["descriptor"].items()
                    if key != "thirdParty" and not (key == "size" and value == "standard")}
        if physical == facets:
            return str(row["id"])
    raise AssertionError(f"no {facets} Edition of {source_id}: {found}")


def outcomes(owner, summary):
    """(status, the matched Edition's id or None) per row, in file order."""
    return [(row["status"], row["edition"]["edition_id"] if row["edition"] else None)
            for row in all_rows(owner, summary["id"])]


def change(owner, import_id, draft_revision, *changes):
    return call("POST", f"/api/collection-imports/{import_id}/changes", owner,
                {"draft_revision": draft_revision, "changes": list(changes)})


def changed(owner, import_id, draft_revision, *changes):
    response = change(owner, import_id, draft_revision, *changes)
    assert response.status_code == 200, response.text
    return response.json()


def counts(**values):
    return {"rows": 0, "needs_you": 0, "ready": 0, "finish_unknown": 0, "skipped": 0, **values}


def test_each_trackers_finish_words_and_name_tags_choose_the_card_edition():
    seed_import_catalog()
    owner, unsorted = collector()
    exeggcute, suicune, pineco, clefairy = (SOURCE_IDS[name] for name in ("Exeggcute", "Suicune", "Pineco",
                                                                           "Clefairy"))
    normal_egg, reverse_egg = edition_where(exeggcute, type="normal"), edition_where(exeggcute, type="reverse")
    poke_ball = edition_where(exeggcute, type="reverse", foil="pokeball")
    master_ball = edition_where(exeggcute, type="reverse", foil="masterball")
    holo, first_holo = edition_where(suicune, type="holo"), edition_where(suicune, type="holo", stamp=["1st-edition"])
    cosmos = edition_where(pineco, type="reverse", foil="cosmos")
    unlimited = edition_where(clefairy, type="normal", subtype="unlimited")
    first_shadowless = edition_where(clefairy, type="normal", subtype="shadowless", stamp=["1st-edition"])
    celebi = edition_where(SOURCE_IDS["Celebi V"], type="holo")
    weepinbell = edition("base2-48")
    waiting = ("ambiguous", None)
    cases = {
        "the TCGplayer app": (tcgplayer(
            ("Exeggcute", "Normal"), ("Exeggcute", "Reverse Holofoil"), ("Exeggcute (Poke Ball Pattern)", "Normal"),
            ("Exeggcute (Master Ball Pattern)", "Reverse Holofoil"), ("Suicune", "1st Edition Holofoil"),
            ("Suicune", "Holofoil"), ("Pineco (Cosmos Holo)", "Holofoil"), ("Clefairy", "Unlimited"),
            ("Clefairy", "1st Edition"),
            ("Clefairy", "Normal"),  # unlimited or shadowless: never a guess
            ("Pineco (Pokemon League)", "Normal"),  # a stamp the table doesn't hold
            ("Celebi V", "Reverse Holofoil"),  # one Edition: always that one
            ("Exeggcute", ""), ("Weepinbell", ""), ("Pineco", "Foil")), [
            ("matched", normal_egg), ("matched", reverse_egg), ("matched", poke_ball), ("matched", master_ball),
            ("matched", first_holo), ("matched", holo), ("matched", cosmos), ("matched", unlimited),
            ("matched", first_shadowless), waiting, waiting, ("matched", celebi), waiting,
            ("finish_unknown", weepinbell), waiting]),
        "Collectr": (collectr(
            ("Exeggcute", "Normal"), ("Exeggcute", "Poke Ball Reverse Holo"),
            ("Exeggcute (Master Ball Pattern)", "Holofoil"), ("Suicune", "1st Edition Holofoil"),
            ("Pineco (Cosmos Holo)", "Holofoil"), ("Dark Golduck", "Reverse Holofoil"),
            ("Weepinbell", "1st Edition")), [
            ("matched", normal_egg), ("matched", poke_ball), ("matched", master_ball), ("matched", first_holo),
            ("matched", cosmos), ("matched", edition("ex7-35", "reverse")), ("finish_unknown", weepinbell)]),
        "PriceCharting": (pricecharting(
            ("Exeggcute #1", "Fixture Finishes"),  # no tag: the plain card, normal or holo
            ("Exeggcute [Reverse Holo] #1", "Fixture Finishes"), ("Suicune #2", "Fixture Finishes"),
            ("Suicune [1st Edition] #2", "Fixture Finishes"), ("Pineco [Cosmos Holo] #3", "Fixture Finishes"),
            ("Clefairy #4", "Fixture Finishes"), ("Pineco [Prize Pack] #3", "Fixture Finishes")), [
            ("matched", normal_egg), ("matched", reverse_egg), ("matched", holo), ("matched", first_holo),
            ("matched", cosmos), waiting, waiting]),
        "TCG Collector": (tcg_collector(
            ("Exeggcute", "Normal"), ("Exeggcute", "Reverse Holo"),
            ("Pineco", "Normal"),  # no stamp words, so a set-logo stamp can't be ruled out
            ("Pineco", "Cosmos Holo"), ("Suicune", "Normal Holo"), ("Pineco", "Cracked Ice Holo"),
            ("Celebi V", "Promo")), [
            ("matched", normal_egg), ("matched", reverse_egg), waiting, ("matched", cosmos), waiting, waiting,
            ("matched", celebi)]),
        "Dragon Shield": (dragon_shield(("Exeggcute", "Normal"), ("Exeggcute", "Foil"), ("Weepinbell", "Normal")), [
            ("matched", normal_egg), waiting, ("matched", edition("base2-48", "normal"))]),
        "Sorted": (sorted_list(("Exeggcute", "Normal"), ("Suicune", "Normal")), [("matched", normal_egg), waiting]),
        "another app": (other_app(
            ("Exeggcute", "Reverse Holo"), ("Exeggcute (Poke Ball Pattern)", ""), ("Suicune", "1st Edition Holo"),
            ("Clefairy", "Unlimited"), ("Pineco", "Holo")), [
            ("matched", reverse_egg), ("matched", poke_ball), ("matched", first_holo), ("matched", unlimited),
            waiting]),
    }
    for tracker, (data, expected) in cases.items():
        summary = started(owner, unsorted, data)
        assert outcomes(owner, summary) == expected, tracker
        found = all_rows(owner, summary["id"])
        for row, (status, _) in zip(found, expected):
            # A card without an Unspecified Variant waits in Needs you with its card and Editions to pick from.
            assert row["needs_you"] == (status == "ambiguous"), (tracker, row)
            assert row["card"] is not None and row["editions"], (tracker, row)


def test_a_card_with_one_edition_always_gets_it_and_an_unknown_finish_is_finish_unknown():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, tcgplayer(("Celebi V", ""), ("Celebi V", "Foil"), ("Celebi V", "Normal"),
                                                 ("Weepinbell", ""), ("Weepinbell", "Holofoil"),
                                                 ("Weepinbell", "Normal"), ("Exeggcute", "")))
    celebi, weepinbell = edition_where("fixturefin-5", type="holo"), edition("base2-48")
    assert outcomes(owner, summary) == [
        ("matched", celebi), ("matched", celebi), ("matched", celebi), ("finish_unknown", weepinbell),
        ("finish_unknown", weepinbell), ("matched", edition("base2-48", "normal")), ("ambiguous", None)]
    assert summary["counts"] == counts(rows=7, needs_you=1, ready=6, finish_unknown=2)
    # Finish unknown never blocks saving; the card without an Unspecified Variant does until it's picked or skipped.
    assert [row["row_number"] for row in all_rows(owner, summary["id"], "finish")] == [4, 5]
    assert [row["row_number"] for row in all_rows(owner, summary["id"], "needs")] == [7]
    response = save(owner, summary["id"])
    assert response.status_code == 422 and response.json()["detail"] == {"code": "ROWS_NEED_YOU", "count": "1"}


def test_rows_list_the_cards_active_editions_with_physical_descriptors_only():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, tcgplayer(("Exeggcute", ""), ("Celebi V", ""), ("Flying Pikachu", "Normal")))
    response = call("GET", f"/api/collection-imports/{summary['id']}/rows?filter=all", owner)
    assert response.status_code == 200 and str(LOOKUP_ID) not in response.text and "thirdParty" not in response.text
    exeggcute, celebi, missing = response.json()["rows"]
    # Catalog order (descriptor_key), as catalog search lists them.
    assert [choice["descriptor"] for choice in exeggcute["editions"]] == [
        {"type": "reverse", "size": "standard", "foil": "masterball"},
        {"type": "reverse", "size": "standard", "foil": "pokeball"},
        {"type": "normal", "size": "standard"}, {"type": "reverse", "size": "standard"}]
    assert exeggcute["edition"] is None and exeggcute["skipped"] is False
    assert [choice["edition_id"] for choice in celebi["editions"]] == [celebi["edition"]["edition_id"]]
    assert missing["card"] is None and missing["editions"] == []
    # A withdrawn Edition is no longer offered, and a finish can't choose it.
    master_ball = edition_where("fixturefin-1", type="reverse", foil="masterball")
    with connect() as conn:
        conn.execute("""UPDATE catalog_generation_edition SET active=false
          WHERE generation_id=(SELECT active_generation FROM catalog_state WHERE singleton) AND edition_id=%s""",
                     (master_ball,))
    row = all_rows(owner, summary["id"])[0]
    assert master_ball not in [choice["edition_id"] for choice in row["editions"]] and len(row["editions"]) == 3
    result = changed(owner, summary["id"], 1, {"rows": [1], "finish": {"type": "reverse", "foil": "masterball"}})
    assert result["results"] == [{"applied": 0, "not_applied": [1]}]


def test_each_editions_own_descriptor_chooses_it_for_its_row():
    seed_import_catalog()
    owner, unsorted = collector()
    names = ("Exeggcute", "Suicune", "Pineco", "Clefairy", "Weepinbell", "Dark Golduck")
    summary = started(owner, unsorted, tcgplayer(*((name, "") for name in names)))
    draft_revision, bodies, last = 1, [], []
    for row in all_rows(owner, summary["id"]):
        assert len(row["editions"]) > 1, row
        for choice in row["editions"]:
            response = change(owner, summary["id"], draft_revision,
                              {"rows": [row["row_number"]], "finish": choice["descriptor"]})
            assert response.status_code == 200, response.text
            bodies.append(response.text)
            assert response.json()["results"] == [{"applied": 1, "not_applied": []}]
            draft_revision += 1
            assert response.json()["summary"]["draft_revision"] == draft_revision
            now = all_rows(owner, summary["id"])[row["row_number"] - 1]
            assert now["edition"]["edition_id"] == choice["edition_id"], (row["card"], choice)
            assert now["status"] == ("finish_unknown" if choice["descriptor"] == UNSPECIFIED else "matched")
            assert now["needs_you"] is False
        last.append({"finish": row["editions"][-1]["descriptor"]})
    with connect() as conn:
        fixes = [row["fix"] for row in conn.execute(
            "SELECT fix FROM collection_import_row WHERE import_id=%s ORDER BY row_number", (summary["id"],))]
    assert fixes == last
    for body in bodies:
        assert str(LOOKUP_ID) not in body and not TRACKER.search(body), body


def test_a_bulk_finish_by_filter_applies_only_where_the_card_has_that_finish():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, tcgplayer(
        ("Exeggcute", ""), ("Pineco", ""), ("Suicune", ""), ("Dark Golduck", ""), ("Weepinbell", ""),
        ("Flying Pikachu", "Holofoil"), ("Starmie", "Normal")))
    assert summary["counts"] == counts(rows=7, needs_you=5, ready=2, finish_unknown=1)
    before = revision(owner)
    result = changed(owner, summary["id"], 1, {"filter": "needs", "finish": {"type": "reverse"}},
                     {"filter": "finish", "finish": {"type": "reverse"}})
    # Suicune has no Reverse Holo, Flying Pikachu has no card, and Weepinbell has no Reverse Holo.
    assert result["results"] == [{"applied": 3, "not_applied": [3, 6]}, {"applied": 0, "not_applied": [5]}]
    assert result["summary"]["draft_revision"] == 2
    assert result["summary"]["counts"] == counts(rows=7, needs_you=2, ready=5, finish_unknown=1)
    assert result["summary"]["cards_to_add"] == "5"
    assert call("GET", "/api/collection-imports/current", owner).json() == result["summary"]
    assert outcomes(owner, summary) == [
        ("matched", edition_where("fixturefin-1", type="reverse")),
        ("matched", edition_where("fixturefin-3", type="reverse")), ("ambiguous", None),
        ("matched", edition("ex7-35", "reverse")), ("finish_unknown", edition("base2-48")), ("not_found", None),
        ("matched", edition("base1-64", "normal"))]
    # One row back to its Unspecified Variant, then to Normal: Finish unknown follows it.
    result = changed(owner, summary["id"], 2, {"rows": [5], "finish": {"finish": "normal"}})
    assert result["summary"]["counts"]["finish_unknown"] == 0
    result = changed(owner, summary["id"], 3, {"rows": [5, 7], "finish": UNSPECIFIED})
    assert result["results"] == [{"applied": 1, "not_applied": [7]}]
    assert result["summary"]["counts"]["finish_unknown"] == 1
    assert revision(owner) == before and held(owner, unsorted) == {}


def test_skip_and_restore_by_rows_and_filter_and_the_save_leaves_skipped_rows_out():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, tcgplayer(("Starmie", "Normal"), ("Flying Pikachu", "Holofoil"),
                                                 ("Exeggcute", ""), ("Weepinbell", "")))
    import_id = summary["id"]
    result = changed(owner, import_id, 1, {"rows": [2], "skip": True})
    assert result["results"] == [{"applied": 1, "not_applied": []}]
    assert result["summary"]["counts"] == counts(rows=4, needs_you=1, ready=2, finish_unknown=1, skipped=1)
    assert [row["row_number"] for row in all_rows(owner, import_id, "skipped")] == [2]
    assert [row["row_number"] for row in all_rows(owner, import_id, "all")] == [1, 3, 4]
    assert [row["row_number"] for row in all_rows(owner, import_id, "needs")] == [3]
    skipped = all_rows(owner, import_id, "skipped")[0]
    assert skipped["skipped"] is True and skipped["needs_you"] is False
    # A skipped row takes no finish until it is restored.
    result = changed(owner, import_id, 2, {"filter": "needs", "skip": True},
                     {"rows": [3], "finish": {"type": "normal"}})
    assert result["results"] == [{"applied": 1, "not_applied": []}, {"applied": 0, "not_applied": [3]}]
    assert result["summary"]["counts"] == counts(rows=4, needs_you=0, ready=2, finish_unknown=1, skipped=2)
    # A row already in the wanted state is reported, not counted.
    result = changed(owner, import_id, 3, {"rows": [3, 4], "restore": True}, {"rows": [2, 3], "skip": True})
    assert result["results"] == [{"applied": 1, "not_applied": [4]}, {"applied": 1, "not_applied": [2]}]
    result = changed(owner, import_id, 4, {"rows": [3], "restore": True})
    assert result["summary"]["counts"] == counts(rows=4, needs_you=1, ready=2, finish_unknown=1, skipped=1)
    result = changed(owner, import_id, 5, {"filter": "skipped", "restore": True})
    assert result["results"] == [{"applied": 1, "not_applied": []}]
    assert result["summary"]["counts"] == counts(rows=4, needs_you=2, ready=2, finish_unknown=1)
    # In order: the second change sees the first's skips.
    result = changed(owner, import_id, 6, {"filter": "needs", "skip": True}, {"filter": "skipped", "restore": True},
                     {"filter": "needs", "skip": True})
    assert [item["applied"] for item in result["results"]] == [2, 2, 2]
    assert result["summary"]["counts"] == counts(rows=4, needs_you=0, ready=2, finish_unknown=1, skipped=2)
    assert result["summary"]["cards_to_add"] == "2"
    before = revision(owner)
    response = save(owner, import_id, draft_revision=7)
    assert response.status_code == 200, response.text
    assert response.json()["copy_count"] == "2" and response.json()["owner_revision"] == before + 1
    assert held(owner, unsorted) == {edition("base1-64", "normal"): "1", edition("base2-48"): "1"}


def test_changes_are_all_or_nothing_and_refused_for_a_stale_revision_or_a_bad_change():
    seed_import_catalog()
    owner, unsorted = collector()
    other, _ = collector()
    summary = started(owner, unsorted, tcgplayer(("Starmie", "Normal"), ("Exeggcute", "")))
    import_id = summary["id"]
    refusals = {
        "NO_CHANGES": [],
        "INVALID_CHANGE": [{"rows": [1]}],
        "INVALID_FINISH": [{"rows": [1], "finish": {}}],
        "ROW_NOT_FOUND": [{"filter": "needs", "skip": True}, {"rows": [2, 99], "restore": True}],
    }
    for expected, changes in refusals.items():
        response = change(owner, import_id, 1, *changes)
        assert response.status_code == 422 and code(response) == expected, response.text
    for bad in ({"rows": [1], "filter": "all", "skip": True}, {"skip": True},
                {"rows": [1], "skip": True, "restore": True}, {"rows": [1], "finish": {"type": "normal"}, "skip": True},
                {"rows": [1], "skip": False}):
        response = change(owner, import_id, 1, bad)
        assert response.status_code == 422 and code(response) == "INVALID_CHANGE", (bad, response.text)
    # A descriptor with lookup IDs only names no finish.
    response = change(owner, import_id, 1, {"rows": [1], "finish": {"thirdParty": {"tcgplayer": 1}}})
    assert response.status_code == 422 and code(response) == "INVALID_FINISH", response.text
    # Fields a later ticket adds are refused, not ignored; so are more rows than one change takes.
    for bad in ({"rows": [1], "pick": str(uuid4())}, {"rows": [], "skip": True},
                {"rows": [0], "skip": True}, {"rows": [2**31], "skip": True},
                {"rows": list(range(1, 1002)), "skip": True}, {"filter": "name", "skip": True}):
        assert change(owner, import_id, 1, bad).status_code == 422, bad
    response = change(owner, import_id, 2, {"rows": [1], "skip": True})
    assert response.status_code == 409 and code(response) == "STALE_DRAFT"
    for user, draft in ((other, import_id), (owner, str(uuid4()))):
        response = change(user, draft, 1, {"rows": [1], "skip": True})
        assert response.status_code == 404 and code(response) == "IMPORT_NOT_FOUND"
    current = call("GET", "/api/collection-imports/current", owner).json()
    assert current["draft_revision"] == 1 and current["counts"] == summary["counts"]
    # Two changes at once at one revision: one applies, the other is stale.
    with ThreadPoolExecutor(2) as pool:
        responses = list(pool.map(lambda _: change(owner, import_id, 1, {"filter": "needs", "skip": True}),
                                  range(2)))
    assert sorted(response.status_code for response in responses) == [200, 409]
    assert call("GET", "/api/collection-imports/current", owner).json()["draft_revision"] == 2
    # A saved draft takes no changes.
    assert save(owner, import_id, draft_revision=2).status_code == 200
    response = change(owner, import_id, 2, {"rows": [1], "restore": True})
    assert response.status_code == 404 and code(response) == "IMPORT_NOT_FOUND"
