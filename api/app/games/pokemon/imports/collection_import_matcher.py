"""Collection Import matching (#226, #228 to #232; spec "Matching"): each source row to one Card Edition of the
active catalog, after the filters leave out the rows PrizeCheck can't hold.

**Filters first (#231).** A row gets the first of these reasons that applies (``left_out_reason``), is never matched,
and is stored with it (``collection_import_row.left_out_reason``): never listed, counted as ready or needing the
collector, skipped or saved, but counted under Left out and downloadable.

- ``watchlist``: the watchlist flag (Collectr's ``Watchlist`` is ``true``): a watched card, not a copy.
- ``other_game``: a game column (Collectr's ``Category``, PriceCharting's console, Sorted's ``Collection``, a loose
  ``Category`` or ``Game``) that isn't Pokémon (POKEMON_GAMES).
- ``not_english``: a language column that isn't English (ENGLISH, by its first word, so "English (US)", "en-GB",
  "ENG." and "English/Japanese" stay; PriceCharting's Japanese and Chinese consoles fill it), a ``(JP)`` or ``(CN)``
  tag in the name, or, from Dragon Shield or Sorted, a set that exists only in Japan (JAPAN_ONLY_SETS), which Dragon
  Shield labels English.
- ``sealed``: a row with no number, unless its name is a Basic Energy, whose name is a sealed product's
  (SEALED_NAME), or whose rarity is blank in a file with both a number and a rarity column, unless its name ends in
  Energy. A file without both (PriceCharting, Dragon Shield, most loose files) never has a blank rarity that means
  anything.

Graded rows are not filtered: the grade is read and never kept, so a slab is an ordinary copy.

A Printing counts only when it isn't withdrawn and has an active Card Edition in the active generation. A row whose
quantity can't be read is unreadable. Otherwise the first step that answers wins:

1. **TCGplayer product ID** (``product_id``, digits): the Printing of a verified Marketplace Mapping with that product
   (``catalog_edition_metadata``), else the Printing whose TCGdex lookup IDs list it (``thirdParty.tcgplayer`` in an
   Edition's ``mapping_candidate``, which the catalog import keeps for the card or the variant). It answers only when
   it names exactly one Printing; a product ID nothing names goes on to the next step.
2. **Set and number** (``collection_import_aliases``): each of the row's number readings in its sets, the printed set
   code table's sets first for Dragon Shield, Sorted and a pasted list, then, for a pasted list (#234), decklist
   import's alias table and rules (``import_aliases.readings``: ``SVE``, ``PR-SV``, ``BRS-TG 5``), then its set name's
   (the alias table, else naive normalisation, every tracker's entries for a pasted list), then the era's promo set
   for a promo-prefixed number. The first reading that finds a Printing
   answers: one Printing is the row's card; several (two sets of one name) are ``ambiguous``, with them as candidates.
   A row whose name is a Basic Energy takes this answer only when it is a Basic Energy of that type: the TCGplayer app
   writes Scarlet & Violet Basic Energy as "SV01: Scarlet & Violet Base Set" 008, which is Scatterbug there.
3. **Basic Energy by type** (``import_energy_matching.basic_energy_printings``, as decklist import): a row whose card
   name is a Basic Energy in any spelling ("Basic Water Energy", "Water Energy") gets that type's Printing in the row's
   own sets if one has it, else the newest. Every Basic Energy Printing of the type is kept as candidates (up to
   MAX_CANDIDATES, the chosen one first), for the review's Change.
4. **Name within the row's set** (``import_name_matching.named_printings``, decklist import's name comparison with
   optional parenthetical subtitles): the row's card name (``card_name``, without the tracker's tags) among the
   Printings of its sets (step 2's code and name sets). One Printing is the row's card, ``by_name``; several are
   ``ambiguous``, with them as candidates; none goes on to step 5, so a Printing is never guessed from another set. A
   row whose set names no set this catalog holds (blank, a catch-all such as "Miscellaneous Cards & Products", or a
   set the catalog lacks) is ``ambiguous`` with every Printing of that name as candidates, newest first, even one.
5. Otherwise the row is ``not_found``, or ``unreadable`` when it has no number and no name to match by.

Once a step names the Printing, its Edition: a Printing with one Edition gets it whatever the row's finish says (the
single-Edition shortcut). Otherwise the Edition the row's finish names (collection_import_finish, by the detected
source's finish table) is matched; when it names none, or several fit, the Unspecified Variant is finish_unknown, and a
card with no Unspecified Variant is ambiguous, with the Printing and no Edition, until the collector picks its finish
(or skips the row). The catalog gives most modern cards no Unspecified Variant: TCGdex lists their finishes exactly.
A row matched by name whose finish chooses an Edition stays ``by_name``; Finish unknown and a finish to pick win over
it.

A handful of batched queries answer every row of a file. Pure SQL reads: nothing here writes, reads prices or starts a
catalog pull.
"""
import re
import unicodedata
from dataclasses import dataclass, field
from uuid import UUID

