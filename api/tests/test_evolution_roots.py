"""Evolution roots (app redesign #176, owner-approved addendum; migration 043) over signed HTTP against PostgreSQL.

Each Pokémon line in the Deck read carries ``evolution_root`` and ``evolution_stage``: its ``evolves_from`` followed
through the whole catalog to the Pokémon that evolves from nothing, computed once per Card Identity when the catalog is
derived. A deck that skips a stage still names one root, so the deck builder draws one evolution line.

The catalog is imported through the real import (``seed``), which derives the roots; ``seed`` replaces the catalog, so
these tests live in their own file.
"""
from uuid import uuid4

import psycopg
import pytest

from app.games.pokemon.catalog.catalog import rederive_card_attributes
from app.games.pokemon.catalog.evolution_roots import EvolutionRoot, evolution_roots
from app.games.pokemon.formats.format_standing import ensure_current
from app.main import connect
from test_attribute_corrections import seed
from test_card_attributes import card, edition_of, revision
from test_deck_lists import add_line, detail
from test_decks import create

SET = {"id": "sv01", "name": "Scarlet & Violet"}


def pokemon(number, name, stage="Basic", evolves_from=None):
    fields = dict(id=f"fixture-evo-{number}", name=name, localId=str(number), category="Pokemon", set=SET,
                  regulationMark="G", stage=stage, rarity="Common", types=["Colorless"])
    if evolves_from:
        fields["evolveFrom"] = evolves_from
    return card(**fields)


CARDS = (
    # A full line in the catalog: a deck may skip Charmeleon or Charmander and still name one root.
    pokemon(1, "Charmander"), pokemon(2, "Charmeleon", "Stage1", "Charmander"),
    pokemon(3, "Charizard ex", "Stage2", "Charmeleon"),
    # Three Machoke Printings say Machop and one bad one says Charmander: the majority wins.
    pokemon(10, "Machop"), pokemon(11, "Machoke", "Stage1", "Machop"), pokemon(12, "Machoke", "Stage1", "Machop"),
    pokemon(13, "Machoke", "Stage1", "Machop"), pokemon(14, "Machoke", "Stage1", "Charmander"),
    pokemon(15, "Machamp", "Stage2", "Machoke"),
    # A one-to-one disagreement is a tie: no parent, so the card is its own root.
    pokemon(20, "Tiemon", "Stage1", "Machop"), pokemon(21, "Tiemon", "Stage1", "Charmander"),
    # A cycle in bad data terminates: each is its own root.
    pokemon(30, "Loopa", "Stage1", "Loopb"), pokemon(31, "Loopb", "Stage1", "Loopa"),
    # A chain longer than four steps falls back to the card itself.
    pokemon(40, "Chainmon Zero"), *(pokemon(40 + step, f"Chainmon {word}", "Stage1", f"Chainmon {before}")
                                     for step, (before, word) in enumerate(
                                         [("Zero", "One"), ("One", "Two"), ("Two", "Three"), ("Three", "Four"),
                                          ("Four", "Five")], start=1)),
    # An older fossil evolves from a Trainer item, which never joins Pokémon.
    card(id="fixture-evo-50", name="Unidentified Fossil", localId="50", category="Trainer", set=SET,
         regulationMark="G", rarity="Common", trainerType="Item"),
    pokemon(51, "Omanyte", "Stage1", "Unidentified Fossil"), pokemon(52, "Omastar", "Stage2", "Omanyte"),
    # Siblings share their root; a Basic that evolves from nothing is its own; a two-word name keys like any other.
    pokemon(60, "Riolu"), pokemon(61, "Lucario", "Stage1", "Riolu"), pokemon(62, "Mega Lucario ex", "Stage1", "Riolu"),
    pokemon(70, "Tatsugiri"), pokemon(80, "Hisuian Growlithe"),
    pokemon(81, "Hisuian Arcanine", "Stage1", "Hisuian Growlithe"),
)

EXPECTED = {
    "Charmander": ("Charmander", 0), "Charmeleon": ("Charmander", 1), "Charizard ex": ("Charmander", 2),
    "Machop": ("Machop", 0), "Machoke": ("Machop", 1), "Machamp": ("Machop", 2),
    "Tiemon": ("Tiemon", 0),
    "Loopa": ("Loopa", 0), "Loopb": ("Loopb", 0),
    "Chainmon Four": ("Chainmon Zero", 4), "Chainmon Five": ("Chainmon Five", 0),
    "Unidentified Fossil": (None, None), "Omanyte": ("Omanyte", 0), "Omastar": ("Omanyte", 1),
    "Lucario": ("Riolu", 1), "Mega Lucario ex": ("Riolu", 1), "Tatsugiri": ("Tatsugiri", 0),
    "Hisuian Arcanine": ("Hisuian Growlithe", 1),
}
# One Printing per expected name; Machoke's is the Printing whose own evolves from is wrong.
ON_THE_LIST = {"Charmander": 1, "Charmeleon": 2, "Charizard ex": 3, "Machop": 10, "Machoke": 14, "Machamp": 15,
               "Tiemon": 20, "Loopa": 30, "Loopb": 31, "Chainmon Four": 44, "Chainmon Five": 45,
               "Unidentified Fossil": 50, "Omanyte": 51, "Omastar": 52, "Lucario": 61, "Mega Lucario ex": 62,
               "Tatsugiri": 70, "Hisuian Arcanine": 81}


