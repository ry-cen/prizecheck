"""The Catalog browse route (app redesign #173, spec "Catalog browse route"; data contracts section 1).

``GET /api/catalog/editions`` lists the active catalog one row per Card Edition, for Catalog's gallery and the deck
builder's library (``deck_id``). Signed in only, never public. Each row carries the Edition's display data, its effective
card kind, Trainer Type and evolves from (the one source of card type, migration 041), its Card Printing's stored Format
Standing in all three Formats (migration 042, ``format_standing``) and the caller's copies. With ``deck_id`` a row also
carries the copies in that Deck and the copies free elsewhere (owned and not in that Deck). Only active Editions of
Printings the active generation holds and has not withdrawn are listed.

Search. ``q`` is the smart search. A first word that is a printed set code (``set_codes``, any case: "PAL 185") or else
a TCGdex set ID in the active generation ("sv02 185"), followed by a collector number, lists that set and number; zeros
after a number's letters don't count, so "MEG 1" finds "001" and "SHF SV1" finds "SV001". A printed code wins over a
TCGdex set ID that reads the same ("G1" is Gym Heroes, not Generations, whose code is GEN), and a code that a main set
shares with its subsets searches all of them. Anything else is a name search: the Editions whose name contains q,
comparing letters and digits only (migration 048's ``catalog_search_words`` normalizes both, dropping accents,
apostrophes, periods and spaces), so "juniper" finds "Professor's Research (Professor Juniper)", "pokemon" "Pokémon",
"farfetchd" "Farfetch’d", "mr mime" "Mr. Mime" and "porygonz" "Porygon-Z"; a possessive 's may be left out ("boss
orders"). When no listed Edition of the active catalog has such a name, whatever the other filters (a spelling is right
or wrong whatever the collector owns or filters), and q has at least five letters and digits, the route lists the names
spelled close to q instead (``name_search``: "charzard" finds Charizard) as mode ``fuzzy``, but only when one of them
passes the filters; otherwise it reads as a name search that lists nothing. "char" is part of "Charizard", so it never
reaches "Chatot". An empty ``q`` lists everything. The response says which mode ran (``search``), so the page's hint
reports the server's reading. Filters: ``kind`` (Pokémon, Supporter, Item, Tool, Stadium, Energy; a Trainer whose
Trainer Type is unknown matches no Trainer Type), ``format`` (hides ``not_legal`` only, so ``unknown`` stays),
``set_id`` and ``owned``. ``printing_id`` (#174) lists one Card Printing's active Editions, so the CardPopup reads every
Edition's copies, the regulation mark and the Format Standing in one call, whether it opened from a tile or from the
inspector's report link. ``identity_id`` (#177) lists every active Edition of one Card Identity, for the deck builder's
"Swap this copy for".

Order (the owner's decision on #173). Newest set first: by the set's release date, latest first, then within a set by
collector number in natural order (2 before 10, a letter suffix after its number, numbers with a letter prefix such as
TG01 after the plain ones), then Variant (descriptor key) and Edition id. A name or close-spelling search keeps this
order. With a set filter or a set and number search, collector number order within the set(s) instead. A set's release
date is the one the last catalog import stored (``catalog_generation_set``, migration 044, from TCGdex), else its date
in the format rules files; a set with neither sorts after every dated set, by TCGdex set ID.

Paging is keyset, 60 rows a page, with a signed cursor (``collection.encode_cursor``). The cursor binds the query, the
owner revision and, together, the catalog revision, the Format Standing token (``format_standing.standing_token`` over
all three Formats), the set code table and the search mode. A moved owner revision answers 409 ``INVENTORY_CHANGED``; a
moved catalog revision, standing key or code table, or a search that now reads otherwise (a close-spelling search whose
words a name now contains, or the reverse), answers 409 ``CATALOG_CHANGED``, so a walk never changes mode midway. The
token covers every Format, so a rule date or rules deploy in one Format restarts every walk, whatever its ``format``
filter: rows carry all three standings. Any other cursor problem is 400 ``INVALID_CURSOR``.

Format Standing. ``format_standing.ensure_current`` runs before the read snapshot (it may rebuild, or wait up to
``format_standing.LOCK_WAIT`` for another rebuild, so this route is a sync ``def`` on the threadpool). Inside the snapshot
``current_keys`` confirms the standings are still current; if a commit made them stale in between, the route makes them
current once more, but only while the request is younger than ``RETRY_WITHIN_S``, so that the answer is 503
``FORMAT_STANDING_BUSY`` and never the proxy's 504 (nginx waits 60 s). ``StandingBusy`` is also 503.
"""
import re
import time
import unicodedata
from datetime import datetime
from typing import Literal, NamedTuple
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from . import format_evaluator as evaluator
from . import format_standing, name_search, set_codes
from .collection import anchor_json, anchor_value, cursor_key, encode_cursor
from .holdings import fail
from .main import connect, verified_user

