"""The Want List (decklist import #209): ``GET /api/want-list`` through signed HTTP against PostgreSQL.

One section per Deck, oldest Deck first (creation time, the Deck id breaking ties), each listing the lines that still
need copies with where the counted copies are; and a combined total listing each card once with the Decks that need
it. Under **Every Deck built at once** (the default) the total is the sum of the sections; under **One Deck at a time**
it is the largest need per card. A Deck's section always needs what its builder's "to complete", Buy missing and the
Deck detail say (``test_deck_counting.need`` asserts those three agree). ``?deck=<id>`` scopes the read to one Deck.

Every test starts a new owner, so no setting leaks between tests; Deck creation times are set explicitly.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import UUID, uuid4

from app.main import connect  # noqa: F401
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import EPOCH, counting, created, deck, hold, iono_world, line, need, new_owner
from test_holdings import add, call
from test_prices import seed, world


def want_list(owner, scope=None):
    response = call("GET", "/api/want-list" + (f"?deck={scope}" if scope else ""), owner)
    assert response.status_code == 200, response.text
    return response.json()


def section(body, deck_id):
    return next(entry for entry in body["sections"] if entry["deck_id"] == deck_id)


def counts(entry):
    """A line's counts, in the order the page reads them."""
    return (entry["quantity"], entry["held"], entry["spare"], entry["other_decks"], entry["need"], entry["owned"])


def check_shape(body):
    """What every answer holds whatever the Collection: each line's parts add up to its quantity, the Decks a line
    counts from add up to its other-Deck copies, each section's ``to_get`` is the sum of its lines, and the combined
    total follows the setting."""
    for entry in body["sections"]:
        assert entry["to_get"] == str(sum(int(item["need"]) for item in entry["lines"]))
        for item in entry["lines"]:
            assert int(item["need"]) > 0
            assert sum(int(item[key]) for key in ("held", "spare", "other_decks", "need")) == int(item["quantity"])
            assert sum(int(source["quantity"]) for source in item["counted_from"]) == int(item["other_decks"])
            if body["want_list_counting"] == "all_at_once":
                assert item["counted_from"] == [] and item["other_decks"] == "0"
    needs = {}
    for entry in body["sections"]:
        for item in entry["lines"]:
            needs.setdefault(item["edition_id"], []).append((entry["deck_id"], item["need"]))
    pick = sum if body["want_list_counting"] == "all_at_once" else max
    assert {row["edition_id"]: (row["need"], [(d["deck_id"], d["need"]) for d in row["decks"]])
            for row in body["combined"]} == {
        edition: (str(pick(int(n) for _, n in found)), found) for edition, found in needs.items()}
    assert body["to_get"] == str(sum(int(row["need"]) for row in body["combined"]))


def test_the_worked_iono_example_under_both_settings(store):
    owner, charizard, gardevoir, edition = iono_world(store)
    body = want_list(owner)
    check_shape(body)
    assert (body["want_list_counting"], body["deck_id"]) == ("all_at_once", None)
    assert [entry["deck_id"] for entry in body["sections"]] == [charizard, gardevoir]
    # Charizard ex (older) holds 1 and takes the loose spare: 2 of 4. Gardevoir ex can't count Charizard ex's copy, so
    # its 2 owned copies are counted for another Deck: 2 of 2. The total is 4, the sum of the sections.
    [older] = section(body, charizard)["lines"]
    [newer] = section(body, gardevoir)["lines"]
    assert (older["edition_id"], counts(older)) == (edition, ("4", "1", "1", "0", "2", "2"))
    assert (newer["edition_id"], counts(newer)) == (edition, ("2", "0", "0", "0", "2", "2"))
    assert [(row["edition_id"], row["need"], row["decks"]) for row in body["combined"]] == [
        (edition, "4", [{"deck_id": charizard, "need": "2"}, {"deck_id": gardevoir, "need": "2"}])]
    assert body["to_get"] == "4"
    decks = (charizard, gardevoir)
    assert [section(body, d)["to_get"] for d in decks] == [need(owner, d) for d in decks]

    # One Deck at a time: Gardevoir ex counts Charizard ex's copy and the loose one and needs nothing; the total is the
    # largest need, Charizard ex's 2.
    counting(owner, "one_at_a_time")
    body = want_list(owner)
    check_shape(body)
    assert body["want_list_counting"] == "one_at_a_time"
    assert counts(section(body, charizard)["lines"][0]) == ("4", "1", "1", "0", "2", "2")
    assert (section(body, gardevoir)["to_get"], section(body, gardevoir)["lines"]) == ("0", [])
    assert [(row["need"], row["decks"]) for row in body["combined"]] == [("2", [{"deck_id": charizard, "need": "2"}])]
    assert body["to_get"] == "2"
    decks = (charizard, gardevoir)
    assert [section(body, d)["to_get"] for d in decks] == [need(owner, d) for d in decks]


