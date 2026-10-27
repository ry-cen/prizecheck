"""Deck -> Pokemon TCG Live export: pure formatter first, then signed HTTP against PostgreSQL."""
from app.live_export import LiveInputRow, format_live, iter_live_text, live_text


def ident(category, name, set_code, number):
    return {"category": category, "name": name, "set_code": set_code, "number": number}


def row(key, identity, quantity, state="eligible", reason=None, name=None, set_label="Set", number="1", descriptor=None):
    return LiveInputRow(key=key, display_name=name or (identity or {}).get("name", "Card"), set_label=set_label,
                        collector_number=number, descriptor=descriptor or {"label": "Unspecified Variant"},
                        quantity=quantity, state=state, reason=reason, identity=identity)


def test_exact_text_orders_categories_and_rows_and_omits_footer_and_trailing_newline():
    export = format_live([
        row("a", ident("Energy", "Metal Energy", "SVE", "8"), 3),
        row("b", ident("Trainer", "Ultra Ball", "SVI", "196"), 1),
        row("c", ident("Pokemon", "Gholdengo ex", "PAR", "139"), 4),
        row("d", ident("Pokemon", "Gimmighoul", "SSP", "97"), 4),
        row("e", ident("Trainer", "arven", "OBF", "186"), 4),
        row("f", ident("Energy", "Darkness Energy", "SVE", "7"), 2),
    ])
    assert export.status == "ok" and export.blockers == () and export.total_copies == 18
    assert live_text(export) == (
        "Pokémon: 8\n4 Gholdengo ex PAR 139\n4 Gimmighoul SSP 97\n\n"
        "Trainer: 5\n4 arven OBF 186\n1 Ultra Ball SVI 196\n\n"
        "Energy: 5\n2 Darkness Energy SVE 7\n3 Metal Energy SVE 8")
    assert live_text(export) == "".join(iter_live_text(export))
    assert [(g.category, g.quantity) for g in export.groups] == [("Pokemon", 8), ("Trainer", 5), ("Energy", 5)]


def test_empty_categories_are_omitted_and_ties_sort_by_set_then_number():
    export = format_live([row("a", ident("Energy", "Fire Energy", "SVE", "2"), 1),
                          row("b", ident("Energy", "Fire Energy", "MEE", "12"), 2),
                          row("c", ident("Energy", "Fire Energy", "MEE", "10"), 3)])
    assert live_text(export) == "Energy: 6\n3 Fire Energy MEE 10\n2 Fire Energy MEE 12\n1 Fire Energy SVE 2"


def test_only_identical_identities_merge_and_names_alone_never_do():
    same = ident("Pokemon", "Pikachu", "BS", "58")
    export = format_live([row("a", same, 2), row("b", dict(same), 3),
                          row("c", ident("Pokemon", "Pikachu", "SVI", "63"), 1)])
    assert live_text(export) == "Pokémon: 6\n5 Pikachu BS 58\n1 Pikachu SVI 63"


def test_blocked_export_lists_every_blocker_and_no_groups_or_text():
    export = format_live([
        row("ok", ident("Pokemon", "Pikachu", "BS", "58"), 1),
        row("s", None, 2, state="suspended", reason="source_changed", name="Furret", number="136"),
        row("u", None, 3, state="unsupported", reason="rule_uncovered", name="Alt Art"),
        row("m", None, 1, state="unsupported", reason=None, name="Mystery"),
    ])
    assert export.status == "blocked" and export.groups == ()
    assert {b.key: (b.reason, b.quantity) for b in export.blockers} == {
        "s": ("source_changed", 2), "u": ("rule_uncovered", 3), "m": ("unsupported", 1)}
    assert [b.display_name for b in export.blockers] == ["Alt Art", "Furret", "Mystery"]
    assert export.total_copies == 7
    assert list(iter_live_text(export)) == [] and live_text(export) == ""


