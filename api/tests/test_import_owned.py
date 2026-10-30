"""Owned cards in the import review (decklist import #214): ``POST /api/decks/import/review`` through signed HTTP.

Owned copies come first, from one pool shared by every pasted line in paste order, under the owned-cards setting
(``owned``: ``exact`` for Exact printings, ``owned`` for Use cards I own, the default) and the Want List counting
setting: a new Deck counts as the newest. A line takes the named Printing's copies, then under Use cards I own the other
Printings of its Reprint Group (for Basic Energy, every Basic Energy of its type); within a step the Edition with the
most copies goes first, then catalog order. The rest gets add-by-Printing's Edition. Copies other Decks keep are
noted on lines that still get new copies.

Every test starts a new owner on a freshly seeded catalog (seeding removes every Holding); Deck creation times are set
explicitly wherever the order matters.
"""
from concurrent.futures import ThreadPoolExecutor
import time
from uuid import UUID, uuid4

from app.main import connect  # noqa: F401
from app import quote_contract
from app.public_records import result_key
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import counting, deck, hold, line, new_owner
from test_deck_import import sql
from test_deck_list_printing import furret_world
from test_holdings import call
from test_prices import seed
from deck_import_fixtures import seed_import_owned_catalog

REVIEW = "/api/decks/import/review"


def review(owner, text, owned=None, fixes=()):
    body = {"source": {"text": text}, "fixes": list(fixes)}
    if owned is not None:
        body["owned"] = owned
    response = call("POST", REVIEW, owner, body)
    assert response.status_code == 200, response.text
    return response.json()


def edition(source_id, finish):
    """The Card Edition of the seeded Printing ``source_id`` ("sv02-254") with ``finish``."""
    return str(sql("""SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
                      WHERE p.source_id=%s AND e.descriptor->>'finish'=%s""", (source_id, finish))[0][0])


def editions():
    seed_import_owned_catalog()
    return {"185": edition("sv02-185", "normal"), "185R": edition("sv02-185", "reverse"),
            "254": edition("sv02-254", "holo"), "P5": edition("sve-005", "normal"),
            "P13": edition("sve-013", "normal"), "PM5": edition("mee-005", "normal"),
            "D15": edition("sve-015", "normal")}


def place(owner, name):
    """A new top-level Location (a storage leaf) named ``name``."""
    response = call("POST", "/api/location-tree", owner, {"name": name, "parent_id": None, "parent_version": None,
                                                          "idempotency_key": str(uuid4())})
    assert response.status_code in (200, 201), response.text
    return response.json()["location"]["id"]


def parts(body, index=0):
    """A line's parts as (Edition, quantity, source, chosen_by, [(place name, is a Deck, copies)])."""
    return [(part["edition_id"], part["quantity"], part["source"], part["chosen_by"],
             [(where["name"], where["deck"], where["quantity"]) for where in part["places"]])
            for part in body["lines"][index]["parts"]]


def kept(body, index=0):
    return [(note["deck_id"], note["quantity"], note["reason"]) for note in body["lines"][index]["kept"]]


def deck_list(body):
    return [(entry["edition_id"], entry["quantity"]) for entry in body["deck_list"]]


def totals(body):
    return body["totals"]["owned"], body["totals"]["to_get"]


# ------------------------------------------------------------------ the two settings and the step order


def test_exact_printings_and_use_cards_i_own_on_one_paste():
    e = editions()
    owner, _ = new_owner()
    binder = place(owner, "Binder")
    hold(owner, binder, e["185R"], 2)
    hold(owner, binder, e["254"], 1)
    mine = review(owner, "4 Iono PAL 185\n")
    assert mine["owned"] == "owned" and mine["want_list_counting"] == "all_at_once"
    assert parts(mine) == [(e["185R"], "2", "elsewhere", None, [("Binder", False, "2")]),
                           (e["254"], "1", "elsewhere", None, [("Binder", False, "1")]),
                           (e["185"], "1", "new", "catalog_order", [])]
    holo = mine["lines"][0]["parts"][1]
    assert (holo["name"], holo["set_code"], holo["collector_number"], holo["descriptor"]) == (
        "Iono", "PAL", "254", {"finish": "holo"})
    assert totals(mine) == ("3", "1")
    assert deck_list(mine) == [(e["185R"], "2"), (e["254"], "1"), (e["185"], "1")]
    exact = review(owner, "4 Iono PAL 185\n", "exact")
    assert exact["owned"] == "exact"
    assert parts(exact) == [(e["185R"], "2", "elsewhere", None, [("Binder", False, "2")]),
                            (e["185"], "2", "new", "catalog_order", [])]
    assert totals(exact) == ("2", "2")
    assert review(owner, "4 Iono PAL 185\n", "owned") == mine


