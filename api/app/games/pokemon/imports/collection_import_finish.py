"""Collection Import finishes (#230; spec "Matching", "Finish table"): which of a card's Editions a row's finish names.

Pure: no database and no network. A finish is a partial Variant Descriptor (Finish): the facets a tracker's words say,
and nothing about the ones they don't. The same rule picks the Edition for every caller: a row at the start of an
import (the finish table, wanted_from_row), a finish the collector picks for one row (one of the row's own Editions)
and a bulk finish (such as {"type": "reverse"}); the last two come through wanted_from_descriptor. choose() answers
an Edition only when exactly one of the card's active Editions fits; anything else is no answer, never a guess.

A Card Edition's descriptor comes in two shapes, and both read the same here:

- TCGdex's variants_detailed: {"type": "normal"|"holo"|"reverse", "subtype": ..., "size": "standard"|"jumbo",
  "stamp": [...], "foil": ...}, often with source lookup IDs ("thirdParty") that are not physical;
- the older variants flags: {"finish": "normal"|"holo"|"reverse"}.

"finish" and "type" are one facet, as are "stamp" and "stamps", and "foil" and "foilPattern"; a standard size is no
size. The Unspecified Variant ({"kind": "unspecified", "label": "Unspecified Variant"}) and a reviewed {"label": ...}
fit only themselves.

The finish table (FINISH_TABLE) has one vocabulary per detected source (collection_import_reader.SOURCES): what its
finish column's words and the card name's (parenthesised) tags say. Each entry cites the research table in
docs/planning/collection-import/wayfinder/research/tracker-export-formats.md, "Finish and variant words against
Variant Descriptor". Words the research marks unconfirmed are left out, and so is anything it never saw a TCGdex
facet for (Cracked Ice Holo, Promo, Prize Pack and other named stamps): those rows are Finish unknown.

- A finish column word the vocabulary doesn't hold makes the whole finish unknown.
- A blank column says nothing (unknown), except PriceCharting's, whose untagged product is its plain card: normal or
  holo, not reverse (PLAIN).
- Name tags add to the column: a tag's type replaces the column's, its stamps join the column's, and its subtype and
  foil replace the column's. A tag the vocabulary doesn't hold is ignored, unless it reads like a stamp (STAMP_HINTS),
  which makes the finish unknown rather than let a stamped card land on its plain Edition.
- A foil pattern (Cosmos Holo, Poke Ball, Master Ball) names the Edition on its own, so it clears the type: TCGdex
  files Cosmos Holo as type reverse on some cards and holo on others, while trackers write "Holofoil" beside it.
- A pasted list (#234) has no finish column: a line's plain finish words are tags (``Dark Golduck (Reverse
  Holofoil)``, as the TCGplayer app's unconfirmed plain-text export is described), read as the loose vocabulary reads
  a finish column.
- Only the TCGplayer app, Collectr and PriceCharting write a 1st Edition word, so only their plain words mean "no
  stamp". The other vocabularies' words leave stamps open (stamps None).
- A subtype (Unlimited's "unlimited", PriceCharting's [1999-2000]) is a preference, not a requirement: among several
  Editions that fit, the one with exactly that subtype (or with none, for a finish without one) wins if it is alone.
"""
import json
import re
import unicodedata
from dataclasses import dataclass, replace

from ..prices.catalog_targets import is_unspecified
from .collection_import_reader import (COLLECTR, DRAGON_SHIELD, LOOSE, PASTE, PRICECHARTING, SORTED, TCG_COLLECTOR,
                                       TCGPLAYER_APP)

# The descriptor keys that describe the physical card (as catalog.PHYSICAL_VARIANT_KEYS, which this module may not
# import), plus the Unspecified Variant's and a reviewed Edition's own keys. Everything else (source lookup IDs such as
# thirdParty, variantId, pricing) is left out of every response.
PHYSICAL_KEYS = ("finish", "type", "subtype", "size", "stamp", "stamps", "foil", "foilPattern")
PUBLIC_KEYS = PHYSICAL_KEYS + ("kind", "label")
PLAIN = "plain"
TYPES = ("normal", "holo", "reverse")


@dataclass(frozen=True)
class Finish:
    # "normal", "holo", "reverse", PLAIN (normal or holo), or None for any type.
    type: str | None = None
    foil: str | None = None
    # The exact stamps, or None for any.
    stamps: frozenset | None = frozenset()
    # Preferred, not required (module docstring).
    subtype: str | None = None
    # None for a standard size.
    size: str | None = None
    # "unspecified" for the Unspecified Variant, "label:<label>" for a reviewed label; the other facets are then unused.
    special: str | None = None


def public_descriptor(descriptor) -> dict:
    """The descriptor with its physical keys only, as every response shows it."""
    if not isinstance(descriptor, dict):
        return {}
    return {key: value for key, value in descriptor.items() if key in PUBLIC_KEYS}