from . import collection_import_aliases as aliases
from . import collection_import_finish as finishes
from . import import_aliases
from ..catalog.set_codes import sets_for_code
from ..prices.catalog_targets import is_unspecified
from .collection_import_reader import DRAGON_SHIELD, LOOSE, PASTE, SORTED
from .import_energy_matching import basic_energy_printings, energy_type
from app.games.pokemon.imports.import_match_core import at_code_and_number
from .import_name_matching import named_printings

MAX_QUANTITY = 2**63 - 1
# The most candidates a row keeps (Pick one, or a Basic Energy's Change).
MAX_CANDIDATES = 20
READY = ("matched", "finish_unknown", "by_name")
NEEDS_YOU = ("ambiguous", "not_found", "unreadable")
STATUSES = READY + NEEDS_YOU
# Row predicates over collection_import_row, for an alias: READY_ROW.format(r="r"). A skipped or left-out row (#231)
# is neither ready nor needs the collector, and a row in a group the collector left out (#232) is in none of them.
# A row is in no group, or in one that isn't among its draft's collection_import.excluded_groups (#232).
INCLUDED_ROW = ("({r}.group_name IS NULL OR NOT EXISTS (SELECT 1 FROM collection_import draft "
                "WHERE draft.id={r}.import_id AND draft.excluded_groups @> jsonb_build_array({r}.group_name)))")
READY_ROW = ("{r}.status IN ('matched','finish_unknown','by_name') AND NOT {r}.skipped "
             "AND {r}.left_out_reason IS NULL AND " + INCLUDED_ROW)
NEEDS_YOU_ROW = ("{r}.status IN ('ambiguous','not_found','unreadable') AND NOT {r}.skipped "
                 "AND {r}.left_out_reason IS NULL AND " + INCLUDED_ROW)
FINISH_UNKNOWN_ROW = ("{r}.status='finish_unknown' AND NOT {r}.skipped AND {r}.left_out_reason IS NULL AND "
                      + INCLUDED_ROW)
# Every row the review lists under All: ready or needing the collector.
LISTED_ROW = "NOT {r}.skipped AND {r}.left_out_reason IS NULL AND " + INCLUDED_ROW
SKIPPED_ROW = "{r}.skipped AND {r}.left_out_reason IS NULL AND " + INCLUDED_ROW
# A row the filters left out (#231), whatever else it is, unless its group is left out too.
LEFT_OUT_ROW = "{r}.left_out_reason IS NOT NULL AND " + INCLUDED_ROW
# The row's card came from step 4 (parsed holds BY_NAME_KEY, whatever its finish says); a collector's pick clears it.
BY_NAME_KEY = "matched_by_name"
BY_NAME_ROW = ("{r}.status IN ('matched','finish_unknown','by_name') AND {r}.parsed->>'matched_by_name'='1' "
               "AND NOT {r}.skipped AND {r}.left_out_reason IS NULL AND " + INCLUDED_ROW)
