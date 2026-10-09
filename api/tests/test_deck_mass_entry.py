"""Private Deck TCGplayer Mass Entry export: pure formatter first, then the HTTP contract against PostgreSQL."""
from app.mass_entry_export import (MAX_LINK_QUANTITY, MAX_URL_BYTES, MassEntryInputRow, format_mass_entry,
                                   iter_mass_entry_text, mass_entry_text)

BASE = "https://www.tcgplayer.com/massentry?productline=Pokemon&c="


def row(key, product, quantity=1, name="Furret", printing=None, specificity=None):
    return MassEntryInputRow(key=key, printing_key=printing or f"printing-{key}", display_name=name, quantity=quantity,
                             product_id=product, specificity=specificity)


# ------------------------------------------------------------------ pure formatter


def test_all_rows_mapped_give_the_exact_percent_encoded_link_ordered_by_product_id():
    export = format_mass_entry([row("a", 589955, 4), row("b", 523818, 4, name="Ralts"), row("c", 589954, 1, name="Gardevoir")])
    assert (export.status, export.fallback_reason, export.total_copies) == ("link", None, 9)
    assert export.url == BASE + "4-523818%7C%7C1-589954%7C%7C4-589955"
    assert "|" not in export.url
    assert len(export.lines) == 3


def test_siblings_on_one_product_are_summed_into_one_segment_but_keep_their_own_text_line():
    export = format_mass_entry([row("normal", 77, 2, printing="p1"), row("reverse", 77, 3, printing="p1"),
                                row("other", 9, 1, printing="p2", name="Ralts")])
    assert export.url == BASE + "1-9%7C%7C5-77"
    furret = [line for line in export.lines if line.text.endswith("Furret")]
    assert [(line.quantity, line.keys) for line in furret] == [(5, ("normal", "reverse"))]  # one line per Printing


def test_a_single_product_has_no_separator():
    assert format_mass_entry([row("a", 5, 60)]).url == BASE + "60-5"


def test_one_missing_mapping_gives_complete_text_and_never_a_partial_link():
    export = format_mass_entry([row("a", 5, 2), row("b", None, 1, name="Ralts")])
    assert (export.status, export.url, export.fallback_reason) == ("text", None, "missing_mapping")
    assert [line.text for line in export.lines] == ["2 Furret", "1 Ralts"]
    assert mass_entry_text(export) == "2 Furret\n1 Ralts"


def test_every_text_row_is_name_only_and_labelled_less_specific():
    export = format_mass_entry([row("a", None, 2), row("b", None, 1, name="Ralts", printing="x")])
    assert all(line.less_specific for line in export.lines)
    assert all("[" not in line.text and "http" not in line.text for line in export.lines)


def test_verified_specificity_is_used_and_not_labelled_less_specific_when_present():
    export = format_mass_entry([row("a", None, 2, specificity=("SVI", "123")), row("b", None, 1, name="Ralts")])
    by_text = {line.text: line for line in export.lines}
    assert by_text["2 Furret [SVI] 123"].less_specific is False
    assert by_text["1 Ralts"].less_specific is True


def test_same_name_on_different_printings_stays_as_separate_lines_in_stable_order():
    export = format_mass_entry([row("b", None, 1, printing="p2"), row("a", None, 3, printing="p1")])
    assert [line.text for line in export.lines] == ["3 Furret", "1 Furret"]
    assert [line.keys for line in export.lines] == [("a",), ("b",)]


def test_names_cannot_inject_extra_lines():
    export = format_mass_entry([row("a", None, 1, name="Fur\nret\t\x00 Evil\r\n9 Mew")])
    assert [line.text for line in export.lines] == ["1 Fur ret Evil 9 Mew"]


def test_the_url_byte_boundary_is_inclusive_on_the_exact_href():
    rows = [row(str(i), 1_000_000 + i, 1) for i in range(40)]
    export = format_mass_entry(rows)
    assert export.status == "link" and len(export.url.encode("ascii")) <= MAX_URL_BYTES
    exact = len(export.url.encode("ascii"))
    at_limit = format_mass_entry(rows, max_url_bytes=exact)
    assert (at_limit.status, at_limit.url) == ("link", export.url)
    over = format_mass_entry(rows, max_url_bytes=exact - 1)
    assert (over.status, over.url, over.fallback_reason) == ("text", None, "encoded_length")
    assert len(over.lines) == 40