def deck_of_every_card():
    owner = f"roots-{uuid4()}"
    with connect() as conn:
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s)", (owner,))
    deck = create(owner).json()["location"]["id"]
    revision_now = 1
    for number in ON_THE_LIST.values():
        response = add_line(owner, deck, edition_of(f"fixture-evo-{number}"), "1", revision_now)
        assert response.status_code == 200, response.text
        revision_now = response.json()["deck_list"]["revision"]
    return owner, deck


def roots(owner, deck):
    return {line["name"]: (line["evolution_root"], line["evolution_stage"])
            for line in detail(owner, deck)["deck_list"]["lines"]}


def test_each_pokemon_line_carries_the_root_of_its_evolution_line_through_the_whole_catalog():
    seed(*CARDS)
    owner, deck = deck_of_every_card()
    assert roots(owner, deck) == EXPECTED


def test_the_derivation_backfills_roots_without_moving_any_revision_or_format_standing_key():
    seed(*CARDS)
    owner, deck = deck_of_every_card()
    # A catalog derived before migration 043 has no roots: every line reads null, never a wrong line.
    with connect() as conn:
        conn.execute("DELETE FROM catalog_evolution_root")
    assert {root for root, _ in roots(owner, deck).values()} == {None}
    ensure_current()
    with connect() as conn:
        keys = conn.execute("SELECT * FROM catalog_format_standing_key ORDER BY format").fetchall()
    assert [key["format"] for key in keys] == ["expanded", "glc", "standard"]
    before = revision()
    with connect() as conn:
        rederive_card_attributes(conn)  # scripts/derive_card_attributes.py
    assert roots(owner, deck) == EXPECTED
    assert revision() == before
    with connect() as conn:
        assert conn.execute("SELECT * FROM catalog_format_standing_key ORDER BY format").fetchall() == keys


def test_a_vote_for_a_merged_card_identity_counts_for_its_survivor():
    """After a Card Identity merge (migration 037) an ``evolves_from`` name can key the merged-away identity, which no
    Printing points at any more; its vote counts for the survivor, so the line stays one line."""
    # "Rioluu" was a misspelt identity, merged into Riolu; an older Lucario Printing still names it.
    found = evolution_roots({"Riolu": ("Riolu", [None]), "Lucario": ("Lucario", ["Rioluu", "Riolu"])},
                            merged={"Rioluu": "Riolu"})
    assert found["Lucario"] == EvolutionRoot("Riolu", 1)


def test_a_failed_roots_refresh_is_contained_and_leaves_the_callers_transaction_usable(monkeypatch, caplog):
    """The refresh runs in a savepoint: a SQL failure inside it rolls back only the roots work (the stored roots stay),
    is logged, and the caller's earlier writes and later statements in the same transaction still commit."""
    from app.games.pokemon.catalog import evolution_roots as module
    seed(*CARDS)
    owner = f"roots-{uuid4()}"
    with connect() as conn:
        before = conn.execute("SELECT identity_key,root_name,stage FROM catalog_evolution_root ORDER BY identity_key"
                              ).fetchall()
    assert before
    monkeypatch.setattr(module, "WRITE", "INSERT INTO catalog_evolution_root_missing VALUES (1)")
    with connect() as conn:
        with conn.transaction():
            conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s)", (owner,))
            assert module.refresh_evolution_roots(conn) == 0
            # Without the savepoint the transaction is aborted here and this statement raises.
            conn.execute("SELECT 1")
    assert "Evolution roots refresh failed" in caplog.text
    assert caplog.records[-1].exc_info  # the log carries the traceback, not just the exception's name
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM inventory_owner WHERE user_id=%s", (owner,)).fetchone()["n"] == 1
        assert conn.execute("SELECT identity_key,root_name,stage FROM catalog_evolution_root ORDER BY identity_key"
                            ).fetchall() == before


def test_an_uncontained_roots_refresh_raises_and_the_derivation_fails_loudly(monkeypatch):
    """``scripts/derive_card_attributes.py`` exists to rebuild the roots, so its failure must not be swallowed: the
    savepoint is rolled back (the stored roots stay) and the error reaches the caller, which rolls the derivation back."""
    from app.games.pokemon.catalog import evolution_roots as module
    seed(*CARDS)
    with connect() as conn:
        before = conn.execute("SELECT identity_key,root_name,stage FROM catalog_evolution_root ORDER BY identity_key"
                              ).fetchall()
    monkeypatch.setattr(module, "WRITE", "INSERT INTO catalog_evolution_root_missing "
                        "SELECT * FROM unnest(%s::text[],%s::text[],%s::smallint[])")
    with connect() as conn:
        with conn.transaction():
            with pytest.raises(psycopg.errors.UndefinedTable):
                module.refresh_evolution_roots(conn, contain=False)
            conn.execute("SELECT 1")  # the savepoint was rolled back, so the transaction is still usable
    with connect() as conn:
        with pytest.raises(psycopg.errors.UndefinedTable):
            rederive_card_attributes(conn)
    with connect() as conn:
        assert conn.execute("SELECT identity_key,root_name,stage FROM catalog_evolution_root ORDER BY identity_key"
                            ).fetchall() == before
        # The importer's lock was released on the way out, so the next derivation is not "already running".
        monkeypatch.undo()
        rederive_card_attributes(conn)