router = APIRouter(prefix="/api/catalog", tags=["catalog"])

PAGE_SIZE = 60
# A second ensure_current only starts while the request is younger than this. One ensure_current waits at most
# LOCK_WAIT (30 s) for another rebuild plus a rebuild (about 2 s at catalog size, budget 6 s), so 20 + 30 + 6 stays
# under nginx's 60 s proxy_read_timeout (deploy/docker/nginx.conf).
RETRY_WITHIN_S = 20.0

Kind = Literal["pokemon", "supporter", "item", "tool", "stadium", "energy"]
FormatName = Literal["standard", "expanded", "glc"]
Status = Literal["legal", "not_legal", "unknown"]
# kind -> (column of catalog_card_attribute, value). Trainer Types match the Trainer Type alone: the view shows one only
# while the effective card kind is 'trainer'.
KIND_FILTERS = {"pokemon": ("card_kind", "pokemon"), "energy": ("card_kind", "energy"),
                "supporter": ("trainer_type", "supporter"), "item": ("trainer_type", "item"),
                "tool": ("trainer_type", "tool"), "stadium": ("trainer_type", "stadium")}
SET_AND_NUMBER = re.compile(r"^(\S+)\s+#?(\S+)$")
# A collector number with the zeros after its letters dropped: "001" -> "1", "sv001" -> "sv1", "tg01" -> "tg1".
NUMBER_KEY = "regexp_replace(lower({}),'^([a-z]*)0*([0-9])','\\1\\2')"
# A name search: the name's letters and digits contain q's, with or without the name's possessive 's (migration 048).
NAME_MATCH = "(gp.search_key LIKE %s ESCAPE '\\' OR gp.search_key_bare LIKE %s ESCAPE '\\')"
# Whether a listed Edition of the active catalog has such a name, whatever the request's other filters: a spelling is
# right or wrong whatever the collector owns or filters.
NAME_LISTED = f"""SELECT 1 FROM catalog_generation_edition ge JOIN catalog_generation_printing gp
  ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
  WHERE ge.generation_id=%s AND ge.active AND NOT gp.tombstoned AND {NAME_MATCH} LIMIT 1"""
# Every name a listed Edition of the active catalog has, normalized: what a close-spelling search compares q with.
LISTED_NAMES = """SELECT DISTINCT gp.search_words FROM catalog_generation_printing gp
  WHERE gp.generation_id=%s AND NOT gp.tombstoned AND gp.search_words<>'' AND EXISTS (
    SELECT 1 FROM catalog_generation_edition ge
    WHERE ge.generation_id=gp.generation_id AND ge.printing_id=gp.printing_id AND ge.active)
  ORDER BY gp.search_words"""

# Sort keys, all ascending and NOT NULL, so a row comparison finds the rows after the cursor's anchor.
# release_rank is days before 9999-12-31, so ascending is latest first; undated sets have release_missing true and go last.
NAME_ORDER = ("release_missing", "release_rank", "set_id", "number_missing", "number_value", "number_key",
              "descriptor_key", "edition_id")
NUMBER_ORDER = ("set_id", "number_missing", "number_value", "number_key", "search_name", "descriptor_key", "edition_id")