def test_the_named_printing_comes_first_then_the_most_copies_then_catalog_order():
    e = editions()
    owner, unsorted = new_owner()
    hold(owner, unsorted, e["185"], 1)
    hold(owner, unsorted, e["185R"], 2)
    hold(owner, unsorted, e["254"], 3)
    # The named Printing's Editions first, most copies first (Reverse Holo 2, then Normal 1), though PAL 254 has more.
    assert [part[:3] for part in parts(review(owner, "4 Iono PAL 185\n"))] == [
        (e["185R"], "2", "elsewhere"), (e["185"], "1", "elsewhere"), (e["254"], "1", "elsewhere")]
    # Naming PAL 254 takes its own copies first, then PAL 185's.
    assert [part[:3] for part in parts(review(owner, "5 Iono PAL 254\n"))] == [
        (e["254"], "3", "elsewhere"), (e["185R"], "2", "elsewhere")]
    # As many copies of two Editions: catalog order (Normal before Reverse Holo).
    other, unsorted = new_owner()
    hold(other, unsorted, e["185"], 1)
    hold(other, unsorted, e["185R"], 1)
    assert [part[:3] for part in parts(review(other, "2 Iono PAL 185\n", "exact"))] == [
        (e["185"], "1", "elsewhere"), (e["185R"], "1", "elsewhere")]


def test_a_printing_in_no_group_and_a_card_nobody_owns_get_new_copies():
    e = editions()
    owner, unsorted = new_owner()
    hold(owner, unsorted, e["254"], 2)
    body = review(owner, "2 Nest Ball SVI 181\n")
    assert [part[2] for part in parts(body)] == ["new"]
    assert body["lines"][0]["kept"] == []
    assert totals(body) == ("0", "2")


# ------------------------------------------------------------------ splits, merging and the shared pool


def test_pasted_lines_draw_from_one_shared_pool_in_paste_order_and_parts_merge_by_edition():
    e = editions()
    owner, unsorted = new_owner()
    hold(owner, unsorted, e["185R"], 1)
    # Two lines naming one card: the first takes the one owned copy, the second gets only new copies.
    body = review(owner, "2 Iono PAL 185\n2 Iono PAL 185\n")
    assert [part[:3] for part in parts(body, 0)] == [(e["185R"], "1", "elsewhere"), (e["185"], "1", "new")]
    assert [part[:3] for part in parts(body, 1)] == [(e["185"], "2", "new")]
    assert deck_list(body) == [(e["185R"], "1"), (e["185"], "3")]
    # Another card's line takes the group's copies before a later line naming them can.
    hold(owner, unsorted, e["254"], 2)
    first = review(owner, "2 Iono PAL 185\n2 Iono PAL 254\n")
    assert [part[:3] for part in parts(first, 0)] == [(e["185R"], "1", "elsewhere"), (e["254"], "1", "elsewhere")]
    assert [part[:3] for part in parts(first, 1)] == [(e["254"], "1", "elsewhere"), (e["254"], "1", "new")]
    assert totals(first) == ("3", "1")
    assert deck_list(first) == [(e["185R"], "1"), (e["254"], "3")]


def test_an_edition_the_collector_chose_is_the_rest_and_merges_with_owned_copies_of_it():
    e = editions()
    owner, unsorted = new_owner()
    hold(owner, unsorted, e["185R"], 1)
    body = review(owner, "3 Iono PAL 185\n", "exact", [{"line": 1, "edition_id": e["185R"]}])
    assert [part[:4] for part in parts(body)] == [(e["185R"], "1", "elsewhere", None),
                                                  (e["185R"], "2", "new", "collector")]
    assert deck_list(body) == [(e["185R"], "3")]