def test_control_characters_and_unknown_categories_block_as_invalid_input():
    export = format_live([row("a", ident("Pokemon", "Bad\nName", "BS", "1"), 1),
                          row("b", ident("Pokemon", "Tab\tName", "BS", "2"), 1),
                          row("c", ident("Trainer", "Fine", "BS", "3"), 1),
                          row("d", ident("Stadium", "Odd", "BS", "4"), 1),
                          row("e", ident("Pokemon", "Sep arator", "BS", "5"), 1)])
    assert export.status == "blocked"
    assert {b.key: b.reason for b in export.blockers} == {k: "invalid_input" for k in "abde"}


def test_empty_and_huge_quantities_are_exact_integers():
    assert format_live([]).status == "empty" and live_text(format_live([])) == ""
    big = 2**63 - 1
    export = format_live([row("a", ident("Pokemon", "Pikachu", "BS", "58"), big),
                          row("b", ident("Pokemon", "Pikachu", "BS", "58"), 1)])
    assert export.total_copies == 2**63 and export.groups[0].quantity == 2**63
    assert live_text(export) == f"Pokémon: {2**63}\n{2**63} Pikachu BS 58"


# ------------------------------------------------------------------ HTTP against PostgreSQL
import json  # noqa: E402
import threading  # noqa: E402
from uuid import uuid4  # noqa: E402

import pytest  # noqa: E402

from app.main import connect  # noqa: E402
from app import deck_live_export  # noqa: E402
from app.catalog_targets import LIVE, LIVE_RULES, LiveRulesV1, TargetContext, activate_rule, fingerprint, refresh_printing  # noqa: E402
from app.main import connect  # noqa: E402
from test_catalog import reset_catalog  # noqa: E402
from test_catalog_metadata import Records, furret  # noqa: E402
from test_catalog_reconciliation import run  # noqa: E402
from test_catalog_targets import InjectedLive, activate  # noqa: E402
from test_decks import create  # noqa: E402
from test_holdings import add, call, client  # noqa: E402


@pytest.fixture(autouse=True)
def isolated_rules(monkeypatch):
    monkeypatch.setitem(LIVE_RULES, 99, InjectedLive)
    yield
    with connect() as conn:
        conn.execute("UPDATE catalog_rule_state SET activation_id=NULL")


def seed_world(cards, bulk=False):
    """Seed Printings/Editions by SQL and give them reviewed Live state through the shipped v1 path.

    A card is {key, name, number, category, set_id?, set_name?, source ('tcgdex'|'manual')?, finishes?: [descriptor],
    live?: {name,set_code,number} | 'suspended', tombstoned?}. Eligibility is a maintainer `correct` decision under the
    shipped (empty-table) rule v1; `bulk` writes rule-basis rows directly so large worlds stay fast.
    Returns ({key: {'printing': id, 'editions': [ids]}}, reviewer id).
    """
    reset_catalog()
    reviewer = f"owner-{uuid4()}"
    world = {}
    with connect() as conn:
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s)", (reviewer,))
        conn.execute("INSERT INTO owner_binding(singleton,user_id) VALUES (true,%s)", (reviewer,))
        generation = uuid4()
        conn.execute("INSERT INTO catalog_generation(id,source_count,raw_gzip,raw_sha256) VALUES (%s,1,%s,'test')", (generation, b"test"))
        for card in cards:
            identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES (%s,%s) RETURNING id",
                                    (str(uuid4()), card["name"])).fetchone()["id"]
            manual = card.get("source") == "manual"
            printing = conn.execute("INSERT INTO catalog_printing(source,source_id,identity_id) VALUES (%s,%s,%s) RETURNING id",
                                    ("manual" if manual else "tcgdex", None if manual else f"seed-{card['key']}", identity)).fetchone()["id"]
            conn.execute("""INSERT INTO catalog_generation_printing(generation_id,printing_id,source_id,set_id,set_name,collector_number,
              display_name,search_name,source_fingerprint,basic_energy,tombstoned)
              VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'seed','not_basic',%s)""",
                         (generation, printing, f"seed-{card['key']}", card.get("set_id", "seed"), card.get("set_name", "Seed Set"),
                          card["number"], card["name"], card["name"].lower(), bool(card.get("tombstoned"))))
            editions = []
            for index, descriptor in enumerate(card.get("finishes") or [{"label": "Unspecified Variant"}]):
                edition = conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES (%s,%s,%s) RETURNING id",
                                       (printing, f"k{index}", json.dumps(descriptor))).fetchone()["id"]
                conn.execute("INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id) VALUES (%s,%s,%s)",
                             (generation, edition, printing))
                editions.append(str(edition))
            world[card["key"]] = {"printing": str(printing), "editions": editions}
        conn.execute("UPDATE catalog_state SET active_generation=%s,revision=revision+1 WHERE singleton", (generation,))
    eligible = [card for card in cards if card.get("live")]
    if eligible:
        with connect() as conn, conn.transaction():
            activate_rule(conn, LIVE, 1, reviewer, "https://example.org/rule", "Reviewed against the target")
        for card in eligible:
            (bulk_eligible if bulk else decide_live)(world[card["key"]]["printing"], reviewer, card)
    return world, reviewer