# The rows route's filters, which a change's `filter` selects by too.
FILTER_ROWS = {"needs": NEEDS_YOU_ROW, "finish": FINISH_UNKNOWN_ROW, "name": BY_NAME_ROW, "all": LISTED_ROW,
               "skipped": SKIPPED_ROW}
PRODUCT_ID = re.compile(r"[1-9][0-9]{0,17}")

# The filters' reasons (#231), in the order they are tried: a row gets the first that applies.
LEFT_OUT_REASONS = ("watchlist", "other_game", "not_english", "sealed")
# A game column's words for Pokémon, compared by plain(): Collectr's and PriceCharting's "Pokemon", Sorted's "pok".
POKEMON_GAMES = frozenset({"pokemon", "pok", "ptcg", "pokemon tcg", "pokemon trading card game"})
# A language column's words for English, compared by plain(): "English" (the TCGplayer app, TCG Collector, Dragon
# Shield), "en" (Sorted). A blank language is English, and so is any whose first word is one of these: "English (US)",
# "en-GB".
ENGLISH = frozenset({"english", "en", "eng"})
# A card name ending in Energy (Double Turbo Energy, Basic or special): a blank rarity doesn't make it sealed.
ENERGY_NAME = re.compile(r"\benergy$")
# Collectr's name tags for Japanese and Chinese cards.
LANGUAGE_TAG = re.compile(r"\((?:JP|CN)\)", re.IGNORECASE)
# Dragon Shield's sets that exist only in Japan, which its export labels English (research "Dragon Shield and Sorted",
# fixture D1), by its set code and by its set name, compared by plain(). Sorted, its successor, uses the same codes.
JAPAN_ONLY_SETS = {"s2": "rebellion crash", "s4a": "shiny star v", "s5i": "single strike master"}
# A sealed product's name: boxes, packs, bundles, collections, tins, blisters, theme decks and kits. Only a row with no
# number is tested, so a card such as Tinkaton or Booster Energy Capsule is never caught.
SEALED_NAME = re.compile(r"\b(?:booster (?:box|pack|bundle|display|case)|sleeved booster|elite trainer box|etb|"
                         r"collection|tin|blister|(?:theme|battle|starter) deck|trainer kit|build (?:&|and) battle|"
                         r"gift box)\b", re.IGNORECASE)

# A Printing's active Editions in the generation, in catalog order (as catalog search shows them).
EDITIONS = """SELECT ge.printing_id,e.id AS edition_id,e.descriptor
  FROM catalog_generation_edition ge JOIN catalog_edition e ON e.id=ge.edition_id
  JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
    AND NOT gp.tombstoned
  WHERE ge.generation_id=%s AND ge.active AND ge.printing_id=ANY(%s::uuid[])
  ORDER BY ge.printing_id,e.descriptor_key,e.id"""
# The Printings a product ID names in the generation, with how: a verified Marketplace Mapping, or TCGdex's lookup ID.
PRODUCTS = """SELECT DISTINCT m.product_id::text AS product,ge.printing_id,true AS verified
  FROM catalog_edition_metadata m
  JOIN catalog_generation_edition ge ON ge.edition_id=m.edition_id AND ge.generation_id=%s AND ge.active
  JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
    AND NOT gp.tombstoned
  WHERE m.mapping_state='verified' AND m.product_id=ANY(%s::bigint[])
  UNION
  SELECT DISTINCT m.mapping_candidate->'candidate'->'thirdParty'->>'tcgplayer',ge.printing_id,false
  FROM catalog_edition_metadata m
  JOIN catalog_generation_edition ge ON ge.edition_id=m.edition_id AND ge.generation_id=%s AND ge.active
  JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
    AND NOT gp.tombstoned
  WHERE m.mapping_candidate->'candidate'->'thirdParty'->>'tcgplayer'=ANY(%s::text[])"""