# ------------------------------------------------------------------ the counting setting


def test_copies_another_deck_holds_for_its_own_line_are_left_alone_and_noted_under_every_deck_built_at_once():
    e = editions()
    owner, _ = new_owner()
    binder = place(owner, "Binder")
    charizard = deck(owner, "Charizard ex", 0)
    hold(owner, charizard, e["254"], 2)   # holding copies in a Deck lists them (migration 031)
    hold(owner, binder, e["185R"], 1)
    body = review(owner, "3 Iono PAL 185\n")
    assert parts(body) == [(e["185R"], "1", "elsewhere", None, [("Binder", False, "1")]),
                           (e["185"], "2", "new", "catalog_order", [])]
    assert kept(body) == [(charizard, "2", "own_line")]
    assert body["lines"][0]["kept"][0]["name"].startswith("Charizard ex")
    # Exact printings never reaches PAL 254, so nothing of it is noted.
    assert kept(review(owner, "3 Iono PAL 185\n", "exact")) == []
    # A line its owned copies cover says nothing about other Decks.
    assert kept(review(owner, "1 Iono PAL 185\n")) == []


def test_one_deck_at_a_time_uses_copies_sleeved_in_other_decks_labelled_with_the_deck():
    e = editions()
    owner, _ = new_owner()
    binder = place(owner, "Binder")
    charizard = deck(owner, "Charizard ex", 0)
    hold(owner, charizard, e["254"], 3)
    line(owner, charizard, e["254"], 2)   # two for its own list and one beyond it
    hold(owner, binder, e["185R"], 1)
    counting(owner, "one_at_a_time")
    body = review(owner, "4 Iono PAL 185\n")
    assert body["want_list_counting"] == "one_at_a_time"
    name = body["lines"][0]["parts"][1]["places"][0]["name"]
    assert name.startswith("Charizard ex")
    # The Deck's copy beyond its list and the two it holds for it are one place.
    assert parts(body) == [(e["185R"], "1", "elsewhere", None, [("Binder", False, "1")]),
                           (e["254"], "3", "elsewhere", None, [(name, True, "3")])]
    assert body["lines"][0]["parts"][1]["places"][0]["location_id"] == charizard
    assert kept(body) == [] and totals(body) == ("4", "0")


def test_a_new_deck_is_the_newest_so_spares_older_decks_count_are_not_used_and_are_noted():
    e = editions()
    owner, _ = new_owner()
    binder = place(owner, "Binder")
    older = deck(owner, "Older", 0)
    newest = deck(owner, "Newest", 5)
    line(owner, older, e["185"], 1)
    line(owner, newest, e["185"], 1)
    hold(owner, binder, e["185"], 3)
    # The two existing Decks count two of the three loose copies, whichever was created last; the import gets one.
    body = review(owner, "3 Iono PAL 185\n", "exact")
    assert [part[:3] for part in parts(body)] == [(e["185"], "1", "elsewhere"), (e["185"], "2", "new")]
    assert kept(body) == [(older, "1", "counted"), (newest, "1", "counted")]
    counting(owner, "one_at_a_time")
    every = review(owner, "3 Iono PAL 185\n", "exact")
    assert [part[:3] for part in parts(every)] == [(e["185"], "3", "elsewhere")] and kept(every) == []


def test_another_decks_surplus_is_spare_and_loose_copies_are_used_first():
    e = editions()
    owner, _ = new_owner()
    binder = place(owner, "Binder")
    box = place(owner, "Attic box")
    gardevoir = deck(owner, "Gardevoir ex", 0)
    hold(owner, gardevoir, e["185R"], 3)
    line(owner, gardevoir, e["185R"], 1)   # two copies beyond its line: its Surplus
    hold(owner, binder, e["185R"], 1)
    hold(owner, box, e["185R"], 1)
    body = review(owner, "4 Iono PAL 185\n", "exact")
    [used] = body["lines"][0]["parts"]
    assert (used["source"], used["quantity"]) == ("elsewhere", "4")
    assert [(where["location_id"], where["deck"], where["quantity"]) for where in used["places"]] == [
        (box, False, "1"), (binder, False, "1"), (gardevoir, True, "2")]
    assert totals(body) == ("4", "0")
    assert kept(review(owner, "5 Iono PAL 185\n", "exact")) == [(gardevoir, "1", "own_line")]


