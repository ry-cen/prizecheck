"""Copy to my Decks (decklist import #216): ``POST /api/decks/import/review`` with a publication token as its source,
through signed HTTP against PostgreSQL, a real public projection and a real record store.

Each snapshot row is one review line with its quantity. Its public Edition reference resolves to an active Edition (of
a Printing that isn't withdrawn); otherwise its public Printing reference resolves to an active Printing, whose Edition
the allocation chooses; otherwise the line is Not found with the row's name, set and number. Under Exact printings the
copies the collector doesn't own keep the snapshot's Edition; owned copies of the named Printing still come first. The
review answers the Published Deck's title and Target Format (the new Deck's defaults) and the snapshot version it
read; a pinned version that is no longer active answers 409, and a revoked, unknown or malformed token 404, as the
public read does.

Every Published Deck here belongs to another owner than the reviewer, unless a test says otherwise. Publishing goes
through the real publication command, with the publish gate exempted (``test_publications.command``).
"""
import time
from uuid import uuid4

import pytest

from app.main import app, connect  # noqa: F401
from app import price_launcher
from app.public_projection import FilePublicProjection
from app.public_records import public_record_store
from test_catalog_targets import isolated_rules  # noqa: F401  (autouse)
from test_deck_counting import hold, new_owner
from test_deck_import import sql
from test_deck_list_printing import furret_world
from test_deck_lists import code
from test_decks import create
from test_holdings import call, client
from test_import_owned import edition, place
from test_prices import seed
from test_publications import command, legacy_snapshot
from test_published_cost import listed_deck
from deck_import_fixtures import seed_import_owned_catalog

REVIEW = "/api/decks/import/review"
IMPORT = "/api/decks/import"


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("PUBLIC_PROJECTION_DIR", str(tmp_path))
    monkeypatch.setenv("PUBLIC_PROJECTION_ADAPTER", "filesystem")
    with FilePublicProjection().writer(initialize=True):
        pass
    public_record_store().initialize(deadline=time.monotonic() + 5)
    return public_record_store()


@pytest.fixture(autouse=True)
def launches(monkeypatch):
    """Records any runner launch; reviewing a copy must never cause one."""
    calls = []
    monkeypatch.setattr(price_launcher, "spawn", lambda slot, owner: calls.append((slot, owner)) or True)
    return calls


def publish(quantities, title="Iono Toolbox", target="standard", publisher=None):
    """Publishes a Deck of ``publisher`` (a new owner by default) whose Deck List is ``{edition_id: quantity}`` and
    whose Target Format is ``target``; returns (publisher, Deck id, token, version)."""
    publisher = publisher or f"publisher-{uuid4()}"
    deck = listed_deck(quantities, user=publisher)
    sql("UPDATE deck_list SET target_format=%s WHERE owner_id=%s AND deck_id=%s", (target, publisher, deck))
    response = command(publisher, deck, title=title)
    assert response.status_code == 200, response.text
    return publisher, deck, response.json()["token"], response.json()["version"]


def post(owner, token, owned=None, version=None, fixes=()):
    source = {"publication": token}
    if version is not None:
        source["version"] = version
    body = {"source": source, "fixes": list(fixes)}
    if owned is not None:
        body["owned"] = owned
    return call("POST", REVIEW, owner, body)


def review(owner, token, owned=None, version=None, fixes=()):
    response = post(owner, token, owned, version, fixes)
    assert response.status_code == 200, response.text
    return response.json()


def by_card(body):
    """The review's lines by (set code, number)."""
    return {(line["set_code"], line["number"]): line for line in body["lines"]}


def parts(line):
    return [(part["edition_id"], part["quantity"], part["source"], part["chosen_by"]) for part in line["parts"]]


def printing_of(source_id):
    return str(sql("SELECT id FROM catalog_printing WHERE source_id=%s", (source_id,))[0][0])


# ------------------------------------------------------------------ resolving each row