def test_one_deck_at_a_time_names_the_deck_whose_copies_a_line_counts_and_the_total_takes_the_largest_need(store):
    owner, charizard, gardevoir, edition = iono_world(store)
    line(owner, gardevoir, edition, 3)
    body = want_list(owner)
    check_shape(body)
    # Every Deck built at once: 2 + 3.
    assert counts(section(body, gardevoir)["lines"][0]) == ("3", "0", "0", "0", "3", "2")
    assert body["to_get"] == "5"
    counting(owner, "one_at_a_time")
    body = want_list(owner)
    check_shape(body)
    # Gardevoir ex counts the loose copy and the one Charizard ex holds for its own line: "Have 1 spare · 1 in
    # Charizard ex", 1 of 3.
    [newer] = section(body, gardevoir)["lines"]
    assert counts(newer) == ("3", "0", "1", "1", "1", "2")
    assert newer["counted_from"] == [{"deck_id": charizard, "quantity": "1"}]
    # The total takes the largest need: Charizard ex's 2, not 2 + 1.
    assert [(row["need"], row["decks"]) for row in body["combined"]] == [
        ("2", [{"deck_id": charizard, "need": "2"}, {"deck_id": gardevoir, "need": "1"}])]
    assert body["to_get"] == "2"
    assert section(body, gardevoir)["to_get"] == need(owner, gardevoir) == "1"


def test_other_decks_copies_are_named_oldest_deck_first(store):
    edition = world()["normal"]
    seed(store, edition, "0.25")
    edition = str(edition["id"])
    owner, _ = new_owner()
    newest, middle, oldest = deck(owner, "Newest", 2), deck(owner, "Middle", 1), deck(owner, "Oldest", 0)
    hold(owner, middle, edition, 2)   # moving copies in lists them (migration 031)
    hold(owner, oldest, edition, 2)
    line(owner, newest, edition, 5)
    counting(owner, "one_at_a_time")
    body = want_list(owner)
    check_shape(body)
    [wanting] = section(body, newest)["lines"]
    assert wanting["counted_from"] == [{"deck_id": oldest, "quantity": "2"}, {"deck_id": middle, "quantity": "2"}]
    assert counts(wanting) == ("5", "0", "0", "4", "1", "4")


def test_sections_follow_creation_order_with_the_deck_id_breaking_a_tie_and_spares_go_oldest_first(store):
    edition = world()["normal"]
    seed(store, edition, "0.25")
    edition = str(edition["id"])
    owner, unsorted = new_owner()
    first, second = deck(owner, "First", 0), deck(owner, "Second", 0)
    empty = deck(owner, "Empty", 5)
    low, high = sorted((first, second), key=UUID)
    for deck_id in (low, high):
        line(owner, deck_id, edition, 1)
    hold(owner, unsorted, edition, 1)
    # Created at the same moment, the lower Deck id comes first and takes the spare.
    body = want_list(owner)
    check_shape(body)
    assert [entry["deck_id"] for entry in body["sections"]] == [low, high, empty]
    assert [entry["id"] for entry in body["decks"]] == [low, high, empty]
    assert [section(body, d)["to_get"] for d in (low, high, empty)] == ["0", "1", "0"]
    # A Deck with an empty Deck List still has its section, with nothing to get.
    assert section(body, empty)["lines"] == []
    # Creation time decides, even against the Deck id.
    created(owner, high, EPOCH - timedelta(days=1))
    body = want_list(owner)
    assert [entry["deck_id"] for entry in body["sections"]] == [high, low, empty]
    assert [section(body, d)["to_get"] for d in (high, low)] == ["0", "1"]
    assert [section(body, d)["to_get"] for d in (high, low)] == [need(owner, d) for d in (high, low)]


