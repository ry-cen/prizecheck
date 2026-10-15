"""Read a pasted decklist (Decklist Import, spec "Decklist text parsing"; research "decklist text formats").

One pure module: no database, no I/O. The review route (``deck_import``) sends the pasted text here and draws what comes
back, so the grammar lives in one place. Tested through ``POST /api/decks/import/review`` on the nine research
fixtures (``api/tests/test_deck_import.py``); there are no parser unit tests.

Normalising, per line:

- LF, CRLF and CR all end a line; a leading byte order mark is dropped;
- zero-width characters (U+200B, U+200C, U+200D, U+2060, U+FEFF) are removed and no-break spaces (U+00A0, U+202F) read
  as spaces;
- NFC normalisation; trailing spaces are dropped;
- a curly apostrophe (U+2019, U+2018) reads as ``'``;
- ``normalise`` is the zero-width, no-break space, NFC and apostrophe steps, without stripping; Collection Import reads
  every cell of an uploaded file through it too (``collection_import_reader.normalise_cell``). A line's display text
  (``_display``) keeps curly apostrophes;
- an optional ``* `` bullet (TCG Online) is dropped;
- TCG Online's empty-set Energy line (``20 Water Energy  12``: two spaces before the number) is recognised before
  repeated spaces collapse, because collapsed it would read like the ``Energy N`` pseudo-set.

Line kinds:

- **blank:** nothing left after normalising. Not reported.
- **header:** ``Pokémon``/``Pokemon``, ``Trainer``, ``Trainer Cards``, ``Energy`` or ``Energie`` (any case, an optional
  ``##`` before it), then ``:`` or ``-`` and an optional number. It starts a section. Its number is never read: TCG
  Live counts lines and Limitless counts cards. Not reported.
- **card:** a quantity (1 to 999, no leading zero) and a space, then, read from the right: an optional ``PH``, the
  number (up to four letters, digits, an optional letter: ``185``, ``SM62``, ``TG05``, ``152a``), the set token
  (two to eight capitals or digits, optionally ``-`` and two to four more: ``PAL``, ``PR-SV``, ``CRZ-GG``; or
  ``Energy`` after a name ending in Energy) and the name, which is everything left and never empty.
- **Can't read:** a quantity, but no set token and number after the name (``4 Iono``). ``set_code`` and ``number``
  are None.
- **ignored:** any other line (prose, ``Total Cards: 60``, ``Karten insgesamt: 60``, ``******`` lines). Reported, so the
  collector can check them.

Totals are worked out from the lines by the caller, never from headers.
"""
import re
import unicodedata
from dataclasses import dataclass
from typing import Literal

# The most characters a paste may have (422 IMPORT_TOO_LONG), counted before any normalising.
MAX_TEXT_CHARACTERS = 20_000
# The most card lines (Can't read lines included) a paste may have (422 IMPORT_TOO_MANY_LINES): the Deck List batch
# limit (decks.MAX_DECK_LIST_CHANGES).
MAX_CARD_LINES = 200

Section = Literal['pokemon', 'trainer', 'energy']

_LINE_BREAK = re.compile(r'\r\n|\r|\n')
_INVISIBLE = dict.fromkeys(map(ord, '​‌‍⁠﻿'))
_SPACES = {ord(' '): ' ', ord(' '): ' '}
_APOSTROPHES = {ord('’'): "'", ord('‘'): "'"}
_HEADER = re.compile(r'(?:##\s*)?(pok[eé]mon|trainer cards|trainer|energy|energie)\s*[:\-]\s*\d*', re.IGNORECASE)
_SECTIONS: dict[str, Section] = {'pokémon': 'pokemon', 'pokemon': 'pokemon', 'trainer': 'trainer',
                                 'trainer cards': 'trainer', 'energy': 'energy', 'energie': 'energy'}
_QUANTITY = r'[1-9][0-9]{0,2}'
_NUMBER = re.compile(r'[A-Za-z]{0,4}[0-9]+[A-Za-z]?')
_SET = re.compile(r'[A-Z0-9]{2,8}(?:-[A-Z0-9]{2,4})?')
_EMPTY_SET_ENERGY = re.compile(rf'({_QUANTITY}) (\S.*Energy) {{2}}({_NUMBER.pattern})', re.IGNORECASE)
_CARD = re.compile(rf'({_QUANTITY}) (.+)')