@dataclass(frozen=True)
class RowMatch:
    status: str
    # None when the row's quantity can't be read.
    quantity: int | None
    printing_id: UUID | None
    edition_id: UUID | None
    # Pick one: the Printings to choose from. A Basic Energy matched by type: its type's Printings, the chosen first.
    candidates: tuple = field(default_factory=tuple)
    # The card came from step 4, the row's name within its set, whatever the finish then said (#229).
    by_name: bool = False
    # Why the filters left the row out (#231), or None. A left-out row is never matched: it is stored not_found, with
    # no card.
    left_out: str | None = None


def _by_name(found: list, sets: set) -> tuple | None:
    """Step 4's answer, (Printing or None, candidates), from the Printings of the row's name (newest first) and the
    row's sets; None when its sets hold none of them."""
    printings = list(dict.fromkeys(row["printing_id"] for row in found if not sets or row["set_id"] in sets))
    if not printings:
        return None
    if sets and len(printings) == 1:
        return printings[0], ()
    return None, tuple(printings[:MAX_CANDIDATES])


def quantity_of(text: str) -> int | None:
    """A blank quantity is one copy; otherwise ASCII digits from 1 to MAX_QUANTITY, or None."""
    text = text.strip()
    if not text:
        return 1
    if not text.isascii() or not text.isdecimal() or len(text) > 19:
        return None
    value = int(text)
    return value if 1 <= value <= MAX_QUANTITY else None


def card_name(fields: dict) -> str:
    """The row's card name without a tracker's tags: the TCGplayer app's Simple Name, else the name with its (…) and
    […] tags and a trailing " - <number>" removed ("Raichu GX - 20/68 (#60 Pikachu Stamped)" is "Raichu GX")."""
    # web/src/collectionImport/importText.ts searchStart repeats this clean-up; change both together.
    text = fields.get("simple_name") or fields.get("name") or ""
    text = re.sub(r"\([^()]*\)|\[[^\]]*\]", " ", text)
    text = re.sub(r"\s+-\s+\S*[0-9]\S*\s*$", " ", text)
    return " ".join(text.split())


def usable_name(name: str) -> bool:
    return any(char.isalnum() for char in name)


def plain(text: str) -> str:
    """A cell as the filters compare it: without accents, case-folded, words joined by single spaces ("Pokémon" is
    "pokemon", "en_US" is "en us")."""
    decomposed = unicodedata.normalize("NFKD", text)
    letters = "".join(char for char in decomposed if not unicodedata.combining(char))
    return " ".join(re.sub(r"[_\-]+", " ", letters).casefold().split())


def left_out_reason(fields: dict, source: str, columns=frozenset()) -> str | None:
    """Why the filters leave this row out (the module docstring's first list), or None to match it. `columns` are the
    FIELDS the file has a column for (collection_import_reader.SourceFile.columns)."""
    if fields["watchlist"] == "true":
        return "watchlist"
    game = plain(fields["category"])
    if game and game not in POKEMON_GAMES:
        return "other_game"
    language = plain(fields["language"])
    if language and next(filter(None, re.split(r"[^a-z]+", language)), "") not in ENGLISH:
        return "not_english"
    if LANGUAGE_TAG.search(fields["name"]):
        return "not_english"
    if source in (DRAGON_SHIELD, SORTED) and (
            plain(fields["set_code"]) in JAPAN_ONLY_SETS
            or plain(fields["set_name"]) in JAPAN_ONLY_SETS.values()):
        return "not_english"
    if not fields["number"].strip() and not energy_type(card_name(fields)):
        blank_rarity = ("number" in columns and "rarity" in columns and not fields["rarity"].strip()
                        and not ENERGY_NAME.search(plain(card_name(fields))))
        if SEALED_NAME.search(fields["name"]) or blank_rarity:
            return "sealed"
    return None


def editions_of(conn, generation: UUID | None, printing_ids) -> dict:
    """Printing -> its active Editions in `generation` (rows with edition_id and descriptor), in catalog order."""
    wanted = sorted({printing for printing in printing_ids if printing is not None}, key=str)
    editions: dict = {}
    if wanted and generation is not None:
        for edition in conn.execute(EDITIONS, (generation, wanted)):
            editions.setdefault(edition["printing_id"], []).append(edition)
    return editions