LISTED = """SELECT ge.edition_id,gp.printing_id,gp.display_name AS name,gp.set_id,gp.set_name,gp.collector_number,
    e.descriptor,e.descriptor_key,gp.image_url,gp.search_name,ca.card_kind,ca.trainer_type,ca.evolves_from,
    ca.regulation_mark,
    substring(gp.collector_number from '^[0-9]+') IS NULL AS number_missing,
    coalesce(substring(gp.collector_number from '^[0-9]+')::numeric,0) AS number_value,
    lower(gp.collector_number) AS number_key,
    coalesce(gs.release_date,rd.released) IS NULL AS release_missing,
    coalesce(date '9999-12-31'-coalesce(gs.release_date,rd.released),0) AS release_rank
  FROM catalog_generation_edition ge
  JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
  JOIN catalog_edition e ON e.id=ge.edition_id
  LEFT JOIN catalog_card_attribute ca ON ca.printing_id=ge.printing_id
  LEFT JOIN catalog_generation_set gs ON gs.generation_id=ge.generation_id AND gs.set_id=gp.set_id
  LEFT JOIN unnest(%s::text[],%s::date[]) AS rd(set_id,released) ON rd.set_id=gp.set_id"""


class FormatStandingView(BaseModel):
    status: Status
    # The reasons behind a not_legal or unknown standing, in the evaluator's words; empty when legal.
    reasons: list[str]


class EditionStandings(BaseModel):
    standard: FormatStandingView
    expanded: FormatStandingView
    glc: FormatStandingView


class BrowseEdition(BaseModel):
    edition_id: UUID
    printing_id: UUID
    name: str
    set_id: str
    set_name: str
    # The printed set code ("PAL"), or the TCGdex set ID when the set has none (set_codes).
    set_code: str
    collector_number: str
    descriptor: dict
    # The small artwork (low.webp), or null when the card has none.
    image_url: str | None
    card_kind: Literal["pokemon", "trainer", "energy"] | None
    trainer_type: Literal["supporter", "item", "tool", "stadium"] | None
    evolves_from: str | None
    # The effective regulation mark (migration 041), or null when the card has none or it is unknown.
    regulation_mark: str | None
    standing: EditionStandings
    # Copies the caller owns in every Location.
    owned: int
    # With deck_id only: copies in that Deck, and copies owned outside it (owned - in_deck). Otherwise null.
    in_deck: int | None
    free: int | None


class BrowseSearch(BaseModel):
    # all: q was empty; name: Editions whose name contains q, letters and digits only (migration 048); fuzzy: no
    # listed Edition's name contains q, so names spelled close to it (name_search); set_number: a known set ID and a
    # collector number.
    mode: Literal["all", "name", "fuzzy", "set_number"]
    # q as searched: trimmed, spaces collapsed, case folded.
    text: str
    set_id: str | None
    set_name: str | None
    # The set's printed code, or its TCGdex set ID when it has none.
    set_code: str | None
    number: str | None


class BrowsePage(BaseModel):
    available: bool
    catalog_revision: int
    owner_revision: int
    last_success: datetime | None
    search: BrowseSearch
    editions: list[BrowseEdition]
    next_cursor: str | None
    # First page only (null with a cursor): the active catalog's Printings, and the Editions this query matches.
    printings: int | None
    matches: int | None


class CatalogSet(BaseModel):
    set_id: str
    set_name: str
    set_code: str
    printings: int


class CatalogSetList(BaseModel):
    available: bool
    catalog_revision: int
    sets: list[CatalogSet]


class Reading(NamedTuple):
    """What ``q`` asks for (``_search``)."""
    search: BrowseSearch
    # set_number: the TCGdex sets to look in, main set first.
    sets: list[str]
    # name: q's letters and digits (catalog_search_words without its spaces); empty when q has none ("!!!").
    key: str
    # fuzzy: the names (catalog_generation_printing.search_words) spelled close to q.
    close: list[str]


