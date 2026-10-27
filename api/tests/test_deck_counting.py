"""Deck figures follow the Want List counting setting (decklist import #208): signed HTTP against PostgreSQL.

A Deck's need is one number on every route that shows it: the Deck detail's ``to_get``, the cost to complete
(``GET /api/decks/{id}/cost``, which each Decks index row reads) and Buy missing (the Mass Entry ``not_owned`` scope).
Under **Every Deck built at once** (the default) each Deck counts the copies it holds for its line, then Spare Copies go
to Decks oldest first, by creation time with the Deck id breaking ties. Under **One Deck at a time** every copy outside
the Deck counts, as before #208. Gather (the Pick List) and the Deck detail's ownership split never follow the setting.

Every test starts a new owner, so no setting leaks between tests; Deck creation times are set explicitly wherever the
order matters.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from app.main import connect  # noqa: F401
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import body_of, cost, launches, store  # noqa: F401  (store and launches are autouse fixtures)
from test_decks import create
from test_holdings import add, call
from test_prices import seed, world
from test_settings import change, read

EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)


def new_owner():
    """A new owner and the id of its Unsorted, created by its first read."""
    owner = f"counting-{uuid4()}"
    tree = call("GET", "/api/location-tree", owner)
    assert tree.status_code == 200, tree.text
    return owner, next(location["id"] for location in tree.json()["locations"] if location["name"] == "Unsorted")


def deck(owner, name, created_days):
    """A Deck created through the route, then dated ``created_days`` after EPOCH."""
    response = create(owner, f"{name} {uuid4()}")
    assert response.status_code == 201, response.text
    deck_id = response.json()["location"]["id"]
    created(owner, deck_id, EPOCH + timedelta(days=created_days))
    return deck_id


def created(owner, deck_id, when):
    with connect() as conn:
        conn.execute("UPDATE location SET created_at=%s WHERE owner_id=%s AND id=%s", (when, owner, deck_id))


def hold(owner, location, edition, quantity):
    response = add(owner, location, edition, str(quantity))
    assert response.status_code == 200, response.text


def line(owner, deck_id, edition, quantity):
    """Sets one Deck List line to ``quantity`` (0 removes it) through the batch route."""
    revision = detail(owner, deck_id)["deck_list"]["revision"]
    response = call("POST", f"/api/decks/{deck_id}/deck-list/changes", owner,
                    {"revision": revision, "idempotency_key": str(uuid4()),
                     "changes": [{"edition_id": edition, "quantity": str(quantity)}]})
    assert response.status_code == 200, response.text


def counting(owner, value):
    response = change(owner, value, read(owner)["revision"])
    assert response.status_code == 200, response.text


def detail(owner, deck_id):
    response = call("GET", f"/api/decks/{deck_id}", owner)
    assert response.status_code == 200, response.text
    return response.json()


def buy_missing(owner, deck_id):
    response = call("GET", f"/api/decks/{deck_id}/exports/tcgplayer?scope=not_owned", owner)
    assert response.status_code == 200, response.text
    return response.json()


def need(owner, deck_id):
    """The Deck's need on every route, asserted equal, with the setting each names; returns the one number."""
    shown = detail(owner, deck_id)
    priced = body_of(cost(deck_id, user=owner))
    bought = buy_missing(owner, deck_id)
    setting = read(owner)["want_list_counting"]
    assert shown["want_list_counting"] == priced["want_list_counting"] == bought["want_list_counting"] == setting
    assert shown["settings_revision"] == priced["settings_revision"] == bought["settings_revision"]
    assert shown["to_get"] == priced["cost_to_complete"]["total_copies"] == bought["total_copies"], (shown, priced, bought)
    return shown["to_get"]


def iono_world(store):
    """The spec's worked example on one Edition, Iono PAL 185: Charizard ex (older) lists 4 and holds 1, Gardevoir ex
    (newer) lists 2 and holds none, and one loose copy sits in Unsorted. Returns (owner, charizard, gardevoir, edition)."""
    iono = world()["normal"]
    seed(store, iono, "0.25")
    edition = str(iono["id"])
    owner, unsorted = new_owner()
    charizard = deck(owner, "Charizard ex", 0)
    gardevoir = deck(owner, "Gardevoir ex", 1)
    hold(owner, charizard, edition, 1)   # moving a copy in lists it (migration 031)
    line(owner, charizard, edition, 4)
    line(owner, gardevoir, edition, 2)
    hold(owner, unsorted, edition, 1)
    return owner, charizard, gardevoir, edition