def mixed_world(store):
    """Three Editions over four Decks, with Surplus, a Deck holding copies it doesn't list and loose copies, so every
    count is exercised. Returns (owner, decks oldest first)."""
    found = world()
    editions = [found["normal"], found["reverse-holofoil"], found["unspecified"]]
    for edition in editions[:2]:         # the Unspecified Variant is never priced
        seed(store, edition, "0.25")
    a, b, c = (str(edition["id"]) for edition in editions)
    owner, unsorted = new_owner()
    keeper, extra, cut, wanting = (deck(owner, name, days) for name, days in
                                   (("Keeper", 0), ("Extra", 1), ("Cut", 2), ("Wanting", 3)))
    hold(owner, keeper, a, 2)        # lists 2 and holds 2: none spare
    line(owner, keeper, b, 3)
    hold(owner, extra, a, 3)
    line(owner, extra, a, 1)         # 2 Surplus copies of a, spare
    line(owner, extra, c, 2)
    hold(owner, cut, b, 1)
    line(owner, cut, b, 0)           # holds 1 of b with no line: spare
    line(owner, wanting, a, 4)
    line(owner, wanting, b, 2)
    line(owner, wanting, c, 1)
    hold(owner, unsorted, c, 1)
    return owner, [keeper, extra, cut, wanting]


def test_sections_add_up_and_each_agrees_with_the_decks_own_figures_under_both_settings(store):
    owner, decks = mixed_world(store)
    for setting in ("all_at_once", "one_at_a_time"):
        counting(owner, setting)
        body = want_list(owner)
        check_shape(body)
        assert body["want_list_counting"] == setting
        assert [entry["deck_id"] for entry in body["sections"]] == decks
        # One number everywhere: each section needs what the Deck detail, the cost to complete and Buy missing say.
        assert [section(body, d)["to_get"] for d in decks] == [need(owner, d) for d in decks]
        if setting == "all_at_once":
            assert body["to_get"] == str(sum(int(entry["to_get"]) for entry in body["sections"]))
    # Every Deck built at once: Keeper, the oldest, takes Cut's b and needs 2 more; Extra takes the loose c and needs 1;
    # Wanting counts Extra's 2 Surplus a, never Keeper's 2, and needs 2 a, 2 b and 1 c.
    counting(owner, "all_at_once")
    assert [section(want_list(owner), d)["to_get"] for d in decks] == ["2", "1", "0", "5"]
    # One Deck at a time: Wanting also counts Keeper's 2 a and the loose c, and needs only 1 b.
    counting(owner, "one_at_a_time")
    body = want_list(owner)
    assert [section(body, d)["to_get"] for d in decks] == ["2", "1", "0", "1"]


def test_the_scoped_read_is_that_decks_section_and_its_needs(store):
    owner, decks = mixed_world(store)
    for setting in ("all_at_once", "one_at_a_time"):
        counting(owner, setting)
        whole = want_list(owner)
        for deck_id in decks:
            scoped = want_list(owner, deck_id)
            check_shape(scoped)
            assert scoped["deck_id"] == deck_id
            assert scoped["decks"] == whole["decks"]
            assert scoped["sections"] == [section(whole, deck_id)]
            assert [(row["edition_id"], row["need"], row["decks"]) for row in scoped["combined"]] == [
                (item["edition_id"], item["need"], [{"deck_id": deck_id, "need": item["need"]}])
                for item in section(whole, deck_id)["lines"]]
            assert scoped["to_get"] == section(whole, deck_id)["to_get"]
            for key in ("want_list_counting", "settings_revision", "owner_revision"):
                assert scoped[key] == whole[key]