def bulk_eligible(printing_id, reviewer, card):
    with connect() as conn, conn.transaction():
        activation = conn.execute("SELECT activation_id FROM catalog_rule_state WHERE kind='live_derivation'").fetchone()["activation_id"]
        conn.execute("""UPDATE catalog_printing_metadata SET live_state='eligible',live_reason=NULL,live_identity=%s,live_basis='rule',
          live_activation_id=%s,live_auto_closed=true WHERE printing_id=%s""",
                     (json.dumps({"category": card["category"], "name": card["live"]["name"],
                                  "set_code": card["live"]["set_code"], "number": card["live"]["number"]}), activation, printing_id))


def decide_live(printing_id, reviewer, card):
    """A maintainer `correct` decision with complete inputs (the metadata-review path), then optionally a suspension."""
    suspended = card["live"] == "suspended"
    inputs = {"category": card["category"], "name": card["name"] if suspended else card["live"]["name"],
              "set_code": "ZZZ" if suspended else card["live"]["set_code"],
              "collector_number": card["number"] if suspended else card["live"]["number"]}
    with connect() as conn, conn.transaction():
        revision = conn.execute("SELECT catalog_begin_correction() AS r").fetchone()["r"]
        decision = conn.execute("""INSERT INTO catalog_metadata_decision(target,printing_id,decision,reviewed_value,source_fingerprint,
          basis_revision,evidence_url,reason,reviewer_id,clock_revision)
          VALUES ('live',%s,'correct',%s,%s,1,'https://example.org/e','Checked the card',%s,%s) RETURNING id""",
                                (printing_id, json.dumps(inputs), fingerprint(inputs), reviewer, revision)).fetchone()["id"]
        conn.execute("UPDATE catalog_printing_metadata SET live_inputs=%s,live_decision_id=%s WHERE printing_id=%s",
                     (json.dumps(inputs), decision, printing_id))
        refresh_printing(conn, TargetContext(conn), printing_id, reviewed=True)
        if suspended:  # an eligible Printing whose source later changed
            conn.execute("""UPDATE catalog_printing_metadata SET live_state='suspended',live_reason='source_changed',live_identity=NULL,
              live_claim=NULL WHERE printing_id=%s""", (printing_id,))


def live(name, set_code, number):
    return {"name": name, "set_code": set_code, "number": number}


def put(owner, deck, edition, quantity):
    """Insert a Holding directly (fast for large Decks) and bump the owner's revision."""
    with connect() as conn, conn.transaction():
        conn.execute("INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,%s,1)",
                     (owner, deck, edition, quantity))
        conn.execute("UPDATE inventory_owner SET revision=revision+1 WHERE user_id=%s", (owner,))


def make_deck(cards, quantities, bulk=False):
    world, _ = seed_world(cards, bulk=bulk)
    owner = str(uuid4())
    with connect() as conn:
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s)", (owner,))
    deck = create(owner).json()["location"]["id"]
    for (key, index), quantity in quantities.items():
        put(owner, deck, world[key]["editions"][index], quantity)
    return owner, deck, world


def view(owner, deck):
    return call("GET", f"/api/decks/{deck}/exports/live", owner)