def test_each_row_resolves_by_its_edition_then_its_printing_else_not_found(launches):
    seed_import_owned_catalog()
    nest_n, nest_r = edition("sv01-181", "normal"), edition("sv01-181", "reverse")
    iono_n, iono_r = edition("sv02-185", "normal"), edition("sv02-185", "reverse")
    holo = edition("sv02-254", "holo")
    _, _, token, version = publish({nest_r: 2, iono_r: 3, holo: 1})
    # After publishing: Iono PAL 185's Reverse Holo is retired, and Iono PAL 254 is withdrawn.
    sql("UPDATE catalog_generation_edition SET active=false WHERE edition_id=%s", (iono_r,))
    sql("UPDATE catalog_generation_printing SET tombstoned=true WHERE printing_id=%s", (printing_of("sv02-254"),))
    owner, _ = new_owner()
    for owned in ("exact", "owned"):
        body = review(owner, token, owned)
        lines = by_card(body)
        assert sorted(lines) == [("PAL", "185"), ("PAL", "254"), ("SVI", "181")]
        assert [line["line"] for line in body["lines"]] == [1, 2, 3]
        assert body["ignored"] == []
        nest, retired, gone = lines[("SVI", "181")], lines[("PAL", "185")], lines[("PAL", "254")]
        # The Edition reference: Nest Ball's own Printing, matched.
        assert (nest["status"], nest["quantity"], nest["name"], nest["section"]) == ("matched", "2", "Nest Ball",
                                                                                  "trainer")
        assert nest["printing"]["printing_id"] == printing_of("sv01-181")
        assert nest["text"] == "2 Nest Ball SVI 181"
        # The retired Edition falls back to its Printing; the allocation chooses the Edition (no quote: catalog order).
        assert retired["status"] == "matched"
        assert retired["printing"]["printing_id"] == printing_of("sv02-185")
        assert parts(retired) == [(iono_n, "3", "new", "catalog_order")]
        assert iono_r not in [entry["edition_id"] for entry in body["deck_list"]]
        # The withdrawn Printing is Not found, with the row's name, set and number and the Missing cards prefill.
        assert (gone["status"], gone["name"], gone["set_code"], gone["number"], gone["quantity"]) == (
            "not_found", "Iono", "PAL", "254", "1")
        assert gone["printing"] is None and gone["parts"] == []
        assert {key: gone["report"][key] for key in ("kind", "english_name", "set_id", "collector_number")} == {
            "kind": "printing", "english_name": "Iono", "set_id": "sv02", "collector_number": "254"}
        assert body["totals"]["to_resolve"] == 1 and body["totals"]["cards"] == "6"
        assert body["totals"]["card_lines"] == 3 and body["totals"]["ignored"] == 0
        assert body["publication"] == {"token": token, "version": version, "title": "Iono Toolbox",
                                       "target_format": "standard"}
    # Under Exact printings the Edition reference keeps the snapshot's Reverse Holo; under Use cards I own the
    # allocation chooses as for any line (no quote: catalog order, Normal first).
    assert parts(by_card(review(owner, token, "exact"))[("SVI", "181")]) == [(nest_r, "2", "new", "published")]
    assert parts(by_card(review(owner, token, "owned"))[("SVI", "181")]) == [(nest_n, "2", "new", "catalog_order")]
    assert launches == []


def test_a_row_published_without_references_is_not_found():
    seed_import_owned_catalog()
    _, _, token, _ = publish({edition("sv01-181", "reverse"): 2})
    legacy_snapshot(token)
    [line] = review(new_owner()[0], token)["lines"]
    assert (line["status"], line["name"], line["set_code"], line["number"]) == ("not_found", "Nest Ball", "SVI", "181")


# ------------------------------------------------------------------ Exact printings and owned copies


