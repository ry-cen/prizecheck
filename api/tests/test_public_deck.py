"""public_deck's reference-proof rule (tickets 12 to 14), without a database."""
from dataclasses import replace

from app.main import app  # noqa: F401  (main first: it includes every router while loading)
from app.public_deck import FrozenRow, same_printing


def test_same_printing_proves_only_a_frozen_pair_whose_edition_record_names_the_frozen_printing():
    row = FrozenRow("Furret", "swsh3", "Darkness Ablaze", "136", {"finish": "normal"}, None, 1, "a" * 48, "b" * 48)
    assert same_printing(row, "b" * 48)
    assert not same_printing(row, "c" * 48) and not same_printing(row, None)
    legacy = replace(row, edition_ref=None, printing_ref=None)
    assert not same_printing(legacy, None) and not same_printing(legacy, "b" * 48)
    assert not same_printing(replace(row, printing_ref=None), None)