# ------------------------------------------------------------------ Basic Energy


def test_basic_energy_of_one_type_counts_as_one_group_under_use_cards_i_own_only():
    e = editions()
    owner, unsorted = new_owner()
    hold(owner, unsorted, e["P5"], 3)
    hold(owner, unsorted, e["D15"], 2)
    # SVE 13 matched by its code: the owned SVE 5 Psychic Energy covers it, the Darkness Energy never does.
    body = review(owner, "4 Basic {P} Energy SVE 13\n")
    assert body["lines"][0]["status"] == "matched"
    assert [part[:3] for part in parts(body)] == [(e["P5"], "3", "elsewhere"), (e["P13"], "1", "new")]
    assert [part[:3] for part in parts(review(owner, "4 Basic {P} Energy SVE 13\n", "exact"))] == [
        (e["P13"], "4", "new")]
    # Matched by type (SVALT is a game-only code): the same group.
    energy = review(owner, "2 Basic {P} Energy SVALT 135\n")
    assert energy["lines"][0]["status"] == "energy"
    assert [part[:3] for part in parts(energy)] == [(e["P5"], "2", "elsewhere")]


# ------------------------------------------------------------------ totals, prices and the capture


def test_totals_count_owned_copies_and_the_stored_cost_of_the_rest_without_a_price_access(store, launches):
    owner, unsorted = new_owner()
    printing, (first, second), by_id = furret_world(owner)
    seed(store, by_id[first], "0.50")
    seed(store, by_id[second], "0.10")
    keys = [result_key(by_id[each]["public_ref"], by_id[each]["mapping_revision"]) for each in (first, second)]
    generation = store.read_records(keys, deadline=time.monotonic() + 5).generation
    hold(owner, unsorted, first, 1)
    body = review(owner, "3 Furret DAA 1\n")
    assert [part[:4] for part in parts(body)] == [(first, "1", "elsewhere", None), (second, "2", "new", "cheapest_price")]
    shown = body["totals"]
    assert (shown["owned"], shown["to_get"], shown["to_get_priced"], shown["to_get_amount"], shown["to_get_display"]) == (
        "1", "2", "2", "0.2", "$0.20")
    assert launches == []
    key = quote_contract.scheduler_key()
    assert store.read_records([key], deadline=time.monotonic() + 5).records[key].value is None
    assert store.read_records(keys, deadline=time.monotonic() + 5).generation == generation


def test_unpriced_copies_to_get_are_counted_apart_and_never_as_zero():
    editions()
    owner, _ = new_owner()
    body = review(owner, "2 Iono PAL 185\n")
    assert (body["totals"]["to_get"], body["totals"]["to_get_priced"], body["totals"]["to_get_amount"],
            body["totals"]["to_get_display"]) == ("2", "0", None, None)


def test_a_first_time_caller_owns_nothing_and_the_review_creates_no_owner():
    editions()
    stranger = f"stranger-{uuid4()}"
    body = review(stranger, "4 Iono PAL 185\n")
    assert (body["want_list_counting"], body["settings_revision"], body["owner_revision"]) == ("all_at_once", 1, 1)
    assert totals(body) == ("0", "4")
    assert sql("SELECT count(*) FROM inventory_owner WHERE user_id=%s", (stranger,)) == [(0,)]