def test_about_150_products_exceed_the_default_2000_byte_policy():
    rows = [row(str(i), 2_000_000_000 - i, 1) for i in range(150)]
    export = format_mass_entry(rows)
    assert (export.status, export.fallback_reason) == ("text", "encoded_length")
    assert MAX_URL_BYTES == 2000
    candidate = BASE + "%7C%7C".join(f"1-{2_000_000_000 - i}" for i in range(150))
    assert len(candidate.encode("ascii")) > 2000
    assert len(export.lines) == 150


def test_a_quantity_over_the_per_product_link_cap_gives_text_with_the_full_quantity():
    assert MAX_LINK_QUANTITY == 999
    at_cap = format_mass_entry([row("a", 5, 999)])
    assert at_cap.status == "link" and at_cap.url.endswith("999-5")
    summed = format_mass_entry([row("a", 5, 600, printing="p1"), row("b", 5, 400, printing="p2")])  # one product totals 1000
    assert (summed.status, summed.fallback_reason) == ("text", "quantity_unsupported")
    huge = format_mass_entry([row("a", 5, 2**63 - 1, printing="p1"), row("b", 6, 1, printing="p2", name="Ralts")])
    assert huge.fallback_reason == "quantity_unsupported" and huge.total_copies == 2**63
    assert huge.lines[0].text == f"{2**63 - 1} Furret"


def test_missing_mapping_takes_precedence_over_other_reasons():
    export = format_mass_entry([row("a", 5, 5000), row("b", None, 1, name="Ralts")])
    assert export.fallback_reason == "missing_mapping"


def test_no_rows_is_empty():
    export = format_mass_entry([])
    assert (export.status, export.url, export.lines, export.total_copies) == ("empty", None, (), 0)
    assert list(iter_mass_entry_text(export)) == []


def test_streamed_text_equals_the_joined_text():
    export = format_mass_entry([row(str(i), None, i + 1, name=f"Card {i:03}", printing=f"p{i}") for i in range(300)])
    assert "".join(iter_mass_entry_text(export)) == mass_entry_text(export)
    assert mass_entry_text(export).count("\n") == 299 and not mass_entry_text(export).endswith("\n")


# ------------------------------------------------------------------ HTTP contract against PostgreSQL

import threading  # noqa: E402
from concurrent.futures import ThreadPoolExecutor  # noqa: E402
from uuid import uuid4  # noqa: E402

import pytest  # noqa: E402

from app.main import connect  # noqa: E402  (the application module must load before its routers)
from app import deck_mass_entry, public_catalog  # noqa: E402
from test_catalog_metadata import Records  # noqa: E402
from test_catalog_reconciliation import run  # noqa: E402
from test_catalog_targets import card, isolated_rules, metadata  # noqa: E402,F401 (isolated_rules is an autouse fixture)
from test_decks import create  # noqa: E402
from test_holdings import add, call, client  # noqa: E402
from test_metadata_reviews import decide, evidence, seed_users  # noqa: E402


@pytest.fixture(autouse=True)
def no_publication(monkeypatch):
    monkeypatch.setattr(public_catalog, "publish_catalog_best_effort", lambda *a, **k: True)


class World:
    """A catalog of cards, a collector's empty Deck, and helpers that verify mappings the way a maintainer does."""

    def __init__(self, cards, record=None):
        seed_users()
        run(Records(*(record(i) if record else card(i) for i in range(1, cards + 1))))
        self.owner = str(uuid4())
        self.deck = create(self.owner, f"Deck {uuid4()}").json()["location"]["id"]

    def editions(self, number):
        _, editions = metadata(f"meta-{number}")
        return {kind: str(row["id"]) for kind, row in editions.items()}

    def verify(self, edition_id, product):
        """A maintainer `correct` decision: the only way a test establishes a verified product mapping."""
        response = decide(evidence("editions", edition_id), "correct", {"product_id": product, "quote_variant": None})
        assert response.status_code == 200, response.text

    def quarantine(self, edition_id):
        with connect() as conn:
            conn.execute("UPDATE catalog_edition_metadata SET mapping_state='quarantined',mapping_reason='candidate_changed' WHERE edition_id=%s", (edition_id,))

    def put(self, edition_id, quantity):
        assert add(self.owner, self.deck, edition_id, str(quantity)).status_code == 200

    def export(self, user=None):
        return call("GET", f"/api/decks/{self.deck}/exports/tcgplayer", user or self.owner)

    def stream(self, revision, user=None):
        return call("GET", f"/api/decks/{self.deck}/exports/tcgplayer.txt?owner_revision={revision}", user or self.owner)


def lines_of(text):
    """Same-name Printings have no meaningful relative order; compare the set of complete lines."""
    return sorted(text.split("\n"))