def stream(owner, deck, revision, deck_list_revision=None):
    pinned = "" if deck_list_revision is None else f"&deck_list_revision={deck_list_revision}"
    return call("GET", f"/api/decks/{deck}/exports/live.txt?owner_revision={revision}{pinned}", owner)


def deck_list_revision(owner, deck):
    response = call("GET", f"/api/decks/{deck}", owner)
    assert response.status_code == 200, response.text
    return response.json()["deck_list"]["revision"]


def line(owner, deck, edition, quantity=None):
    """Add a Deck List line, change its quantity, or (``quantity=None``) remove it, through the Deck List routes."""
    revision = deck_list_revision(owner, deck)
    key = str(uuid4())
    if quantity is None:
        response = call("DELETE", f"/api/decks/{deck}/deck-list/lines/{edition}", owner, {"revision": revision, "idempotency_key": key})
    else:
        listed = any(entry["edition_id"] == edition for entry in call("GET", f"/api/decks/{deck}", owner).json()["deck_list"]["lines"])
        response = call("PATCH", f"/api/decks/{deck}/deck-list/lines/{edition}", owner,
                        {"quantity": quantity, "revision": revision, "idempotency_key": key}) if listed else call(
            "POST", f"/api/decks/{deck}/deck-list/lines", owner,
            {"edition_id": edition, "quantity": quantity, "revision": revision, "idempotency_key": key})
    assert response.status_code == 200, response.text


def binder(owner):
    """Another Storage Leaf of the owner: copies held there are elsewhere, not in the Deck."""
    with connect() as conn:
        return conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Binder','storage_leaf') RETURNING id",
                            (uuid4(), owner)).fetchone()["id"]


MIXED = [
    {"key": "mon", "name": "Gholdengo ex", "number": "139", "category": "Pokemon", "live": live("Gholdengo ex", "PAR", "139"),
     "finishes": [{"finish": "normal"}, {"finish": "reverse"}]},
    {"key": "promo", "name": "Gholdengo ex", "number": "SV01", "category": "Pokemon", "live": live("Gholdengo ex", "SVP", "SV01")},
    {"key": "trainer", "name": "Ultra Ball", "number": "196", "category": "Trainer", "live": live("Ultra Ball", "SVI", "196")},
    {"key": "special", "name": "Double Turbo Energy", "number": "151", "category": "Energy", "live": live("Double Turbo Energy", "MEW", "151")},
    {"key": "basic", "name": "Metal Energy", "number": "8", "category": "Energy", "live": live("Metal Energy", "SVE", "8")},
    {"key": "subset", "name": "Mew", "number": "GG10", "category": "Pokemon", "live": live("Mew", "CRZ-GG", "GG10")},
    {"key": "manual", "name": "Manual Pikachu", "number": "1", "category": "Pokemon", "source": "manual", "live": live("Manual Pikachu", "FUT", "1")},
    {"key": "retired", "name": "Old Pikachu", "number": "58", "category": "Pokemon", "tombstoned": True, "live": live("Old Pikachu", "BS", "58")},
]
BIG = 9007199254740993
EXPECTED_MIXED = (
    "Pokémon: 7\n3 Gholdengo ex PAR 139\n1 Gholdengo ex SVP SV01\n1 Manual Pikachu FUT 1\n1 Mew CRZ-GG GG10\n1 Old Pikachu BS 58\n\n"
    "Trainer: 4\n4 Ultra Ball SVI 196\n\n"
    f"Energy: {BIG + 2}\n2 Double Turbo Energy MEW 151\n{BIG} Metal Energy SVE 8")