def test_every_answer_belongs_to_the_setting_it_names(store):
    owner, _, gardevoir, _ = iono_world(store)
    expected = {"all_at_once": ("4", "2"), "one_at_a_time": ("2", "0")}

    def flip():
        for value in ["one_at_a_time", "all_at_once"] * 5:
            counting(owner, value)

    def answers():
        seen = []
        for _ in range(10):
            body = want_list(owner)
            seen.append((body["want_list_counting"], (body["to_get"], section(body, gardevoir)["to_get"])))
            scoped = want_list(owner, gardevoir)
            seen.append((scoped["want_list_counting"], (expected[scoped["want_list_counting"]][0], scoped["to_get"])))
        return seen

    # The setting, the Holdings and the Deck Lists are read under one owner lock, so a concurrent change never yields
    # figures from one setting labelled with the other.
    with ThreadPoolExecutor(max_workers=3) as pool:
        flips = pool.submit(flip)
        reads = [pool.submit(answers) for _ in range(2)]
        flips.result()
        seen = [answer for future in reads for answer in future.result()]
    assert seen and all(figures == expected[setting] for setting, figures in seen), seen


def test_a_scope_that_is_not_one_of_the_owners_decks_is_not_found(store):
    owner, charizard, _, _ = iono_world(store)
    stranger, _ = new_owner()
    unsorted = next(entry["id"] for entry in call("GET", "/api/location-tree", owner).json()["locations"]
                    if entry["name"] == "Unsorted")
    for scope in (str(uuid4()), unsorted):
        response = call("GET", f"/api/want-list?deck={scope}", owner)
        assert (response.status_code, response.json()["detail"]["code"]) == (404, "DECK_NOT_FOUND")
    # Another collector's Deck is not found either, and nothing of it is shown.
    response = call("GET", f"/api/want-list?deck={charizard}", stranger)
    assert (response.status_code, response.json()["detail"]["code"]) == (404, "DECK_NOT_FOUND")
    empty = want_list(stranger)
    assert (empty["decks"], empty["sections"], empty["combined"], empty["to_get"]) == ([], [], [], "0")
    assert call("GET", "/api/want-list?deck=not-a-uuid", owner).status_code == 422


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


def test_the_read_is_bounded_by_deck_list_lines_not_the_collection(store, monkeypatch):
    from app import want_list as want_list_module
    from app.games.pokemon.decks import want_list as want_list_route
    found = world(pagers=12)
    listed = found["normal"]
    seed(store, listed, "0.25")
    owner, unsorted = new_owner()
    first, second = deck(owner, "First", 0), deck(owner, "Second", 1)
    line(owner, first, str(listed["id"]), 4)
    line(owner, second, str(listed["id"]), 2)
    hold(owner, unsorted, str(listed["id"]), 1)
    real = want_list_module.connect

    def rows_read():
        seen = []
        monkeypatch.setattr(want_list_module, "connect", lambda: CountingConnection(real(), seen))
        monkeypatch.setattr(want_list_route, "connect", lambda: CountingConnection(real(), seen))
        body = want_list(owner)
        monkeypatch.setattr(want_list_module, "connect", real)
        monkeypatch.setattr(want_list_route, "connect", real)
        return body, sum(seen)

    before, read_before = rows_read()
    # Copies of a dozen Editions no Deck lists, in the same Location: the read neither shows nor reads them.
    for edition in found["pagers"] + [found["unspecified"], found["reverse-holofoil"]]:
        response = add(owner, unsorted, str(edition["id"]), "3")
        assert response.status_code == 200, response.text
    after, read_after = rows_read()
    assert read_after == read_before
    assert {**after, "owner_revision": None} == {**before, "owner_revision": None}


def test_the_read_is_not_a_price_access(store, launches):
    owner, _, gardevoir, _ = iono_world(store)
    want_list(owner)
    want_list(owner, gardevoir)
    # It reads no quote and admits no refresh: the cost of the same scope is #210's price access (ADR 0006).
    assert launches == []


def test_lines_of_one_card_read_collector_numbers_the_way_catalog_search_compares_them():
    from app.core.catalog.card_facts import number_order
    numbers = ["10", "9", "TG05", "9a", "TG1", "097", "SV001", "100", "2", "sv10", "SV9"]
    assert sorted(numbers, key=number_order) == ["2", "9", "9a", "10", "097", "100", "SV001", "SV9", "sv10", "TG1", "TG05"]
    # Zeros after a number's letters don't count: 097 and 97 are one number, and the raw text then breaks the tie.
    assert number_order("TG05")[:3] == number_order("tg5")[:3]
    assert sorted(["97", "097"], key=number_order) == ["097", "97"]
