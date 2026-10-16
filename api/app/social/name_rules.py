"""What a Handle and a Display Name may be (social network #246, spec "Handles, Invite Links and lookup").

A Handle is 3 to 20 letters, digits and underscores, unique ignoring case. A Display Name is 1 to 40 characters after
NFC normalisation and trimming, with no control, format, private-use, unassigned or line and paragraph separator
characters (which covers the bidirectional controls that could make a name read backwards). Both are refused when they
use a reserved name or a word in ``name_filter_words.txt``. Generated Handles (``collector_`` and 8 characters with no
vowels, migration 100) never pass through here.

The filter compares letters only. The name is decomposed (NFKD), its accents dropped and its case folded; it is read
once as typed and once with the usual digit and symbol stand-ins read as letters ("sh1t"). Its words are the runs of
letters; separators, digits left over and symbols fall away. The refusal is the same whichever list matched, so the
lists can't be probed.
"""
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

WORDS_FILE = Path(__file__).with_name('name_filter_words.txt')
HANDLE = re.compile(r'[A-Za-z0-9_]{3,20}')
DISPLAY_NAME_LENGTH = 40
PLACEHOLDER_DISPLAY_NAME = 'Collector'
# Control, format (bidi controls, zero-width joiners), surrogate, private-use and unassigned characters, and the line
# and paragraph separators.
_REFUSED_CATEGORIES = frozenset({'Cc', 'Cf', 'Cs', 'Co', 'Cn', 'Zl', 'Zp'})
_STAND_INS = str.maketrans({'0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's',
                            '!': 'i'})
_LETTERS = re.compile(r'[a-z]+')
# Names that would pass for PrizeCheck itself, its staff or a system account, compared with the letters only (a Handle
# also drops trailing digits, so "admin_2" is "admin"). Anything containing "prizecheck" is refused as well.
RESERVED = frozenset({
    'abuse', 'admin', 'administrator', 'admins', 'anonymous', 'api', 'auth', 'contact', 'deleted', 'deleteduser',
    'everyone', 'help', 'helpdesk', 'hostmaster', 'info', 'mail', 'mod', 'moderator', 'mods', 'nintendo', 'noreply',
    'null', 'official', 'owner', 'pokemon', 'postmaster', 'root', 'security', 'staff', 'support', 'supportteam',
    'sysadmin', 'system', 'tcgplayer', 'team', 'thepokemoncompany', 'undefined', 'webmaster', 'www',
})
RESERVED_INSIDE = 'prizecheck'


class NameRefused(ValueError):
    """``code`` is the API error code the route answers with 422."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _forms(text: str) -> tuple[str, str]:
    """The name without accents and case, as typed and with stand-ins read as letters."""
    plain = ''.join(c for c in unicodedata.normalize('NFKD', text) if not unicodedata.combining(c)).casefold()
    return plain, plain.translate(_STAND_INS)


@lru_cache(maxsize=1)
def _lists():
    sections: dict[str, set[str]] = {'words': set(), 'inside': set(), 'symbols': set()}
    current = None
    for raw in WORDS_FILE.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('[') and line.endswith(']'):
            current = sections[line[1:-1]]
            continue
        current.add(line)
    words, phrases = set(), set()
    for entry in sections['words']:
        letters = tuple(_LETTERS.findall(_forms(entry)[0]))
        if len(letters) == 1:
            words.add(letters[0])
        elif letters:
            phrases.add(letters)
    inside = tuple(sorted(''.join(_LETTERS.findall(_forms(entry)[0])) for entry in sections['inside']))
    return (frozenset(words), frozenset(phrases), frozenset(''.join(phrase) for phrase in phrases), inside,
            tuple(sorted(sections['symbols'])))


def offensive(text: str) -> bool:
    """Whether the name uses a word, phrase, inside entry or symbol of ``name_filter_words.txt``."""
    words, phrases, joined, inside, symbols = _lists()
    if any(symbol in text for symbol in symbols):
        return True
    for form in _forms(text):
        letters = _LETTERS.findall(form)
        squashed = ''.join(letters)
        if squashed in words or squashed in joined or any(word in words for word in letters):
            return True
        if any(entry in squashed for entry in inside):
            return True
        for phrase in phrases:
            size = len(phrase)
            if any(tuple(letters[start:start + size]) == phrase for start in range(len(letters) - size + 1)):
                return True
    return False


def _reserved(keys) -> bool:
    return any(key in RESERVED or RESERVED_INSIDE in key for key in keys)


def clean_handle(value: str) -> str:
    """The Handle as it will be stored (surrounding spaces dropped, case kept), or NameRefused: INVALID_HANDLE for the
    wrong characters or length, HANDLE_NOT_ALLOWED for a reserved or offensive one."""
    handle = value.strip()
    if not HANDLE.fullmatch(handle):
        raise NameRefused('INVALID_HANDLE')
    keys = [re.sub(r'[0-9]+$', '', form.replace('_', '')) for form in _forms(handle)]
    if _reserved(keys) or offensive(handle):
        raise NameRefused('HANDLE_NOT_ALLOWED')
    return handle


def clean_display_name(value: str) -> str:
    """The Display Name as it will be stored (NFC, trimmed), or NameRefused: INVALID_DISPLAY_NAME for an empty, too
    long or unprintable one, DISPLAY_NAME_NOT_ALLOWED for a reserved or offensive one."""
    name = unicodedata.normalize('NFC', value).strip()
    if not 1 <= len(name) <= DISPLAY_NAME_LENGTH or any(unicodedata.category(c) in _REFUSED_CATEGORIES for c in name):
        raise NameRefused('INVALID_DISPLAY_NAME')
    if _reserved(''.join(_LETTERS.findall(form)) for form in _forms(name)) or offensive(name):
        raise NameRefused('DISPLAY_NAME_NOT_ALLOWED')
    return name
