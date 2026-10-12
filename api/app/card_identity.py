"""Card Identity key: the English name with ASCII apostrophes and no trailing parenthetical subtitle.

"Professor's Research (Professor Juniper)" and "Professor's Research (Professor Magnolia)" are one
Card Identity, "Professor's Research"; "Professor\u2019s Letter" and "Professor's Letter" are one Card
Identity, "Professor's Letter". Migration 028's catalog_card_identity_key() is the SQL twin of this
function; api/tests/test_card_identity.py checks that the two agree.
"""
import re

# Typographic apostrophes fold to ASCII: U+2018, U+2019 (the only one in TCGdex names) and U+02BC.
_APOSTROPHES = str.maketrans({"\u2018": "'", "\u2019": "'", "\u02bc": "'"})
_TRAILING_SUBTITLE = re.compile(r" \([^()]+\)\Z")


def card_identity_key(name: str) -> str:
    """Key and display name of the Card Identity for an already normalized English name.

    Folds typographic apostrophes to ASCII, then removes one trailing " (...)" group with no nested
    parentheses. A name that is nothing but a parenthetical keeps it. Callers pass names already
    normalized to NFC with single spaces.
    """
    folded = name.translate(_APOSTROPHES)
    stripped = _TRAILING_SUBTITLE.sub("", folded, count=1)
    return stripped or folded