def _text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).split()).casefold()


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _search(conn, generation, text: str) -> Reading:
    """What ``q`` asks for. A first word that is a printed set code with a set in the active generation, or else a
    TCGdex set ID there, then one more word, is a set and collector number search. Anything else is a name search,
    or a close-spelling search when no listed Edition's name contains q and some name is spelled close to it."""
    if not text:
        return Reading(BrowseSearch(mode="all", text="", set_id=None, set_name=None, set_code=None, number=None),
                       [], "", [])
    match = SET_AND_NUMBER.fullmatch(text)
    if match and generation:
        word, number = match.groups()
        for wanted in (set_codes.sets_for_code(word), None):
            rows = conn.execute("""SELECT set_id,min(set_name) AS set_name FROM catalog_generation_printing
              WHERE generation_id=%s AND NOT tombstoned AND """ + ("set_id=ANY(%s)" if wanted else "lower(set_id)=%s")
                                + " GROUP BY set_id", (generation, wanted or word)).fetchall()
            if rows:
                order = wanted or [row["set_id"] for row in rows]
                found = sorted(rows, key=lambda row: order.index(row["set_id"]))
                # "Mew ex" or "Pal Pad" is a name, not a set and number: the number must match a listed Edition.
                if not conn.execute(
                        "SELECT 1 FROM catalog_generation_edition ge JOIN catalog_generation_printing gp"
                        " ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id"
                        " WHERE ge.generation_id=%s AND ge.active AND NOT gp.tombstoned AND gp.set_id=ANY(%s)"
                        f" AND {NUMBER_KEY.format('gp.collector_number')}={NUMBER_KEY.format('%s')} LIMIT 1",
                        (generation, [row["set_id"] for row in found], number)).fetchone():
                    continue
                main = found[0]
                return Reading(BrowseSearch(mode="set_number", text=text, set_id=main["set_id"],
                                            set_name=main["set_name"], set_code=set_codes.code_for(main["set_id"]),
                                            number=number), [row["set_id"] for row in found], "", [])
    words = conn.execute("SELECT catalog_search_words(%s) AS words", (text,)).fetchone()["words"]
    key = words.replace(" ", "")
    search = BrowseSearch(mode="name", text=text, set_id=None, set_name=None, set_code=None, number=None)
    if not generation or len(key) < name_search.FUZZY_MIN_LENGTH:
        return Reading(search, [], key, [])
    pattern = "%" + _escape_like(key) + "%"
    if conn.execute(NAME_LISTED, (generation, pattern, pattern)).fetchone():
        return Reading(search, [], key, [])
    names = [row["search_words"] for row in conn.execute(LISTED_NAMES, (generation,)).fetchall()]
    close = name_search.close_names(words, names)
    if not close:
        return Reading(search, [], key, [])
    return Reading(search.model_copy(update={"mode": "fuzzy"}), [], key, close)


def _standing(found) -> FormatStandingView:
    if found is None:  # Not expected while the keys are current; unknown is the honest answer.
        return FormatStandingView(status="unknown", reasons=[])
    return FormatStandingView(status=found.status, reasons=[finding["reason"] for finding in found.findings])


def _rules_release_dates() -> tuple[list[str], list]:
    """The release date the format rules files give each set they list (TCGdex releaseDate), as two arrays: the fallback
    for a set the last import stored no date for."""
    found = {}
    for name in evaluator.FORMATS:
        for set_id, rule in evaluator.format_rules(name).sets.items():
            found.setdefault(set_id, rule.released)
    return list(found), list(found.values())


def _anchor(column: str, raw):
    """One carried sort value, typed as the listing compares it. Raises on a wrong shape."""
    if column == "release_missing":
        if not isinstance(raw, bool):
            raise ValueError
        return raw
    if column == "release_rank":
        if not isinstance(raw, str) or not raw.isdecimal():
            raise ValueError
        return int(raw)
    return anchor_value(column, raw)


def _make_current():
    try:
        format_standing.ensure_current()
    except format_standing.StandingBusy:
        fail(503, "FORMAT_STANDING_BUSY")


@router.get("/editions", response_model=BrowsePage)
def browse_editions(q: str = Query(default="", max_length=120),
                    kind: Kind | None = None,
                    format_name: FormatName | None = Query(default=None, alias="format"),
                    set_id: str = Query(default="", max_length=80),
                    owned: bool = False,
                    deck_id: UUID | None = None,
                    printing_id: UUID | None = None,
                    identity_id: UUID | None = None,
                    cursor: str | None = Query(default=None, max_length=4096),
                    user_id: str = Depends(verified_user)):
    started = time.monotonic()
    for attempt in (1, 2):
        if attempt == 2 and time.monotonic() - started >= RETRY_WITHIN_S:
            break
        _make_current()
        with connect() as conn, conn.transaction():
            # One snapshot binds the rows, their standings, the counts and every revision in the cursor.
            conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            keys = format_standing.current_keys(conn)
            if keys is not None:
                return _page(conn, user_id, keys, _text(q), kind, format_name, set_id.strip(), owned, deck_id,
                             printing_id, identity_id, cursor)
    fail(503, "FORMAT_STANDING_BUSY")