def test_exact_printings_keeps_the_snapshot_edition_for_copies_not_owned(store):
    owner, _ = new_owner()
    printing, (normal, reverse), by_id = furret_world(owner)
    seed(store, by_id[normal], "0.50")
    seed(store, by_id[reverse], "0.10")
    _, _, token, _ = publish({normal: 3}, title="Furret")
    binder = place(owner, "Binder")
    hold(owner, binder, reverse, 1)
    exact = review(owner, token, "exact")
    [line] = exact["lines"]
    # Owned copies of the named Printing come first, in any Edition; the rest keeps the snapshot's $0.50 Normal,
    # though the Reverse Holo is cheaper.
    assert parts(line) == [(reverse, "1", "elsewhere", None), (normal, "2", "new", "published")]
    assert [(entry["edition_id"], entry["quantity"]) for entry in exact["deck_list"]] == [(reverse, "1"), (normal, "2")]
    assert (exact["totals"]["owned"], exact["totals"]["to_get"], exact["totals"]["to_get_display"]) == (
        "1", "2", "$1.00")
    # Use cards I own: the rest gets the cheapest priced Edition, as any import line does.
    mine = review(owner, token, "owned")
    assert parts(mine["lines"][0]) == [(reverse, "1", "elsewhere", None), (reverse, "2", "new", "cheapest_price")]
    # The collector's own Edition choice wins over the snapshot's.
    chosen = review(owner, token, "exact", fixes=[{"line": 1, "edition_id": reverse}])
    assert parts(chosen["lines"][0]) == [(reverse, "1", "elsewhere", None), (reverse, "2", "new", "collector")]


def test_fixes_pick_or_drop_copied_lines():
    seed_import_owned_catalog()
    nest_r, holo = edition("sv01-181", "reverse"), edition("sv02-254", "holo")
    _, _, token, version = publish({nest_r: 2, holo: 1})
    sql("UPDATE catalog_generation_printing SET tombstoned=true WHERE printing_id=%s", (printing_of("sv02-254"),))
    owner, _ = new_owner()
    body = review(owner, token, "exact")
    gone = by_card(body)[("PAL", "254")]["line"]
    picked = review(owner, token, "exact", version, [{"line": gone, "printing_id": printing_of("sv02-185")}])
    line = by_card(picked)[("PAL", "254")]
    assert line["status"] == "picked" and line["printing"]["collector_number"] == "185"
    assert parts(line) == [(edition("sv02-185", "normal"), "1", "new", "catalog_order")]
    assert picked["totals"]["to_resolve"] == 0
    dropped = review(owner, token, "exact", version, [{"line": gone, "drop": True}])
    assert by_card(dropped)[("PAL", "254")]["status"] == "dropped"
    assert dropped["deck_list"] == [{"edition_id": nest_r, "quantity": "2"}]


# ------------------------------------------------------------------ the source, the version and the token


def test_a_revoked_unknown_or_malformed_token_answers_404():
    seed_import_owned_catalog()
    publisher, deck, token, _ = publish({edition("sv01-181", "normal"): 1})
    owner, _ = new_owner()
    assert review(owner, token)["publication"]["token"] == token
    revoked = command(publisher, deck, method="DELETE")
    assert revoked.status_code == 200, revoked.text
    for each in (token, "A" * 32, "not-a-token", "x" * 33):
        response = post(owner, each)
        assert response.status_code == 404, (each, response.text)
        assert code(response) == "PUBLISHED_DECK_NOT_FOUND"


def test_a_pinned_version_that_is_no_longer_active_answers_409():
    seed_import_owned_catalog()
    publisher, deck, token, version = publish({edition("sv01-181", "normal"): 1})
    owner, _ = new_owner()
    assert review(owner, token, version=version)["publication"]["version"] == version
    republished = command(publisher, deck, method="PUT", title="Iono Toolbox v2")
    assert republished.status_code == 200, republished.text
    stale = post(owner, token, version=version)
    assert stale.status_code == 409 and code(stale) == "PUBLISHED_DECK_CHANGED"
    current = review(owner, token)
    assert current["publication"]["version"] == version + 1 and current["publication"]["title"] == "Iono Toolbox v2"
    assert review(owner, token, version=version + 1)["publication"] == current["publication"]