def test_complete_text_covers_every_claimed_rule_case_and_groups_by_identity_only():
    quantities = {("mon", 0): "2", ("mon", 1): "1", ("promo", 0): "1", ("trainer", 0): "4", ("special", 0): "2", ("basic", 0): str(BIG),
                  ("subset", 0): "1", ("manual", 0): "1", ("retired", 0): "1"}
    owner, deck, world = make_deck(MIXED, quantities)
    # A marketplace quarantine of an Edition must not block the Live export.
    with connect() as conn:
        conn.execute("""UPDATE catalog_edition_metadata SET mapping_state='quarantined',mapping_reason='candidate_changed',auto_closed=true
          WHERE edition_id=%s""", (world["mon"]["editions"][0],))
    response = view(owner, deck)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ok" and body["blockers"] == [] and body["inline"] is True
    assert body["text"] == EXPECTED_MIXED
    assert body["byte_length"] == len(EXPECTED_MIXED.encode()) and body["total_copies"] == str(BIG + 13)
    assert body["owner_revision"] and body["catalog_revision"]
    assert body["deck_list_revision"] == deck_list_revision(owner, deck)
    streamed = stream(owner, deck, body["owner_revision"])
    assert streamed.status_code == 200 and streamed.text == EXPECTED_MIXED
    assert "charset=utf-8" in streamed.headers["content-type"] and streamed.headers["content-type"].startswith("text/plain")
    assert streamed.headers["content-disposition"].startswith("attachment") and streamed.headers["cache-control"] == "no-store"


def test_same_name_printings_stay_separate_and_editions_of_one_printing_merge():
    owner, deck, _ = make_deck(MIXED[:2], {("mon", 0): "1", ("mon", 1): "2", ("promo", 0): "1"})
    assert view(owner, deck).json()["text"] == "Pokémon: 4\n3 Gholdengo ex PAR 139\n1 Gholdengo ex SVP SV01"


def test_unspecified_edition_is_exportable_through_its_printing():
    owner, deck, world = make_deck(MIXED, {("trainer", 0): "1"})
    with connect() as conn:
        assert conn.execute("SELECT descriptor FROM catalog_edition WHERE id=%s", (world["trainer"]["editions"][0],)).fetchone()["descriptor"] == {
            "label": "Unspecified Variant"}
    assert view(owner, deck).json()["text"] == "Trainer: 1\n1 Ultra Ball SVI 196"


def test_blocked_deck_lists_every_blocker_and_withholds_all_text():
    cards = MIXED[:3] + [
        {"key": "alt", "name": "Alt Art Card", "number": "TG01", "category": "Pokemon", "set_name": "Trainer Gallery"},
        {"key": "sus", "name": "Furret", "number": "136", "category": "Pokemon", "live": "suspended"},
    ]
    owner, deck, world = make_deck(cards, {("mon", 0): "1", ("alt", 0): "2", ("sus", 0): "3", ("trainer", 0): "1"})
    body = view(owner, deck).json()
    assert body["status"] == "blocked" and body["text"] is None and body["inline"] is False and body["byte_length"] == 0
    alt, sus = world["alt"]["editions"][0], world["sus"]["editions"][0]
    assert body["blockers"] == [
        {"edition_id": alt, "name": "Alt Art Card", "set_name": "Trainer Gallery", "collector_number": "TG01",
         "descriptor": {"label": "Unspecified Variant"}, "quantity": "2", "reason": "no_active_rule"},
        {"edition_id": sus, "name": "Furret", "set_name": "Seed Set", "collector_number": "136",
         "descriptor": {"label": "Unspecified Variant"}, "quantity": "3", "reason": "source_changed"}]
    assert body["total_copies"] == "7"
    refused = stream(owner, deck, body["owner_revision"])
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "LIVE_EXPORT_BLOCKED"


def test_a_printing_without_live_metadata_or_display_data_is_a_blocker_not_an_error():
    owner, deck, world = make_deck(MIXED[:1], {("mon", 0): "1"})
    with connect() as conn:
        conn.execute("DELETE FROM catalog_printing_metadata WHERE printing_id=%s", (world["mon"]["printing"],))
    body = view(owner, deck).json()
    assert body["status"] == "blocked" and [b["reason"] for b in body["blockers"]] == ["unsupported"]


def test_empty_deck_is_reported_and_streams_nothing():
    owner, deck, _ = make_deck(MIXED[:1], {})
    body = view(owner, deck).json()
    assert (body["status"], body["text"], body["byte_length"], body["total_copies"], body["blockers"]) == ("empty", None, 0, "0", [])
    refused = stream(owner, deck, body["owner_revision"])
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "DECK_EMPTY"