def test_the_worked_iono_example_holds_on_every_route_under_both_settings(store):
    owner, charizard, gardevoir, _ = iono_world(store)
    assert read(owner)["want_list_counting"] == "all_at_once"
    # Every Deck built at once: Charizard ex takes the loose spare and needs 2; Charizard ex's own copy never counts for
    # Gardevoir ex, which needs 2. The total is 4.
    assert (need(owner, charizard), need(owner, gardevoir)) == ("2", "2")
    complete = body_of(cost(gardevoir, user=owner))["cost_to_complete"]
    assert (complete["status"], complete["amount"], complete["priced_copies"]) == ("priced", "0.5", "2")
    # One Deck at a time, on the next read: Gardevoir ex counts Charizard ex's copy and the loose one.
    counting(owner, "one_at_a_time")
    assert (need(owner, charizard), need(owner, gardevoir)) == ("2", "0")
    assert body_of(cost(gardevoir, user=owner))["cost_to_complete"]["status"] == "empty"
    assert buy_missing(owner, gardevoir)["status"] == "empty"
    # And back.
    counting(owner, "all_at_once")
    assert (need(owner, charizard), need(owner, gardevoir)) == ("2", "2")


def test_one_deck_at_a_time_is_the_figure_before_the_setting(store):
    owner, charizard, gardevoir, _ = iono_world(store)
    counting(owner, "one_at_a_time")
    for deck_id in (charizard, gardevoir):
        shown = detail(owner, deck_id)
        # The Deck detail's not-owned copies are the reading every Deck route used before #208.
        assert need(owner, deck_id) == str(sum(int(entry["not_owned"]) for entry in shown["ownership"]))


def test_spare_copies_go_to_the_oldest_deck_first_with_the_deck_id_breaking_a_tie(store):
    edition = world()["normal"]
    seed(store, edition, "0.25")
    edition = str(edition["id"])
    owner, unsorted = new_owner()
    first, second = deck(owner, "First", 0), deck(owner, "Second", 0)
    low, high = sorted((first, second), key=UUID)
    for deck_id in (low, high):
        line(owner, deck_id, edition, 1)
    hold(owner, unsorted, edition, 1)
    # Creation time decides, even against the Deck id: the Deck with the higher id is older and takes the spare.
    created(owner, high, EPOCH)
    created(owner, low, EPOCH + timedelta(seconds=1))
    assert (need(owner, high), need(owner, low)) == ("0", "1")
    # Created at the same moment (one transaction's now()), the lower Deck id goes first.
    created(owner, low, EPOCH)
    assert (need(owner, low), need(owner, high)) == ("0", "1")
    # One Deck at a time ignores the order: each Deck counts the loose copy.
    counting(owner, "one_at_a_time")
    assert (need(owner, low), need(owner, high)) == ("0", "0")


def test_a_decks_surplus_is_spare_but_the_copies_it_holds_for_its_line_are_not(store):
    edition = world()["normal"]
    seed(store, edition, "0.25")
    edition = str(edition["id"])
    owner, _ = new_owner()
    keeper = deck(owner, "Keeper", 0)     # lists 2, holds 2: none spare
    extra = deck(owner, "Extra", 1)       # lists 1, holds 3: 2 Surplus copies, spare
    cut = deck(owner, "Cut", 2)           # holds 1 with no line: spare
    wanting = deck(owner, "Wanting", 3)   # lists 4, holds none
    hold(owner, keeper, edition, 2)
    hold(owner, extra, edition, 3)
    line(owner, extra, edition, 1)
    hold(owner, cut, edition, 1)
    line(owner, cut, edition, 0)
    line(owner, wanting, edition, 4)
    # Every Deck built at once: Wanting counts Extra's 2 Surplus copies and Cut's 1, never Keeper's 2.
    assert [need(owner, deck_id) for deck_id in (keeper, extra, cut, wanting)] == ["0", "0", "0", "1"]
    # One Deck at a time: Keeper's copies count too.
    counting(owner, "one_at_a_time")
    assert need(owner, wanting) == "0"