def test_every_answer_belongs_to_the_counting_setting_it_names():
    e = editions()
    owner, unsorted = new_owner()
    charizard = deck(owner, "Charizard ex", 0)
    hold(owner, charizard, e["254"], 2)
    hold(owner, unsorted, e["185R"], 1)
    expected = {"all_at_once": "1", "one_at_a_time": "3"}

    def flip():
        for value in ["one_at_a_time", "all_at_once"] * 5:
            counting(owner, value)

    def answers():
        return [(body["want_list_counting"], body["totals"]["owned"])
                for body in (review(owner, "3 Iono PAL 185\n") for _ in range(10))]

    # The setting, the Holdings and the Deck Lists are read under one owner lock, so a concurrent change never yields
    # owned copies from one setting labelled with the other.
    with ThreadPoolExecutor(max_workers=3) as pool:
        flips = pool.submit(flip)
        reads = [pool.submit(answers) for _ in range(2)]
        flips.result()
        seen = [answer for future in reads for answer in future.result()]
    assert seen and all(owned == expected[setting] for setting, owned in seen), seen


class CountingConnection:
    """A connection that records how many rows each statement returns."""

    def __init__(self, conn, seen):
        self.conn, self.seen = conn, seen

    def __enter__(self):
        self.conn.__enter__()
        return self

    def __exit__(self, *exc):
        return self.conn.__exit__(*exc)

    def transaction(self):
        return self.conn.transaction()

    def execute(self, query, params=None):
        cursor = self.conn.execute(query, params)
        if cursor.description is not None:
            self.seen.append(cursor.rowcount)
        return cursor


def test_the_capture_reads_only_the_holdings_of_the_cards_the_lines_reach(monkeypatch):
    from app.games.pokemon.imports import import_owned
    e = editions()
    owner, unsorted = new_owner()
    hold(owner, unsorted, e["185R"], 1)
    real = import_owned.connect

    def rows_read():
        seen = []
        monkeypatch.setattr(import_owned, "connect", lambda: CountingConnection(real(), seen))
        body = review(owner, "2 Iono PAL 185\n")
        monkeypatch.setattr(import_owned, "connect", real)
        return body, sum(seen)

    before, read_before = rows_read()
    # Copies of cards no line reaches (Nest Ball, Energy) change neither what the capture reads nor the answer.
    for other in (e["P5"], e["P13"], e["D15"], edition("sv01-181", "normal")):
        hold(owner, unsorted, other, 3)
    after, read_after = rows_read()
    assert read_after == read_before
    assert {**after, "owner_revision": None} == {**before, "owner_revision": None}


# ------------------------------------------------------------------ Replace's hook (#215 builds its HTTP seam on it)


def test_available_to_an_existing_deck_takes_its_own_copies_out_of_the_pool_before_the_walk():
    from app.copy_allocation import Kept, available_to
    e = editions()
    owner, _ = new_owner()
    binder = place(owner, "Binder")
    older = deck(owner, "Older", 0)
    mine = deck(owner, "Mine", 1)
    line(owner, older, e["185"], 3)
    hold(owner, mine, e["185"], 2)
    line(owner, mine, e["185"], 1)   # one copy beyond its line: a Spare Copy the older Deck counts today
    hold(owner, binder, e["185"], 1)

    def available(counting, deck_id):
        with connect() as conn, conn.transaction():
            conn.execute("SELECT revision FROM inventory_owner WHERE user_id=%s FOR UPDATE", (owner,))
            return available_to(conn, owner, [UUID(e["185"])], counting, deck_id).editions[UUID(e["185"])]

    # A new Deck: the older Deck counts both Spare Copies (the Binder's and Mine's extra one); Mine keeps its own.
    new = available("all_at_once", None)
    assert (new.in_deck, new.elsewhere) == (0, ())
    assert new.kept == (Kept(UUID(older), 2, True), Kept(UUID(mine), 1, False))
    # Replacing Mine's list: all of Mine's copies are its own pool, so the older Deck counts only the Binder's copy.
    replace = available("all_at_once", UUID(mine))
    assert (replace.in_deck, replace.elsewhere, replace.kept) == (2, (), (Kept(UUID(older), 1, True),))
    # One Deck at a time: every copy outside Mine.
    every = available("one_at_a_time", UUID(mine))
    assert (every.in_deck, every.elsewhere, every.kept) == (2, ((UUID(binder), 1),), ())