def test_a_59_card_deck_exports_without_legality_claims():
    owner, deck, _ = make_deck(MIXED[2:3], {("trainer", 0): "59"})
    assert view(owner, deck).json()["text"] == "Trainer: 59\n59 Ultra Ball SVI 196"


def test_sums_exceeding_signed_64_bit_are_exact():
    owner, deck, _ = make_deck(MIXED[:1], {("mon", 0): str(2**63 - 1), ("mon", 1): str(2**63 - 1)})
    body = view(owner, deck).json()
    assert body["text"] == f"Pokémon: {2**64 - 2}\n{2**64 - 2} Gholdengo ex PAR 139" and body["total_copies"] == str(2**64 - 2)


@pytest.mark.slow(reason='capacity: more than one page of Editions')
def test_more_than_one_page_of_editions_is_complete():
    cards = [{"key": f"c{index:02}", "name": f"Card {index:02}", "number": str(index + 1), "category": "Trainer",
              "live": live(f"Card {index:02}", "TST", str(index + 1))} for index in range(52)]
    cards.append({"key": "multi", "name": "Multi", "number": "100", "category": "Trainer", "live": live("Multi", "TST", "100"),
                  "finishes": [{"finish": "normal"}, {"finish": "reverse"}, {"finish": "holo"}]})
    quantities = {(card["key"], 0): "1" for card in cards[:52]} | {("multi", 0): "1", ("multi", 1): "1", ("multi", 2): "1"}
    owner, deck, _ = make_deck(cards, quantities)
    lines = view(owner, deck).json()["text"].split("\n")
    assert lines[0] == "Trainer: 55" and len(lines) == 54 and "3 Multi TST 100" in lines
    assert call("GET", f"/api/decks/{deck}/contents", owner).json()["editions"].__len__() == 55


def test_stream_stale_revision_privacy_and_authentication():
    owner, deck, world = make_deck(MIXED, {("trainer", 0): "1"})
    revision = view(owner, deck).json()["owner_revision"]
    put(owner, deck, world["basic"]["editions"][0], "1")
    stale = stream(owner, deck, revision)
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "INVENTORY_CHANGED"
    assert call("GET", f"/api/decks/{deck}/exports/live.txt", owner).status_code == 422
    other = str(uuid4())
    assert view(other, deck).status_code == 404 and stream(other, deck, revision + 1).status_code == 404
    assert view(owner, str(uuid4())).status_code == 404
    with connect() as conn:
        leaf = conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Binder','storage_leaf') RETURNING id",
                            (uuid4(), owner)).fetchone()["id"]
    assert view(owner, leaf).status_code == 404
    assert client.get(f"/api/decks/{deck}/exports/live").status_code == 401


def test_large_output_is_not_inlined_but_streams_complete(monkeypatch):
    monkeypatch.setattr(deck_live_export, "INLINE_LIMIT_BYTES", 40)
    owner, deck, _ = make_deck(MIXED, {("mon", 0): "3", ("trainer", 0): "4", ("basic", 0): "2"})
    body = view(owner, deck).json()
    assert body["status"] == "ok" and body["inline"] is False and body["text"] is None
    full = stream(owner, deck, body["owner_revision"]).text
    assert body["byte_length"] == len(full.encode()) > 40 and full.startswith("Pokémon: 3")
    monkeypatch.setattr(deck_live_export, "INLINE_LIMIT_BYTES", body["byte_length"])
    assert view(owner, deck).json()["text"] == full  # exactly at the limit is still inline


def test_a_concurrent_add_yields_one_consistent_revision_and_quantity():
    owner, deck, world = make_deck(MIXED[:1], {("mon", 0): "1"})
    edition = world["mon"]["editions"][0]
    seen = {view(owner, deck).json()["owner_revision"]: 1}
    observed = []
    done = threading.Event()

    def reader():
        while not done.is_set():
            body = view(owner, deck).json()
            observed.append((body["owner_revision"], int(body["total_copies"]), body["text"]))

    thread = threading.Thread(target=reader)
    thread.start()
    try:
        for _ in range(12):
            response = add(owner, deck, edition, "1").json()
            seen[response["owner_revision"]] = int(response["quantity"])
    finally:
        done.set()
        thread.join()
    assert observed
    for revision, total, text in observed:
        assert seen[revision] == total and text == f"Pokémon: {total}\n{total} Gholdengo ex PAR 139"