def test_all_mapped_rows_give_the_exact_link_from_the_complete_deck_composition():
    world = World(2)
    one, two = world.editions(1)["normal"], world.editions(2)["normal"]
    world.verify(one, 5001)
    world.verify(two, 5002)
    world.put(one, 4)
    world.put(two, 2)
    response = world.export()
    assert response.status_code == 200, response.text
    view = response.json()
    assert (view["status"], view["fallback_reason"], view["total_copies"]) == ("link", None, "6")
    assert view["url"] == BASE + "4-5001%7C%7C2-5002"
    assert view["text"] is None and view["inline"] is True
    assert sorted((line["quantity"], line["text"], line["less_specific"]) for line in view["lines"]) == [
        ("2", "2 Furret", True), ("4", "4 Furret", True)]
    assert isinstance(view["owner_revision"], int) and isinstance(view["catalog_revision"], int)


def test_sibling_editions_on_one_product_are_summed_and_one_printing_is_one_text_line():
    world = World(2)
    editions = world.editions(1)
    world.verify(editions["normal"], 7001)
    world.verify(editions["reverse"], 7001)
    world.verify(world.editions(2)["normal"], 7002)
    world.put(editions["normal"], 2)
    world.put(editions["reverse"], 3)
    world.put(world.editions(2)["normal"], 1)
    view = world.export().json()
    assert view["url"] == BASE + "5-7001%7C%7C1-7002"
    assert sorted(line["text"] for line in view["lines"]) == ["1 Furret", "5 Furret"]  # same name, different Printings


@pytest.mark.parametrize("how", ["unverified", "quarantined", "unspecified"])
def test_any_row_without_a_verified_mapping_gives_complete_less_specific_text_and_no_link(how):
    def unspecified_second(number):
        record = card(number)
        if number == 2:
            record["variants_detailed"], record["variants"] = [], {}
        return record

    world = World(2, unspecified_second if how == "unspecified" else None)
    first = world.editions(1)["normal"]
    second = next(iter(world.editions(2).values())) if how == "unspecified" else world.editions(2)["normal"]
    world.verify(first, 5001)
    if how == "quarantined":
        world.verify(second, 5002)
        world.quarantine(second)
    world.put(first, 3)
    world.put(second, 1)
    view = world.export().json()
    assert (view["status"], view["url"], view["fallback_reason"]) == ("text", None, "missing_mapping")
    assert lines_of(view["text"]) == ["1 Furret", "3 Furret"] and view["total_copies"] == "4"
    assert all(line["less_specific"] for line in view["lines"])
    assert "[" not in view["text"] and "http" not in view["text"]


def test_an_overlong_link_falls_back_to_complete_text(monkeypatch):
    world = World(3)
    for number in (1, 2, 3):
        edition = world.editions(number)["normal"]
        world.verify(edition, 2_000_000_000 + number)
        world.put(edition, 1)
    full = world.export().json()
    length = len(full["url"].encode("ascii"))
    assert full["status"] == "link" and length <= 2000
    monkeypatch.setattr(deck_mass_entry, "MAX_URL_BYTES", length)
    assert world.export().json()["status"] == "link"  # exactly at the limit is allowed
    monkeypatch.setattr(deck_mass_entry, "MAX_URL_BYTES", length - 1)
    view = world.export().json()
    assert (view["status"], view["url"], view["fallback_reason"]) == ("text", None, "encoded_length")
    assert view["text"] == "1 Furret\n1 Furret\n1 Furret"


def test_a_quantity_over_the_link_cap_gives_text_with_every_copy_counted():
    world = World(2)
    big, small = world.editions(1)["normal"], world.editions(2)["normal"]
    world.verify(big, 5001)
    world.verify(small, 5002)
    world.put(big, 999)
    world.put(small, 1)
    assert world.export().json()["status"] == "link"
    world.put(big, 1)  # 1000 copies of one product
    view = world.export().json()
    assert (view["status"], view["fallback_reason"], view["total_copies"]) == ("text", "quantity_unsupported", "1001")
    assert lines_of(view["text"]) == ["1 Furret", "1000 Furret"]


def test_totals_beyond_int64_are_exact_strings():
    world = World(2)
    world.put(world.editions(1)["normal"], 2**63 - 1)
    world.put(world.editions(2)["normal"], 1)
    view = world.export().json()
    assert view["total_copies"] == str(2**63)
    assert lines_of(view["text"]) == ["1 Furret", f"{2**63 - 1} Furret"]