def edition_for(source: str, fields: dict, choices: list) -> tuple[str, UUID | None]:
    """(status, Edition) for a row whose Printing has these active Editions (module docstring, last paragraph)."""
    chosen = choices[0] if len(choices) == 1 else finishes.choose(finishes.wanted_from_row(source, fields), choices)
    if chosen is not None:
        return "matched", chosen["edition_id"]
    unspecified = [choice for choice in choices if is_unspecified(choice["descriptor"])]
    if unspecified:
        return "finish_unknown", unspecified[0]["edition_id"]
    return "ambiguous", None


def _products(conn, generation: UUID, rows: list) -> dict[int, UUID]:
    """Row index -> the one Printing its product ID names (step 1)."""
    wanted = {index: row.fields["product_id"].strip() for index, row in enumerate(rows)
              if PRODUCT_ID.fullmatch(row.fields["product_id"].strip())}
    if not wanted:
        return {}
    products = sorted(set(wanted.values()))
    verified: dict[str, set] = {}
    listed: dict[str, set] = {}
    for hit in conn.execute(PRODUCTS, (generation, [int(product) for product in products], generation, products)):
        (verified if hit["verified"] else listed).setdefault(hit["product"], set()).add(hit["printing_id"])
    found = {}
    for index, product in wanted.items():
        printings = verified.get(product) or listed.get(product) or set()
        if len(printings) == 1:
            found[index] = next(iter(printings))
    return found


def _row_sets(row, source: str, sets: aliases.GenerationSets) -> tuple[list[str], list[str]]:
    """(the printed set code table's sets, the set name's sets) of a row, each only sets this generation holds."""
    code = row.fields["set_code"].strip()
    by_code = [set_id for set_id in sets_for_code(code) if set_id in sets.ids] \
        if code and source in (DRAGON_SHIELD, SORTED, PASTE) else []
    return by_code, aliases.sets_for_name(LOOSE if source == PASTE else source, row.fields["set_name"], sets)


def _pasted(row, source: str, sets: aliases.GenerationSets) -> list[tuple[tuple[str, ...], str]]:
    """A pasted line's set code and number through decklist import's alias table and rules (#234), as step 2's
    (sets, number) attempts, each with only sets this generation holds; [] for a file's row."""
    code, number = row.fields["set_code"].strip(), row.fields["number"].strip()
    if source != PASTE or not code or not number:
        return []
    found = []
    for reading in import_aliases.readings(code, number):
        held = tuple(set_id for set_id in reading.sets if set_id in sets.ids)
        if held:
            found.append((held, reading.number))
    return found


def _attempts(by_code: list[str], by_name: list[str], readings: list[str],
              pasted: list[tuple[tuple[str, ...], str]]) -> list[tuple[tuple[str, ...], str]]:
    """Where step 2 looks for a row, in order: (sets, number)."""
    found = [(tuple(by_code), number) for number in readings if by_code]
    found += pasted
    found += [(tuple(by_name), number) for number in readings if by_name]
    found += [((aliases.promo_set(number),), number) for number in readings if aliases.promo_set(number)]
    return found


def match(conn, generation: UUID, rows: list, source: str, columns=frozenset()) -> list:
    """One RowMatch per source row (reader.SourceRow), in order, against `generation`; `source` is the detected
    source, whose alias entries and finish table read the row, and `columns` the FIELDS its file has a column for. The
    filters run first: a row they leave out is not matched, so it costs no lookup."""
    reasons = [left_out_reason(row.fields, source, columns) for row in rows]
    kept = iter(_match(conn, generation, [row for row, reason in zip(rows, reasons) if reason is None], source))
    return [next(kept) if reason is None else
            RowMatch("not_found", quantity_of(row.fields["quantity"]), None, None, left_out=reason)
            for row, reason in zip(rows, reasons)]


