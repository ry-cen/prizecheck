"""Close spellings for Catalog's name search (api/app/name_search.py): pure functions over names the database has
already normalized (catalog_search_words, migration 048)."""
from app.games.pokemon.catalog.name_search import FUZZY_MIN_LENGTH, close_names, edits_allowed, near_prefix


def test_edits_allowed_grow_with_the_word():
    assert [edits_allowed("x" * size) for size in (1, 4, 5, 8, 9, 20)] == [0, 0, 1, 1, 2, 2]


def test_near_prefix_counts_insertions_deletions_substitutions_and_swaps():
    assert near_prefix("charzard", "charizard", 1)  # a letter left out
    assert near_prefix("gardivoir", "gardevoir", 2)  # a letter changed
    assert near_prefix("zubta", "zubat", 1)  # two neighbours swapped
    assert near_prefix("charz", "charizard", 1)  # the start of a longer word
    assert not near_prefix("charzard", "chatot", 1)
    assert near_prefix("char", "charizard", 0) and not near_prefix("char", "chatot", 0)
    assert not near_prefix("pikachu", "pi", 1)


def test_close_names_needs_every_word_near_a_word_of_the_name_and_keeps_the_order_given():
    names = ["chatot", "charizard ex", "charmander", "charizard", "radiant charizard"]
    assert close_names("charzard", names) == ["charizard ex", "charizard", "radiant charizard"]
    assert close_names("radiant charzard", names) == ["radiant charizard"]
    assert close_names("profesor juniper", ["professors research professor juniper", "professor oak"]) == [
        "professors research professor juniper"]
    assert close_names("bossorders", ["bosss orders", "boss"]) == ["bosss orders"]  # the whole name run together


def test_short_queries_never_reach_close_spellings():
    assert FUZZY_MIN_LENGTH == 5
    assert close_names("char", ["chatot", "charizard"]) == []
    assert close_names("ch at", ["chatot"]) == []  # four letters across two words
    assert close_names("", ["chatot"]) == []