class TooLong(ValueError):
    """The text has more than MAX_TEXT_CHARACTERS characters."""


class TooManyLines(ValueError):
    """The text has more than MAX_CARD_LINES card lines."""


@dataclass(frozen=True)
class CardLine:
    line: int                  # 1-based line number in the pasted text (blank lines count)
    text: str                  # the line as pasted, normalised for display (see ``_display``)
    section: Section | None    # the last header above it; None before any header
    quantity: int
    name: str                  # the pasted name; for a Can't read line, everything after the quantity
    set_code: str | None       # the pasted set token; '' for the empty-set Energy line; None when Can't read
    number: str | None         # the pasted number; None when Can't read
    ph: bool                   # a trailing PH was pasted (ignored when choosing; kept for display)

    @property
    def readable(self) -> bool:
        return self.set_code is not None


@dataclass(frozen=True)
class IgnoredLine:
    line: int
    text: str


@dataclass(frozen=True)
class Reading:
    cards: tuple[CardLine, ...]
    ignored: tuple[IgnoredLine, ...]


def _clean(raw: str) -> str:
    """Invisible characters removed, no-break spaces as spaces, NFC."""
    return unicodedata.normalize('NFC', raw.translate(_INVISIBLE).translate(_SPACES))


def normalise(text: str) -> str:
    """Text as decklist import reads it: zero-width characters (U+200B, U+200C, U+200D, U+2060, U+FEFF) removed,
    no-break spaces (U+00A0, U+202F) as spaces, NFC, and curly apostrophes (U+2019, U+2018) as ``'``. Nothing is
    stripped. Collection Import reads every cell through it (collection_import_reader.normalise_cell)."""
    return _clean(text).translate(_APOSTROPHES)


def _display(raw: str) -> str:
    """The line as the review shows it: invisible characters removed, no-break spaces as spaces, NFC, no trailing
    spaces. A bullet, doubled spaces, curly apostrophes and PH are kept, as pasted."""
    return _clean(raw).rstrip()


def _card(number: int, display: str, work: str, section: Section | None) -> CardLine | None:
    """A card or Can't read line, or None when the line doesn't start with a quantity."""
    empty_set = _EMPTY_SET_ENERGY.fullmatch(work)
    if empty_set:
        quantity, name, card_number = empty_set.groups()
        return CardLine(number, display, section, int(quantity), ' '.join(name.split()), '', card_number, False)
    work = ' '.join(work.split())
    match = _CARD.fullmatch(work)
    if not match:
        return None
    quantity, rest = int(match.group(1)), match.group(2)
    tokens = rest.split(' ')
    ph = len(tokens) >= 4 and tokens[-1] == 'PH'
    body = tokens[:-1] if ph else tokens
    if (len(body) >= 3 and _NUMBER.fullmatch(body[-1])
            and (_SET.fullmatch(body[-2]) or (body[-2] == 'Energy' and body[-3].casefold().endswith('energy')))):
        return CardLine(number, display, section, quantity, ' '.join(body[:-2]), body[-2], body[-1], ph)
    return CardLine(number, display, section, quantity, rest, None, None, False)


def read(text: str) -> Reading:
    """Every card, Can't read and ignored line of ``text``, in paste order. Raises TooLong or TooManyLines."""
    if len(text) > MAX_TEXT_CHARACTERS:
        raise TooLong()
    if text.startswith('﻿'):
        text = text[1:]
    cards: list[CardLine] = []
    ignored: list[IgnoredLine] = []
    section: Section | None = None
    for number, raw in enumerate(_LINE_BREAK.split(text), 1):
        display = _display(raw)
        work = normalise(raw).strip()
        if not work:
            continue
        if work.startswith('* '):
            work = work[2:].lstrip()
        header = _HEADER.fullmatch(' '.join(work.split()))
        if header:
            section = _SECTIONS[header.group(1).casefold()]
            continue
        card = _card(number, display, work, section)
        if card is None:
            ignored.append(IgnoredLine(number, display))
            continue
        cards.append(card)
        if len(cards) > MAX_CARD_LINES:
            raise TooManyLines()
    return Reading(tuple(cards), tuple(ignored))