def _listed(reading: Reading, generation, kind, format_name, set_id, owned, printing_id, identity_id,
            user_id) -> tuple[str, list]:
    """The listing query for this search and these filters (every matching row, before paging) and its parameters."""
    joins, conditions, params = "", "", [*_rules_release_dates()]
    if format_name:
        joins = " LEFT JOIN catalog_format_standing fs ON fs.printing_id=ge.printing_id AND fs.format=%s"
        params.append(format_name)
        conditions += " AND coalesce(fs.standing,'unknown')<>'not_legal'"
    params.append(generation)
    mode = reading.search.mode
    if mode == "name" and reading.key:
        conditions += " AND " + NAME_MATCH
        pattern = "%" + _escape_like(reading.key) + "%"
        params.extend([pattern, pattern])
    elif mode == "name":  # q has no letters or digits ("!!!", "♀"): no name contains it.
        conditions += " AND false"
    elif mode == "fuzzy":
        conditions += " AND gp.search_words=ANY(%s)"
        params.append(reading.close)
    elif mode == "set_number":
        conditions += f" AND gp.set_id=ANY(%s) AND {NUMBER_KEY.format('gp.collector_number')}={NUMBER_KEY.format('%s')}"
        params.extend([reading.sets, reading.search.number])
    if set_id:
        conditions += " AND gp.set_id=%s"
        params.append(set_id)
    if printing_id:
        conditions += " AND ge.printing_id=%s"
        params.append(printing_id)
    if identity_id:
        conditions += " AND ge.printing_id IN (SELECT id FROM catalog_printing WHERE identity_id=%s)"
        params.append(identity_id)
    if kind:
        column, value = KIND_FILTERS[kind]
        conditions += f" AND ca.{column}=%s"
        params.append(value)
    if owned:
        conditions += " AND EXISTS (SELECT 1 FROM holding h WHERE h.owner_id=%s AND h.edition_id=ge.edition_id)"
        params.append(user_id)
    return f"{LISTED}{joins} WHERE ge.generation_id=%s AND ge.active AND NOT gp.tombstoned{conditions}", params