def test_the_source_is_pasted_text_or_a_publication_never_both():
    seed_import_owned_catalog()
    _, _, token, version = publish({edition("sv01-181", "normal"): 1})
    owner, _ = new_owner()
    for source in ({}, {"text": "1 Nest Ball SVI 181", "publication": token}, {"text": None, "publication": None},
                   {"text": "1 Nest Ball SVI 181", "version": version}):
        response = call("POST", REVIEW, owner, {"source": source, "fixes": []})
        assert response.status_code == 422, (source, response.text)
        assert code(response) == "INVALID_SOURCE", source
    # Copy only creates a new Deck: a Replace target with a publication is refused.
    deck = create(owner, "Mine").json()["location"]["id"]
    replace = call("POST", REVIEW, owner, {"source": {"publication": token}, "deck_id": deck, "fixes": []})
    assert replace.status_code == 422 and code(replace) == "INVALID_SOURCE"
    pasted = call("POST", REVIEW, owner, {"source": {"text": "1 Nest Ball SVI 181"}, "fixes": []})
    assert pasted.status_code == 200 and pasted.json()["publication"] is None


# ------------------------------------------------------------------ defaults and the new Deck


def test_the_copy_starts_from_the_title_and_target_format_and_creates_a_new_deck():
    seed_import_owned_catalog()
    nest_r, iono_n = edition("sv01-181", "reverse"), edition("sv02-185", "normal")
    _, _, token, version = publish({nest_r: 2, iono_n: 4}, title="Lost Box", target="expanded")
    stranger = str(uuid4())
    payload = {"source": {"publication": token}, "fixes": []}
    assert client.post(REVIEW, json=payload).status_code == 401
    body = review(stranger, token, "exact")
    assert body["publication"] == {"token": token, "version": version, "title": "Lost Box",
                                   "target_format": "expanded"}
    # The review stays read-only: a first-time caller's owner row isn't created.
    assert sql("SELECT count(*) FROM inventory_owner WHERE user_id=%s", (stranger,)) == [(0,)]
    created = call("POST", IMPORT, stranger, {"name": body["publication"]["title"],
                                              "target_format": body["publication"]["target_format"],
                                              "lines": body["deck_list"], "idempotency_key": str(uuid4())})
    assert created.status_code == 201, created.text
    result = created.json()
    assert result["location"]["name"] == "Lost Box" and result["target_format"] == "expanded"
    assert {(line["edition_id"], line["quantity"]) for line in result["deck_list"]["lines"]} == {
        (nest_r, "2"), (iono_n, "4")}


def test_the_publisher_can_copy_their_own_published_deck():
    seed_import_owned_catalog()
    owner, _ = new_owner()
    _, _, token, _ = publish({edition("sv01-181", "normal"): 1}, publisher=owner)
    assert review(owner, token)["lines"][0]["status"] == "matched"


# ------------------------------------------------------------------ the browser spec's world


def copy_world(prefix):
    """web/tests/copy-to-my-decks.spec.ts on its stack, on the owned-cards catalog (``seed_import_owned_catalog``,
    which replaces the catalog): two Published Decks of another owner. "<prefix> Lost Box" is Expanded and lists 2 Nest
    Ball SVI 181 Reverse Holo, 3 Iono PAL 185 Normal and 1 Iono PAL 254 Holo, whose Printing is withdrawn after
    publishing, so its line is Not found. "<prefix> Gone" is revoked. Returns their tokens."""
    seed_import_owned_catalog()
    nest_r, iono_n, holo = edition("sv01-181", "reverse"), edition("sv02-185", "normal"), edition("sv02-254", "holo")
    _, _, copy, _ = publish({nest_r: 2, iono_n: 3, holo: 1}, title=f"{prefix} Lost Box", target="expanded")
    sql("UPDATE catalog_generation_printing SET tombstoned=true WHERE printing_id=%s", (printing_of("sv02-254"),))
    publisher, deck, gone, _ = publish({iono_n: 1}, title=f"{prefix} Gone")
    revoked = command(publisher, deck, method="DELETE")
    assert revoked.status_code == 200, revoked.text
    return {"copy": copy, "gone": gone}