def test_empty_deck_is_empty_and_cannot_be_streamed():
    world = World(1)
    view = world.export().json()
    assert (view["status"], view["url"], view["text"], view["lines"], view["total_copies"]) == ("empty", None, None, [], "0")
    denied = world.stream(view["owner_revision"])
    assert (denied.status_code, denied.json()["detail"]["code"]) == (422, "DECK_EMPTY")


def test_a_non_60_deck_exports_without_legality_claims():
    world = World(1)
    edition = world.editions(1)["normal"]
    world.verify(edition, 5001)
    world.put(edition, 59)
    view = world.export().json()
    assert (view["status"], view["url"], view["total_copies"]) == ("link", BASE + "59-5001", "59")
    assert not {"legal", "valid", "price", "checkout", "cart", "total_price"} & set(view)


def test_every_page_of_a_large_deck_is_exported_not_just_the_first():
    world = World(51)
    for number in range(1, 52):
        world.put(world.editions(number)["normal"], 1)
    first_page = call("GET", f"/api/holdings/{world.deck}", world.owner).json()
    assert len(first_page["holdings"]) == 48 and first_page["next_cursor"]
    view = world.export().json()
    assert (view["status"], view["total_copies"], len(view["lines"])) == ("text", "51", 51)
    assert view["text"].count("\n") == 50


def test_stream_matches_the_inline_text_and_is_an_attachment():
    world = World(3)
    world.put(world.editions(1)["normal"], 2)
    world.put(world.editions(2)["normal"], 1)
    view = world.export().json()
    response = world.stream(view["owner_revision"])
    assert response.status_code == 200
    assert response.text == view["text"] and lines_of(response.text) == ["1 Furret", "2 Furret"]
    assert response.headers["content-type"].startswith("text/plain")
    assert "attachment" in response.headers["content-disposition"] and ".txt" in response.headers["content-disposition"]
    assert response.headers["cache-control"] == "no-store" and response.headers["x-content-type-options"] == "nosniff"
    assert view["byte_length"] == len(response.content)


def test_output_beyond_the_inline_limit_is_never_inlined_or_truncated(monkeypatch):
    world = World(3)
    for number in (1, 2, 3):
        world.put(world.editions(number)["normal"], number)
    monkeypatch.setattr(deck_mass_entry, "INLINE_LIMIT_BYTES", 10)
    view = world.export().json()
    expected = "1 Furret\n2 Furret\n3 Furret"  # same length whatever the order of same-name Printings
    assert (view["status"], view["inline"], view["text"], view["lines"], view["byte_length"]) == ("text", False, None, [], len(expected))
    assert view["line_count"] == 3 and view["less_specific_count"] == 3
    assert lines_of(world.stream(view["owner_revision"]).text) == lines_of(expected)


def test_a_stale_revision_cannot_download():
    world = World(1)
    edition = world.editions(1)["normal"]
    world.put(edition, 1)
    revision = world.export().json()["owner_revision"]
    world.put(edition, 1)
    stale = world.stream(revision)
    assert (stale.status_code, stale.json()["detail"]["code"]) == (409, "INVENTORY_CHANGED")
    assert world.stream(world.export().json()["owner_revision"]).status_code == 200
    assert world.stream("x").status_code == 422


def test_concurrent_inventory_changes_always_yield_one_consistent_revision():
    world = World(1)
    edition = world.editions(1)["normal"]
    world.put(edition, 1)
    base = world.export().json()
    stop = threading.Event()

    def writer():
        while not stop.is_set():
            world.put(edition, 1)

    with ThreadPoolExecutor(1) as pool:
        future = pool.submit(writer)
        try:
            views = [world.export().json() for _ in range(15)]
        finally:
            stop.set()
            future.result()
    for view in views:  # every add moves revision and total by one, so a torn read would break the difference
        assert int(view["total_copies"]) - view["owner_revision"] == int(base["total_copies"]) - base["owner_revision"]
        assert view["text"] == f"{view['total_copies']} Furret"


def test_exports_are_private_and_authenticated():
    world = World(1)
    world.put(world.editions(1)["normal"], 1)
    other = str(uuid4())
    for response in (world.export(other), world.stream(1, other)):
        assert (response.status_code, response.json()["detail"]["code"]) == (404, "DECK_NOT_FOUND")
    assert call("GET", f"/api/decks/{uuid4()}/exports/tcgplayer", world.owner).status_code == 404
    assert client.get(f"/api/decks/{world.deck}/exports/tcgplayer").status_code in (401, 403)