def _text(value) -> str | None:
    """A descriptor's string value, trimmed and case-folded; None for anything else or a blank."""
    if not isinstance(value, str):
        return None
    return value.strip().casefold() or None


def _stamps(value) -> frozenset:
    if value is None:
        return frozenset()
    values = value if isinstance(value, list) else [value]
    return frozenset(item.strip().casefold() if isinstance(item, str) else json.dumps(item, sort_keys=True)
                     for item in values)


def facets(descriptor) -> Finish | None:
    """A descriptor (an Edition's, or one the collector sends) as a Finish; None when it says nothing physical."""
    if not isinstance(descriptor, dict):
        return None
    if is_unspecified(descriptor) or descriptor.get("kind") == "unspecified":
        return Finish(special="unspecified")
    if isinstance(descriptor.get("label"), str) and descriptor["label"].strip():
        return Finish(special="label:" + descriptor["label"].strip())
    size = _text(descriptor.get("size"))
    found = Finish(type=_text(descriptor.get("type")) or _text(descriptor.get("finish")),
                   foil=_text(descriptor.get("foil")) or _text(descriptor.get("foilPattern")),
                   stamps=_stamps(descriptor.get("stamp")) | _stamps(descriptor.get("stamps")),
                   subtype=_text(descriptor.get("subtype")), size=None if size == "standard" else size)
    if found.type is None and found.foil is None and not found.stamps and found.subtype is None and found.size is None:
        return None
    return found


def fits(wanted: Finish, edition: Finish) -> bool:
    if wanted.special or edition.special:
        return wanted.special == edition.special
    if wanted.type == PLAIN:
        if edition.type not in ("normal", "holo"):
            return False
    elif wanted.type is not None and wanted.type != edition.type:
        return False
    return (wanted.foil == edition.foil and wanted.size == edition.size
            and (wanted.stamps is None or wanted.stamps == edition.stamps))


def choose(wanted: Finish | None, editions: list):
    """The one Edition (a row with "descriptor") of `editions` that `wanted` names, or None."""
    if wanted is None:
        return None
    found = [(edition, facets(edition["descriptor"])) for edition in editions]
    candidates = [(edition, its) for edition, its in found if its is not None and fits(wanted, its)]
    if len(candidates) > 1:
        preferred = [(edition, its) for edition, its in candidates if its.subtype == wanted.subtype]
        if preferred:
            candidates = preferred
    return candidates[0][0] if len(candidates) == 1 else None


def wanted_from_descriptor(descriptor) -> Finish | None:
    """A finish the collector sends: exact, so its missing stamps mean "no stamp"; None when it says nothing."""
    return facets(descriptor)


# ---------------------------------------------------------------- the finish table


def word_key(text: str) -> str:
    """A finish word or tag as the table holds it: accents dropped, case-folded, runs of anything but letters and
    digits as one space. "Poké Ball Pattern" is "poke ball pattern", "Non-holo" is "non holo"."""
    plain = "".join(char for char in unicodedata.normalize("NFKD", text) if not unicodedata.combining(char))
    return re.sub(r"[^0-9a-z]+", " ", plain.casefold()).strip()


FIRST = frozenset({"1st-edition"})
NORMAL, HOLO, REVERSE = Finish(type="normal"), Finish(type="holo"), Finish(type="reverse")
COSMOS, POKE_BALL, MASTER_BALL = Finish(foil="cosmos"), Finish(foil="pokeball"), Finish(foil="masterball")
FIRST_EDITION = Finish(stamps=FIRST)
# TCGplayer's and Collectr's Printing/Variance words (research table, columns 2 and 3).
_TCGPLAYER_WORDS = {
    "normal": NORMAL,
    "holofoil": HOLO,
    "reverse holofoil": REVERSE,
    "1st edition": FIRST_EDITION,
    "1st edition holofoil": Finish(type="holo", stamps=FIRST),
    # "Unlimited" on WotC cards: not 1st Edition, and TCGdex's "unlimited" print where there is one.
    "unlimited": Finish(type="normal", subtype="unlimited"),
    "unlimited holofoil": Finish(type="holo", subtype="unlimited"),
}
# Tags in the TCGplayer app's Name and Collectr's Product Name (research table, columns 2 and 3).
_NAME_TAGS = {
    "cosmos holo": COSMOS,
    "poke ball pattern": POKE_BALL,
    "master ball pattern": MASTER_BALL,
    "reverse holo": REVERSE,
    "1st edition": FIRST_EDITION,
}
# Unmapped tags that read like a stamp make the finish unknown (League, Prerelease, Holiday Calendar, Prize Pack, Battle
# Academy and "… Stamped" in the research), matched by whole words.
STAMP_HINTS = ("stamp", "stamped", "league", "prerelease", "staff", "holiday calendar", "prize pack", "battle academy",
               "championship", "championships", "worlds")