def _page(conn, user_id, keys, text, kind, format_name, set_id, owned, deck_id, printing_id, identity_id,
          cursor) -> BrowsePage:
    state = conn.execute("SELECT active_generation,revision,last_success FROM catalog_state WHERE singleton").fetchone()
    owner = conn.execute("SELECT revision FROM inventory_owner WHERE user_id=%s", (user_id,)).fetchone()
    revision = owner["revision"] if owner else 1
    if deck_id:
        deck = conn.execute("SELECT kind FROM location WHERE owner_id=%s AND id=%s", (user_id, deck_id)).fetchone()
        if not deck or deck["kind"] != "deck":
            fail(404, "DECK_NOT_FOUND")
    generation = state["active_generation"]
    reading = _search(conn, generation, text)
    listed, params = _listed(reading, generation, kind, format_name, set_id, owned, printing_id, identity_id, user_id)
    if reading.search.mode == "fuzzy" and not conn.execute(f"SELECT 1 FROM ({listed}) listed LIMIT 1",
                                                           params).fetchone():
        # Close spellings, but none passes these filters: the search reads as a name search, which lists nothing too.
        reading = reading._replace(search=reading.search.model_copy(update={"mode": "name"}))
    search = reading.search
    # The last slot answers 409 CATALOG_CHANGED: the catalog revision, the Format Standing key, the set code table
    # (a deploy that changes it can change what q means) and the search mode, so a walk never changes mode midway.
    context = ["catalog-editions", user_id, text, kind, format_name, set_id, owned,
               str(deck_id) if deck_id else None, str(printing_id) if printing_id else None,
               str(identity_id) if identity_id else None, revision,
               [state["revision"], format_standing.standing_token(keys), set_codes.DIGEST, search.mode]]
    order = NUMBER_ORDER if set_id or search.mode == "set_number" else NAME_ORDER
    anchor = None
    if cursor:
        carried = cursor_key(cursor, context)
        try:
            if not isinstance(carried, list) or len(carried) != len(order):
                raise ValueError
            anchor = [_anchor(column, raw) for column, raw in zip(order, carried)]
        except (ValueError, TypeError, ArithmeticError):
            fail(400, "INVALID_CURSOR")
    if not generation:
        return BrowsePage(available=False, catalog_revision=state["revision"], owner_revision=revision,
                          last_success=state["last_success"], search=search, editions=[], next_cursor=None,
                          printings=0, matches=0)

    columns = ",".join(order)
    after = f" WHERE ({columns})>({','.join(['%s'] * len(order))})" if anchor else ""
    rows = conn.execute(f"SELECT * FROM ({listed}) listed{after} ORDER BY {columns} LIMIT %s",
                        [*params, *(anchor or []), PAGE_SIZE + 1]).fetchall()
    page = rows[:PAGE_SIZE]

    ids = [row["edition_id"] for row in page]
    copies = {row["edition_id"]: row for row in conn.execute(
        """SELECT edition_id,sum(quantity) AS owned,coalesce(sum(quantity) FILTER (WHERE location_id=%s),0) AS in_deck
          FROM holding WHERE owner_id=%s AND edition_id=ANY(%s) GROUP BY edition_id""",
        (deck_id, user_id, ids)).fetchall()} if ids else {}
    standings = format_standing.read_standings(conn, ids) if ids else {}
    editions = []
    for row in page:
        held = copies.get(row["edition_id"])
        total, in_deck = (int(held["owned"]), int(held["in_deck"])) if held else (0, 0)
        found = standings.get(row["edition_id"], {})
        editions.append(BrowseEdition(
            edition_id=row["edition_id"], printing_id=row["printing_id"], name=row["name"], set_id=row["set_id"],
            set_name=row["set_name"], set_code=set_codes.code_for(row["set_id"]),
            collector_number=row["collector_number"], descriptor=row["descriptor"],
            image_url=f'{row["image_url"]}/low.webp' if row["image_url"] else None, card_kind=row["card_kind"],
            trainer_type=row["trainer_type"], evolves_from=row["evolves_from"], regulation_mark=row["regulation_mark"],
            standing=EditionStandings(**{name: _standing(found.get(name)) for name in ("standard", "expanded", "glc")}),
            owned=total, in_deck=in_deck if deck_id else None, free=total - in_deck if deck_id else None))
    printings = matches = None
    if not cursor:
        printings = conn.execute("""SELECT count(*) AS n FROM catalog_generation_printing
          WHERE generation_id=%s AND NOT tombstoned""", (generation,)).fetchone()["n"]
        matches = conn.execute(f"SELECT count(*) AS n FROM ({listed}) listed", params).fetchone()["n"]
    next_cursor = (encode_cursor(context, [anchor_json(page[-1][column]) for column in order])
                   if len(rows) > PAGE_SIZE else None)
    return BrowsePage(available=True, catalog_revision=state["revision"], owner_revision=revision,
                      last_success=state["last_success"], search=search, editions=editions, next_cursor=next_cursor,
                      printings=printings, matches=matches)


@router.get("/sets", response_model=CatalogSetList)
def catalog_sets(user_id: str = Depends(verified_user)):
    """Every set in the active catalog, once each, for Catalog's set picker: A–Z by name."""
    with connect() as conn, conn.transaction():
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        state = conn.execute("SELECT active_generation,revision FROM catalog_state WHERE singleton").fetchone()
        if not state["active_generation"]:
            return CatalogSetList(available=False, catalog_revision=state["revision"], sets=[])
        rows = conn.execute("""SELECT set_id,min(set_name) AS set_name,count(*) AS printings
          FROM catalog_generation_printing WHERE generation_id=%s AND NOT tombstoned
          GROUP BY set_id ORDER BY lower(min(set_name)),set_id""", (state["active_generation"],)).fetchall()
        return CatalogSetList(available=True, catalog_revision=state["revision"],
                              sets=[CatalogSet(**row, set_code=set_codes.code_for(row["set_id"])) for row in rows])