def test_an_activated_rule_qualifies_a_printing_without_a_maintainer_decision():
    reset_catalog()
    activate(LIVE, 99)
    run(Records(furret()))
    owner = str(uuid4())
    with connect() as conn:
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s)", (owner,))
        edition = conn.execute("SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='meta-1' "
                               "ORDER BY e.descriptor_key LIMIT 1").fetchone()["id"]
    deck = create(owner).json()["location"]["id"]
    put(owner, deck, edition, "2")
    assert view(owner, deck).json()["text"] == "Pokémon: 2\n2 Furret DAA 136"


def test_no_live_identifier_is_persisted_and_the_shipped_set_table_stays_empty():
    assert LiveRulesV1.SET_CODES == {}
    with connect() as conn:
        columns = {row["column_name"] for row in conn.execute("""SELECT column_name FROM information_schema.columns
          WHERE table_name LIKE 'catalog\\_%' AND (column_name LIKE '%live%' OR column_name LIKE '%tcg_online%')""")}
    assert {name for name in columns if name.endswith("_id")} == {"live_decision_id", "live_activation_id"}


# ------------------------------------------------------------------ the whole Deck List (Deck Lists 08)


def test_the_export_is_the_whole_deck_list_whether_owned_elsewhere_or_not_owned():
    owner, deck, world = make_deck(MIXED, {("trainer", 0): "1"})
    line(owner, deck, world["mon"]["editions"][0], "2")      # not owned
    line(owner, deck, world["basic"]["editions"][0], "3")    # owned, elsewhere
    put(owner, binder(owner), world["basic"]["editions"][0], "3")
    body = view(owner, deck).json()
    expected = "Pokémon: 2\n2 Gholdengo ex PAR 139\n\nTrainer: 1\n1 Ultra Ball SVI 196\n\nEnergy: 3\n3 Metal Energy SVE 8"
    assert (body["status"], body["text"], body["total_copies"]) == ("ok", expected, "6")
    assert body["deck_list_revision"] == deck_list_revision(owner, deck)
    streamed = stream(owner, deck, body["owner_revision"], body["deck_list_revision"])
    assert streamed.status_code == 200 and streamed.text == expected


def test_copies_cut_from_the_deck_list_are_left_out():
    owner, deck, world = make_deck(MIXED, {("trainer", 0): "4", ("mon", 0): "1"})
    line(owner, deck, world["trainer"]["editions"][0], "1")
    line(owner, deck, world["mon"]["editions"][0])
    body = view(owner, deck).json()
    assert (body["status"], body["text"], body["total_copies"]) == ("ok", "Trainer: 1\n1 Ultra Ball SVI 196", "1")
    line(owner, deck, world["trainer"]["editions"][0])
    body = view(owner, deck).json()
    assert (body["status"], body["text"], body["total_copies"]) == ("empty", None, "0")
    refused = stream(owner, deck, body["owner_revision"])
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "DECK_EMPTY"


def test_a_deck_list_edit_refuses_a_download_pinned_to_the_older_deck_list():
    owner, deck, world = make_deck(MIXED, {("trainer", 0): "1"})
    before = view(owner, deck).json()
    line(owner, deck, world["mon"]["editions"][0], "2")
    after = view(owner, deck).json()
    assert after["owner_revision"] == before["owner_revision"]          # a Deck List edit moves no inventory
    assert after["deck_list_revision"] > before["deck_list_revision"]
    stale = stream(owner, deck, before["owner_revision"], before["deck_list_revision"])
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "DECK_LIST_CHANGED"
    current = stream(owner, deck, after["owner_revision"], after["deck_list_revision"])
    assert current.status_code == 200 and current.text == after["text"]
    assert stream(owner, deck, before["owner_revision"]).text == after["text"]   # unpinned, as today's client asks
    assert stream(owner, deck, before["owner_revision"], 0).status_code == 422
