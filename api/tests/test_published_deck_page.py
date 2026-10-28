"""What the Published Deck page reads (app redesign #183), through anonymous HTTP against a real manifest and record store.

- The public format checks answer the snapshot's Target Format only, and match the private route for that Format.
- The public cost lists each frozen Edition's own price (`editions: [{edition_ref, amount}]`), with no price age, from
  the same single access as the totals.
- A snapshot freezes the display facts the page groups its rows by: card kind, Trainer Type, evolves from and a
  Pokémon's evolution root and stage. A snapshot published before this release reads them as null.
- No public response the page reads carries ownership or storage data.
"""
import json
from uuid import uuid4

from app.main import app, connect  # noqa: F401
from test_card_attributes import BULBASAUR_ME, ENERGY_SV, card, edition_of
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_deck_format_checks import CARDS
from test_discovery import visibility
from test_holdings import add, call, client
from test_moves import leaf
from test_prices import seed_public as seed, world
from test_publications import command, legacy_snapshot, list_cards, stored_decks
from test_published_cost import USER, body_of, public_cost, publish, rewrite_snapshot, store  # noqa: F401
from test_published_format_checks import LEGAL, matches_private, path_of, public_get, published, refused, timeless

SET = {"id": "me01", "name": "Mega Evolution"}
BASIC = card(id="fixture-me01-951", name="Pagemon", localId="951", category="Pokemon", set=SET, regulationMark="I",
             stage="Basic", rarity="Common", types=["Grass"])
STAGE_ONE = card(id="fixture-me01-952", name="Pagemon Evolved", localId="952", category="Pokemon", set=SET,
                 regulationMark="I", stage="Stage1", rarity="Common", types=["Grass"], evolveFrom="Pagemon")
SUPPORTER = card(id="fixture-me01-953", name="Page Professor", localId="953", category="Trainer", set=SET,
                 regulationMark="I", rarity="Common", trainerType="Supporter")
DISPLAY_KEYS = ("card_kind", "trainer_type", "evolves_from", "evolution_root", "evolution_stage")
# Words and keys that would mean a public answer leaked the owner's Collection or storage.
PRIVATE_KEYS = {"owner", "owner_id", "user_id", "deck_id", "deck_name", "location", "location_id", "locations",
                "holding", "holdings", "in_deck", "elsewhere", "not_owned", "ownership", "owned", "free", "surplus",
                "owner_revision", "deck_list_revision", "edition_id", "printing_id", "identity_id", "storage", "places",
                "cost_to_complete", "deck_list_cost", "email", "attribute_revision", "catalog_revision",
                "mapping_revision", "product_id", "quote_lookup", "stale_copies", "unknown_age_copies", "fallback_copies",
                "provider_updated_at"}


def keys_of(value, found=None):
    """Every object key anywhere in a JSON value."""
    found = set() if found is None else found
    if isinstance(value, dict):
        for key, item in value.items():
            found.add(key)
            keys_of(item, found)
    elif isinstance(value, list):
        for item in value:
            keys_of(item, found)
    return found


def set_target(owner, deck, target):
    """Set the Deck List's Target Format as fixture state, advancing its revision (the command has its own tests)."""
    with connect() as conn:
        assert conn.execute("UPDATE deck_list SET target_format=%s,revision=revision+1 WHERE owner_id=%s AND deck_id=%s",
                            (target, owner, deck)).rowcount == 1


def formats_of(token, version, query=""):
    return [result["format"] for result in body_of(public_get(path_of(token, version, query)))["results"]]


def test_public_format_checks_answer_only_the_snapshots_target_format_like_the_private_route(store):
    reset_catalog()
    run(Records(*CARDS))
    deck, token = published(LEGAL)
    assert formats_of(token, 1) == ["standard"]
    assert matches_private(token, deck)["status"] == "legal"
    # Republishing freezes another Target Format; the public answer follows the snapshot, not the request.
    for version, target in ((2, "expanded"), (3, "glc")):
        set_target(USER, deck, target)
        assert command(USER, deck, "PUT").status_code == 200
        assert stored_decks()["decks"][token]["snapshot"]["target_format"] == target
        assert formats_of(token, version) == [target]
        assert formats_of(token, version, "?as_of=2026-10-11") == [target]
        result = matches_private(token, deck, version=version)
        assert result["format"] == target
    # The Deck's Target Format moving on changes nothing public until a republish.
    set_target(USER, deck, "standard")
    assert formats_of(token, 3) == ["glc"]
    # A Format is never a request input.
    for query in ("?format=standard", "?format=glc", "?format=unlimited"):
        refused(public_get(path_of(token, 3, query)), 422, "INVALID_REQUEST")
    # A snapshot published before #178 has no target_format and is checked in Standard.
    rewrite_snapshot(token, lambda snapshot: snapshot.pop("target_format"))
    assert formats_of(token, 3) == ["standard"]