def _open_stamps(words: dict) -> dict:
    """The same words with stamps left open, for vocabularies with no 1st Edition word."""
    return {key: finish if finish.stamps else replace(finish, stamps=None) for key, finish in words.items()}


@dataclass(frozen=True)
class Vocabulary:
    # Finish column word (word_key) -> Finish.
    words: dict
    # Name tag (word_key) -> Finish; empty when the source's names carry no finish tags.
    tags: dict
    # What a blank finish column says, or None (unknown).
    blank: Finish | None = None
    # Whether the finish column holds several words joined by ", " (PriceCharting's brackets).
    several: bool = False


# Words any vocabulary below shares when the research shows nothing source-specific: the collector-facing names, which
# a CSV from another app or a spreadsheet would use.
_PLAIN_WORDS = {
    "normal": NORMAL, "non holo": NORMAL, "holo": HOLO, "holofoil": HOLO, "reverse holo": REVERSE,
    "reverse holofoil": REVERSE, "1st edition": FIRST_EDITION, "1st edition holo": Finish(type="holo", stamps=FIRST),
    "1st edition holofoil": Finish(type="holo", stamps=FIRST),
    "unlimited": Finish(type="normal", subtype="unlimited"),
    "unlimited holo": Finish(type="holo", subtype="unlimited"),
    "unlimited holofoil": Finish(type="holo", subtype="unlimited"), "cosmos holo": COSMOS,
    "poke ball pattern": POKE_BALL, "poke ball reverse holo": POKE_BALL, "master ball pattern": MASTER_BALL,
}

FINISH_TABLE = {
    # Printing; tags in Name (Simple Name drops them).
    TCGPLAYER_APP: Vocabulary(words=_TCGPLAYER_WORDS, tags=_NAME_TAGS),
    # Variance, including its pattern words; tags in Product Name.
    COLLECTR: Vocabulary(words={**_TCGPLAYER_WORDS, "poke ball reverse holo": POKE_BALL}, tags=_NAME_TAGS),
    # The [bracketed] words the reader moved to finish; an untagged product is the plain card.
    PRICECHARTING: Vocabulary(words={"holo": HOLO, "reverse holo": REVERSE, "1st edition": FIRST_EDITION,
                                     "cosmos holo": COSMOS,
                                     "1999 2000": Finish(type=PLAIN, subtype="1999-2000-copyright")},
                              tags={}, blank=Finish(type=PLAIN), several=True),
    # Card variant. No 1st Edition word was seen, so stamps stay open.
    TCG_COLLECTOR: Vocabulary(words=_open_stamps({"normal": NORMAL, "non holo": NORMAL, "holo": HOLO,
                                                  "normal holo": HOLO, "reverse holo": REVERSE,
                                                  "cosmos holo": COSMOS}), tags={}),
    # Printing: only "Normal" is confirmed for Pokémon cards.
    DRAGON_SHIELD: Vocabulary(words=_open_stamps({"normal": NORMAL}), tags={}),
    SORTED: Vocabulary(words=_open_stamps({"normal": NORMAL}), tags={}),
    # Any other app's finish column, and tags in its name column.
    LOOSE: Vocabulary(words=_open_stamps(_PLAIN_WORDS), tags=_NAME_TAGS),
    # A pasted list's lines (#234): no finish column, and the loose words as tags.
    PASTE: Vocabulary(words={}, tags={**_open_stamps(_PLAIN_WORDS), **_NAME_TAGS}),
}


def _merge(base: Finish | None, tag: Finish) -> Finish:
    if base is None:
        return tag
    stamps = base.stamps
    if tag.stamps:
        stamps = tag.stamps if base.stamps is None else base.stamps | tag.stamps
    return Finish(type=tag.type or base.type, foil=tag.foil or base.foil, stamps=stamps,
                  subtype=tag.subtype or base.subtype, size=base.size)


def _stamp_like(key: str) -> bool:
    padded = f" {key} "
    return any(f" {hint} " in padded for hint in STAMP_HINTS)


def wanted_from_row(source: str, fields: dict) -> Finish | None:
    """What a source row's finish column and name tags say (the module docstring's rules), or None when unknown."""
    vocabulary = FINISH_TABLE.get(source, FINISH_TABLE[LOOSE])
    column = fields.get("finish", "").strip()
    words = [part for part in column.split(", ") if part.strip()] if vocabulary.several else [column] if column else []
    wanted = None if words else vocabulary.blank
    for word in words:
        finish = vocabulary.words.get(word_key(word))
        if finish is None:
            return None
        wanted = _merge(wanted, finish)
    if vocabulary.tags:
        for tag in re.findall(r"\(([^()]*)\)", fields.get("name", "")):
            key = word_key(tag)
            if key in vocabulary.tags:
                wanted = _merge(wanted, vocabulary.tags[key])
            elif _stamp_like(key):
                return None
    if wanted is not None and wanted.foil:
        wanted = replace(wanted, type=None)
    return wanted