def _match(conn, generation: UUID, rows: list, source: str) -> list:
    """match() for the rows the filters keep."""
    sets = aliases.generation_sets(conn, generation)
    quantities = [quantity_of(row.fields["quantity"]) for row in rows]
    names = [card_name(row.fields) for row in rows]
    readings = [aliases.number_readings(row.fields["number"]) for row in rows]
    row_sets = [_row_sets(row, source, sets) for row in rows]
    pasted = [_pasted(row, source, sets) for row in rows]
    # Every set a row names, by code, alias or name: steps 3 and 4 look in them.
    own_sets = [{*by_code, *by_name, *(set_id for set_ids, _ in found for set_id in set_ids)}
                for (by_code, by_name), found in zip(row_sets, pasted)]
    products = _products(conn, generation, rows)

    # Step 2: every attempt of every row in one lookup, each distinct (sets, number) once.
    attempts = [_attempts(by_code, by_name, numbers, found)
                for (by_code, by_name), numbers, found in zip(row_sets, readings, pasted)]
    keys: dict[tuple, int] = {}
    for row_attempts in attempts:
        for attempt in row_attempts:
            keys.setdefault(attempt, len(keys))
    looked = at_code_and_number(conn, generation, [(key, set_id, number) for (set_ids, number), key in keys.items()
                                                   for set_id in set_ids])
    # Step 3's lookups: each Basic Energy row's type, and the Printings of those types.
    types = [energy_type(name) for name in names]
    energies = basic_energy_printings(conn, generation, types)
    energy_ids = {energy: {printing for printing, _ in found} for energy, found in energies.items()}

    answers: list = []
    for index, row in enumerate(rows):
        answer = None   # (Printing or None, candidates)
        if quantities[index] is not None:
            if index in products:
                answer = (products[index], ())
            if answer is None:
                for attempt in attempts[index]:
                    hit = looked.get(keys[attempt])
                    if hit is None:
                        continue
                    printings = (hit.printing_id,) if hit.printing_id else hit.candidates
                    if types[index]:
                        printings = tuple(p for p in printings if p in energy_ids.get(types[index], ()))
                        if not printings:
                            continue
                    answer = (printings[0], ()) if len(printings) == 1 else (None, printings[:MAX_CANDIDATES])
                    break
            if answer is None and types[index] in energies:
                found = energies[types[index]]
                chosen = next((printing for printing, set_id in found if set_id in own_sets[index]), found[0][0])
                answer = (chosen, (chosen, *[printing for printing, _ in found if printing != chosen])[:MAX_CANDIDATES])
        answers.append(answer)

    # Step 4: each distinct name of the rows still unanswered, once.
    unanswered = [index for index, answer in enumerate(answers)
                  if answer is None and quantities[index] is not None and usable_name(names[index])]
    name_keys: dict[str, int] = {}
    for index in unanswered:
        name_keys.setdefault(names[index], len(name_keys))
    named = named_printings(conn, generation, [(key, name) for name, key in name_keys.items()])
    by_name: set[int] = set()
    for index in unanswered:
        answers[index] = _by_name(named.get(name_keys[names[index]], []), own_sets[index])
        if answers[index] and answers[index][0] is not None:
            by_name.add(index)

    editions = editions_of(conn, generation, (answer[0] for answer in answers if answer))
    matches = []
    for index, (row, answer) in enumerate(zip(rows, answers)):
        quantity = quantities[index]
        if quantity is None or (answer is None and not readings[index] and not usable_name(names[index])):
            matches.append(RowMatch("unreadable", quantity, None, None))
        elif answer is None:
            matches.append(RowMatch("not_found", quantity, None, None))
        elif answer[0] is None:
            matches.append(RowMatch("ambiguous", quantity, None, None, answer[1]))
        else:
            status, edition = edition_for(source, row.fields, editions[answer[0]])
            if status == "matched" and index in by_name:
                status = "by_name"
            matches.append(RowMatch(status, quantity, answer[0], edition, answer[1], index in by_name))
    return matches
