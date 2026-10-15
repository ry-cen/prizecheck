"""The Want List Swap fixtures (decklist import #211): a catalog with one Reprint Group of three Iono Printings, a card
in a group of its own, two Basic Energy Printings and a card in no group with two Editions.

Not a test module: test_want_list_swap.py and web/tests/want-list-swap.spec.ts import it. Seeding runs the real catalog
import (``deck_import_fixtures``), which derives the Reprint Groups from each record's rules text (``reprint_groups``).
"""
from deck_import_fixtures import basic_energy, printed, trainer

IONO = ("Each player shuffles their hand and puts it on the bottom of their deck. If either player put any cards on "
        "the bottom of their deck in this way, each player draws a card for each of their remaining Prize cards.")
ARVEN = "Search your deck for an Item card and a Pokémon Tool card, reveal them, and put them into your hand."

# Iono PAL 185, PAL 254 and PAF 80 share one Reprint Group (one name, the same effect). Arven SVI 166 has its own group
# and two Editions. Basic Energy is in no Reprint Group, and neither is Boss's Orders, which has no rules text here.
SWAP_CARDS = (
    trainer("sv02", "Paldea Evolved", "185", "Iono", IONO),
    trainer("sv02", "Paldea Evolved", "254", "Iono", IONO),
    trainer("sv04.5", "Paldean Fates", "080", "Iono", IONO),
    {**trainer("sv01", "Scarlet & Violet", "166", "Arven", ARVEN), "variants": {"normal": True, "reverse": True}},
    basic_energy("sve", "Scarlet & Violet Energies", "005", "Basic Psychic Energy"),
    basic_energy("sve", "Scarlet & Violet Energies", "013", "Basic Psychic Energy"),
    {**printed("sv02", "Paldea Evolved", "172", "Boss's Orders", "Trainer", trainerType="Supporter"),
     "variants": {"normal": True, "reverse": True}},
)

# Each Edition's key: the Printing's source id, and the Edition's finish when its Printing has two.
KEYS = {
    ("sv02-185", None): "PAL 185", ("sv02-254", None): "PAL 254", ("sv04.5-080", None): "PAF 80",
    ("sv01-166", "normal"): "SVI 166", ("sv01-166", "reverse"): "SVI 166 Reverse Holo",
    ("sve-005", None): "SVE 5", ("sve-013", None): "SVE 13",
    ("sv02-172", "normal"): "PAL 172", ("sv02-172", "reverse"): "PAL 172 Reverse Holo",
}


def seed_swap_catalog() -> dict[str, str]:
    """SWAP_CARDS through the real catalog import, replacing the catalog (and with it every Holding and Deck List line).
    Returns each Edition's id by its key in ``KEYS``."""
    from app.main import connect
    from deck_import_fixtures import _seed
    _seed(SWAP_CARDS)
    with connect() as conn:
        rows = conn.execute("""SELECT e.id,e.descriptor,p.source_id,
          (SELECT count(*) FROM catalog_edition o WHERE o.printing_id=p.id) AS editions
          FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id""").fetchall()
    found = {}
    for row in rows:
        finish = row["descriptor"].get("type") or row["descriptor"].get("finish") if row["editions"] > 1 else None
        found[KEYS[(row["source_id"], finish)]] = str(row["id"])
    assert set(found) == set(KEYS.values()), found
    return found


def print_swap_catalog():
    """For the browser spec: seed, then print the Edition ids as one JSON line after a marker."""
    import json
    print("SWAP" + json.dumps(seed_swap_catalog()))