def test_gather_and_the_ownership_split_do_not_follow_the_setting(store):
    owner, charizard, gardevoir, _ = iono_world(store)
    before = {deck_id: (call("GET", f"/api/decks/{deck_id}/pick-list", owner), detail(owner, deck_id))
              for deck_id in (charizard, gardevoir)}
    counting(owner, "one_at_a_time")
    for deck_id, (picks, shown) in before.items():
        assert picks.status_code == 200, picks.text
        after = call("GET", f"/api/decks/{deck_id}/pick-list", owner)
        assert after.json() == picks.json()
        now = detail(owner, deck_id)
        for key in ("ownership", "surplus", "competition", "owner_revision", "deck_list"):
            assert now[key] == shown[key], key
    # Gardevoir ex's Gather still offers Charizard ex's copy and the loose one, whatever Buy missing counts.
    rows = before[gardevoir][0].json()["rows"]
    assert [(row["quantity"], row["elsewhere"]) for row in rows] == [("2", "2")]


def test_the_decks_index_is_unchanged_by_the_setting_and_each_row_costs_the_same_need(store):
    owner, charizard, gardevoir, _ = iono_world(store)
    index = call("GET", "/api/decks", owner).json()
    assert {entry["id"] for entry in index["decks"]} == {charizard, gardevoir}
    counting(owner, "one_at_a_time")
    # The index read itself carries nothing the setting changes, so its cursors, keyed on the inventory revision, stay
    # valid; each row's "to complete" is its cost read, which follows the setting like every other route.
    assert call("GET", "/api/decks", owner).json() == index
    for entry in index["decks"]:
        assert body_of(cost(entry["id"], user=owner))["cost_to_complete"]["total_copies"] == need(owner, entry["id"])


def test_a_download_prepared_under_another_setting_is_refused(store):
    owner, charizard, gardevoir, _ = iono_world(store)
    view = buy_missing(owner, gardevoir)
    assert (view["total_copies"], view["want_list_counting"]) == ("2", "all_at_once")
    query = f"owner_revision={view['owner_revision']}&scope=not_owned"
    pinned = f"/api/decks/{gardevoir}/exports/tcgplayer.txt?{query}&settings_revision={view['settings_revision']}"
    assert call("GET", pinned, owner).status_code == 200
    counting(owner, "one_at_a_time")
    stale = call("GET", pinned, owner)
    assert (stale.status_code, stale.json()["detail"]["code"]) == (409, "SETTINGS_CHANGED")
    # The whole Deck List doesn't follow the setting, and a download that names no settings revision is unchanged.
    whole = call("GET", f"/api/decks/{gardevoir}/exports/tcgplayer.txt?owner_revision={view['owner_revision']}"
                        f"&scope=deck_list&settings_revision={view['settings_revision']}", owner)
    assert whole.status_code == 200
    current = buy_missing(owner, charizard)
    fresh = call("GET", f"/api/decks/{charizard}/exports/tcgplayer.txt?owner_revision={current['owner_revision']}"
                        f"&scope=not_owned&settings_revision={current['settings_revision']}", owner)
    assert fresh.status_code == 200 and fresh.text.split(" ", 1)[0] == "2"


def test_every_answer_belongs_to_the_setting_it_names(store):
    owner, _, gardevoir, _ = iono_world(store)
    expected = {"all_at_once": "2", "one_at_a_time": "0"}

    def flip():
        for value in ["one_at_a_time", "all_at_once"] * 5:
            counting(owner, value)

    def figures():
        seen = []
        for _ in range(10):
            bought = buy_missing(owner, gardevoir)
            shown = detail(owner, gardevoir)
            seen.append((bought["want_list_counting"], bought["total_copies"]))
            seen.append((shown["want_list_counting"], shown["to_get"]))
        return seen

    with ThreadPoolExecutor(max_workers=3) as pool:
        flips = pool.submit(flip)
        reads = [pool.submit(figures) for _ in range(2)]
        flips.result()
        answers = [answer for future in reads for answer in future.result()]
    assert answers and all(total == expected[setting] for setting, total in answers), answers