def test_public_cost_lists_each_frozen_editions_price_with_no_age(store, monkeypatch):
    editions = world()
    normal, reverse, plain = editions["normal"], editions["reverse-holofoil"], editions["unspecified"]
    seed(store, normal, "0.25")
    seed(store, reverse, "0.43")
    deck, token = publish({normal["id"]: 3, reverse["id"]: 2, plain["id"]: 1})
    body = body_of(public_cost(token, 1))
    assert (body["status"], body["display_amount"], body["priced_copies"], body["total_copies"]) == (
        "priced", "$1.61", "5", "6")
    frozen = [edition["edition_ref"] for identity in stored_decks()["decks"][token]["snapshot"]["identities"]
              for edition in identity["editions"]]
    # One entry per frozen Edition, in snapshot order, with exactly two keys: the exact per-copy amount or null.
    assert [entry["edition_ref"] for entry in body["editions"]] == frozen
    assert all(set(entry) == {"edition_ref", "amount"} for entry in body["editions"])
    assert {entry["edition_ref"]: entry["amount"] for entry in body["editions"]} == {
        normal["public_ref"]: "0.25", reverse["public_ref"]: "0.43", plain["public_ref"]: None}
    assert not keys_of(body["editions"]) & {"age", "stale", "provider_updated_at", "checked_at", "refresh"}

    # An answer withheld for its validation carries no Edition either.
    from app import public_deck
    from app.public_projection import ProjectionUnavailable
    real, calls = public_deck._record, []

    def second_fails(*args, **kwargs):
        calls.append(1)
        if len(calls) >= 2:
            raise ProjectionUnavailable()
        return real(*args, **kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(public_deck, "_record", second_fails)
        withheld = body_of(public_cost(token, 1))
    assert (withheld["status"], withheld["reason"], withheld["editions"]) == ("incomplete", "validation_unavailable", [])

    # Legacy rows carry no reference, so they have no entry.
    legacy_snapshot(token)
    legacy = body_of(public_cost(token, 1))
    assert (legacy["status"], legacy["editions"]) == ("no_quotes", [])


def test_a_snapshot_freezes_what_the_page_groups_each_row_by(store):
    reset_catalog()
    run(Records(BASIC, STAGE_ONE, SUPPORTER, ENERGY_SV, BULBASAUR_ME))
    deck, token = published(((BASIC["id"], 2), (STAGE_ONE["id"], 1), (SUPPORTER["id"], 4), (ENERGY_SV["id"], 10)))
    snapshot = client.get(f"/api/public/decks/{token}").json()
    shown = {edition["printing_name"]: tuple(edition[key] for key in DISPLAY_KEYS)
             for identity in snapshot["identities"] for edition in identity["editions"]}
    assert shown == {
        "Pagemon": ("pokemon", None, None, "Pagemon", 0),
        "Pagemon Evolved": ("pokemon", None, "Pagemon", "Pagemon", 1),
        "Page Professor": ("trainer", "supporter", None, None, None),
        "Basic Grass Energy": ("energy", None, None, None, None),
    }
    # They are frozen: stored with the snapshot, not read again from the catalog.
    stored = {edition["printing_name"]: edition["evolves_from"]
              for identity in stored_decks()["decks"][token]["snapshot"]["identities"] for edition in identity["editions"]}
    assert stored["Pagemon Evolved"] == "Pagemon"
    # A snapshot published before this release has none of them: the snapshot route reads each as null.
    legacy_snapshot(token)
    for identity in client.get(f"/api/public/decks/{token}").json()["identities"]:
        for edition in identity["editions"]:
            assert all(edition[key] is None for key in DISPLAY_KEYS)


def test_no_public_response_the_page_reads_contains_ownership_or_storage(store):
    editions = world()
    normal, reverse, plain = editions["normal"], editions["reverse-holofoil"], editions["unspecified"]
    seed(store, normal, "0.25")
    owner = f"page-owner-{uuid4()}"
    created = call("POST", "/api/decks", owner, {"name": "Secret shelf deck", "idempotency_key": str(uuid4())})
    assert created.status_code == 201, created.text
    deck = created.json()["location"]["id"]
    binder = leaf(owner, "Secret binder")
    list_cards(owner, deck, {normal["id"]: 3, reverse["id"]: 2, plain["id"]: 1})
    # Two copies in the Deck, one in the binder, the rest not owned.
    assert add(owner, deck, str(normal["id"]), "2").status_code == 200
    assert add(owner, binder, str(reverse["id"]), "1").status_code == 200
    published_now = command(owner, deck, title="Shared list")
    assert published_now.status_code == 200, published_now.text
    token = published_now.json()["token"]
    assert visibility(owner, deck, "listed").status_code == 200

    base = f"/api/public/decks/{token}"
    answers = {
        "snapshot": client.get(base),
        "cost": public_cost(token, 1),
        "format-checks": public_get(path_of(token, 1)),
        "live": client.get(f"{base}/versions/1/exports/live"),
        "mass entry": client.get(f"{base}/versions/1/exports/tcgplayer"),
        "discovery": client.get("/api/public/discovery"),
    }
    with connect() as conn:
        unsorted = conn.execute("SELECT id FROM location WHERE owner_id=%s AND name='Unsorted'", (owner,)).fetchone()
    secrets = [owner, deck, binder, "Secret shelf deck", "Secret binder", *(str(e["id"]) for e in (normal, reverse, plain))]
    if unsorted:
        secrets.append(str(unsorted["id"]))
    for name, response in answers.items():
        assert response.status_code == 200, (name, response.text)
        body = response.json()
        assert not keys_of(body) & PRIVATE_KEYS, (name, keys_of(body) & PRIVATE_KEYS)
        text = json.dumps(body)
        for secret in secrets:
            assert secret not in text, (name, secret)
    # The snapshot's rows carry exactly the frozen public fields, the display facts included.
    for identity in answers["snapshot"].json()["identities"]:
        for edition in identity["editions"]:
            assert set(edition) == {"set_id", "set_name", "collector_number", "variant", "image_url", "quantity",
                                    "edition_ref", "printing_ref", "printing_name", *DISPLAY_KEYS}
    assert [deck_card["url"] for deck_card in answers["discovery"].json()["decks"]] == [f"/published/{token}"]
    assert timeless(answers["format-checks"].json()["results"])[0]["format"] == "standard"


def page_world(owner, prefix):
    """The Published Deck page's browser spec (web/tests/published-deck.spec.ts) on its stack: the format-check cards
    with art, four of them priced (as test_discover_listing.listing_world prices them), and three Published Decks of
    ``owner`` titled ``prefix`` and a name. "Legal" is legal in Standard with every copy priced ($66.55) and Listed;
    "Over" holds five Professor's Research (a card-level copy-limit issue) and is Listed; "Orphan" is legal and
    Unlisted, and its Deck is gone (its publication unlinked, as deleting the Deck leaves it). Returns the tokens and
    the Legal Deck's id."""
    from app import public_catalog
    from app.public_records import public_record_store
    from test_discover_listing import LEGAL as LISTED_LEGAL, OVER, catalog, list_publicly, priced
    from test_published_cost import listed_deck
    catalog()
    with connect() as conn:
        public_catalog.drain_to_completion(conn)
    records = public_record_store()
    for source_id, amount in (("me01-001", "1.25"), ("me01-125", "10.00"), ("me01-130", "2.50"), ("sv02-278", "0.30")):
        priced(records, source_id, amount)
    found = {}
    for name, cards, listed in (("Legal", LISTED_LEGAL, True), ("Over", OVER, True), ("Orphan", LISTED_LEGAL, False)):
        deck = listed_deck({edition_of(source_id): quantity for source_id, quantity in cards}, user=owner)
        response = command(owner, deck, title=f"{prefix} {name}")
        assert response.status_code == 200, response.text
        found[name] = response.json()["token"]
        if listed:
            assert list_publicly(owner, deck).status_code == 200
        if name == "Legal":
            found["deck"] = deck
    with connect() as conn:
        conn.execute("UPDATE deck_publication SET deck_id=NULL WHERE token=%s", (found["Orphan"],))
    return found
