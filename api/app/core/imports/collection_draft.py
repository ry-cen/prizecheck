"""Game-free collection import draft models, row predicates and storage helpers."""
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

MAX_IMPORT_ROWS = 10_000


PAGE_SIZE = 100


SPLIT_MESSAGES = {
    "IMPORT_TOO_LARGE": "This file is larger than 5 MB. Split it into two files and import each one.",
    "IMPORT_TOO_MANY_ROWS": "This file has more than 10,000 rows. Split it into two files and import each one.",
}


# A paste's refusals (#234) say "list", not "file".
PASTE_MESSAGES = {
    "IMPORT_TOO_LARGE": "This list is larger than 5 MB. Split it into two lists and import each one.",
    "IMPORT_TOO_MANY_ROWS": "This list has more than 10,000 rows. Split it into two lists and import each one.",
    "IMPORT_UNREADABLE": "PrizeCheck can't read this list. Paste it as plain text.",
}


# A collector starts at most this many import drafts in any 24 hours (#233); the 21st start is refused 429.
MAX_STARTS_PER_DAY = 20


RATE_LIMITED_MESSAGE = "You can start 20 imports a day. Try again tomorrow."


# This collector's import starts in the last 24 hours (collection_import_start, migration 051).
STARTS_TODAY = """SELECT count(*) AS n FROM collection_import_start
  WHERE owner_id=%s AND started_at>now()-interval '24 hours'"""


# A draft the collector can still review: open and not expired (#233). For alias ci.
OPEN_DRAFT = "ci.status='open' AND ci.expires_at>now()"


# Each sweep deletes at most this many expired drafts (with their rows), any collector's, oldest first.
SWEEP_LIMIT = 20


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


RowFilter = Literal["needs", "finish", "name", "all", "skipped"]


# The caller supplies the left-out reason order.
LeftOutReason = Literal["watchlist", "other_game", "not_english", "sealed"]


# How many left-out rows of each reason the summary shows, for View.
LEFT_OUT_EXAMPLES = 3


# The left-out rows' examples: the first LEFT_OUT_EXAMPLES of each reason in file order, with each reason's count.
LEFT_OUT = f"""SELECT reason,n,parsed FROM (
    SELECT r.left_out_reason AS reason,r.parsed,count(*) OVER (PARTITION BY r.left_out_reason) AS n,
      row_number() OVER (PARTITION BY r.left_out_reason ORDER BY r.row_number) AS k
    FROM collection_import_row r WHERE r.import_id=%s AND {LEFT_OUT_ROW.format(r="r")}) found
  WHERE k<=%s ORDER BY reason,k"""


# The file's groups in file order (#232): the rows of each that weren't left out, and whether it is included. A group
# whose rows were all left out is not listed.
GROUPS = """SELECT r.group_name AS name,count(*) FILTER (WHERE r.left_out_reason IS NULL) AS n,
    NOT (ci.excluded_groups @> jsonb_build_array(r.group_name)) AS included
  FROM collection_import_row r JOIN collection_import ci ON ci.id=r.import_id
  WHERE r.import_id=%s AND r.group_name IS NOT NULL
  GROUP BY r.group_name,ci.excluded_groups HAVING count(*) FILTER (WHERE r.left_out_reason IS NULL)>0
  ORDER BY min(r.row_number)"""


# The copies of each of these Card Editions in the collector's Collection, every Location and Deck (as catalog search
# counts a card's owned copies, catalog_browse).
HELD = """SELECT edition_id,sum(quantity) AS held FROM holding WHERE owner_id=%s AND edition_id=ANY(%s::uuid[])
  GROUP BY edition_id"""


# One changes request holds at most MAX_CHANGES changes, and a change names at most MAX_CHANGE_ROWS rows by number: the
# gateway's 64 KiB body limit for this route binds first. It fits every row of a 10,000-row file named one by one
# (about 49 KB). Select all sends its filter instead.
MAX_CHANGES = 100


MAX_CHANGE_ROWS = 1000


class CollectionImportCounts(BaseModel):
    # Every row in the file, left-out rows and rows in groups left out included.
    rows: int
    needs_you: int
    ready: int
    # Ready rows on the card's Unspecified Variant (part of `ready`).
    finish_unknown: int
    # Ready rows whose card came from their name within their set, whatever their finish (part of `ready`).
    by_name: int
    # Neither ready nor needing the collector. needs_you + ready is the All filter's count.
    skipped: int


class CollectionImportSource(BaseModel):
    """What the collector's file said, from the columns PrizeCheck reads; "" for a blank cell."""
    quantity: str
    name: str
    set_name: str
    number: str
    finish: str


class CollectionImportLeftOut(BaseModel):
    """The rows the filters left out for one reason (#231): never listed, counted or saved."""
    reason: LeftOutReason
    rows: int
    # The first LEFT_OUT_EXAMPLES of them, in file order, as the file wrote them.
    examples: list[CollectionImportSource]


class CollectionImportGroup(BaseModel):
    """One of the file's groups (#232): a portfolio, folder or list, never a Location."""
    name: str
    # Its rows that weren't left out (#231), whether or not it is included.
    rows: int
    # False once the collector leaves it out: its rows are then in no count, filter, download or save.
    included: bool


class CollectionImportSummary(BaseModel):
    id: UUID
    draft_revision: int
    location_id: UUID
    # The landing Location's own name, or None when it is gone.
    location_name: str | None
    counts: CollectionImportCounts
    # The copies the ready rows add, as text so no JSON reader rounds it.
    cards_to_add: str
    expires_at: str
    # The left-out rows (#231), one entry per reason that has any, in LEFT_OUT_REASONS order. counts.rows includes
    # them; no other count does. Rows in a group left out (#232) aren't counted.
    left_out: list[CollectionImportLeftOut]
    # The file's groups in file order (#232); [] for a file without groups. Rows with no group are always included.
    groups: list[CollectionImportGroup]
    # Of cards_to_add, the copies whose Card Edition the Collection already holds (#232): importing adds to them.
    already_held: str
    # The draft is a pasted list read line by line (#234): its rows are lines, and its downloads are text.
    lines: bool


class CollectionImportCard(BaseModel):
    printing_id: UUID
    name: str
    set_name: str
    collector_number: str


class CollectionImportEdition(BaseModel):
    edition_id: UUID
    # The Variant Descriptor's physical keys (the physical descriptor). Send it back as a change's
    # `finish` to choose this Edition.
    descriptor: dict


class CollectionImportRow(BaseModel):
    row_number: int
    status: Literal["matched", "finish_unknown", "by_name", "ambiguous", "not_found", "unreadable"]
    needs_you: bool
    # None when the row's quantity can't be read.
    quantity: str | None
    source: CollectionImportSource
    skipped: bool
    # The matched Printing, when there is exactly one.
    card: CollectionImportCard | None
    edition: CollectionImportEdition | None
    # The card's active Editions in catalog order, for the finish picker; [] without a card.
    editions: list[CollectionImportEdition]
    # The cards the row could be, for Pick one (an ambiguous row without a card) and Change (a card's other
    # Printings, the matched one first); [] for most rows. Only cards still in the catalog are listed.
    candidates: list[CollectionImportCard]
    # The collector chose this row's card (a pick), so Change can choose another.
    picked: bool
    # The row's card came from its name within its set, whatever its finish; a pick clears it.
    by_name: bool
    # The row's portfolio, folder or list in the file (#232), or None.
    group: str | None
    # The copies of the row's Card Edition already in the Collection, every Location and Deck (#232); "0" without one.
    held: str


class CollectionImportRowsPage(BaseModel):
    rows: list[CollectionImportRow]
    # Pass as `cursor` for the next page; None on the last page.
    next_cursor: str | None
    draft_revision: int


class SaveCollectionImport(BaseModel):
    draft_revision: int = Field(ge=1)
    idempotency_key: UUID


class CollectionImportPick(BaseModel):
    """The card a row is: exactly one of a Printing (the row's finish then chooses its Edition, as matching does) or one
    of its active Editions."""
    model_config = ConfigDict(extra="forbid")
    printing_id: UUID | None = None
    edition_id: UUID | None = None


class CollectionImportChange(BaseModel):
    """One change, with exactly one action. `pick`, `finish`, `skip` and `restore` apply to rows: by `rows` (row
    numbers) or `filter` (the rows route's filter, as it stands when this change applies), exactly one of them.
    `group` with `include` (#232) leaves one of the file's groups out (false) or brings it back (true), and
    `location_id` (#232) moves the landing Storage Leaf; neither names rows. Unknown fields are refused, so an older
    API never ignores a newer change."""
    model_config = ConfigDict(extra="forbid")
    rows: list[Annotated[int, Field(ge=1, le=MAX_IMPORT_ROWS)]] | None = Field(
        default=None, min_length=1, max_length=MAX_CHANGE_ROWS)
    filter: RowFilter | None = None
    pick: CollectionImportPick | None = None
    # A Variant Descriptor: one of the row's `editions[].descriptor`, or a finish such as {"type": "reverse"}. It
    # applies to a row whose card has exactly one active Edition that fits it.
    finish: dict | None = None
    skip: bool = False
    restore: bool = False
    # One of the summary's groups' names, with `include`.
    group: str | None = Field(default=None, min_length=1)
    include: bool | None = None
    # The collector's Storage Leaf to land in instead.
    location_id: UUID | None = None


class ChangeCollectionImport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    draft_revision: int = Field(ge=1)
    changes: list[CollectionImportChange] = Field(max_length=MAX_CHANGES)


class CollectionImportChangeResult(BaseModel):
    # How many of the change's rows it applied to; for a group, the group's rows that weren't left out when its
    # inclusion changed, else 0; for a Location, 0.
    applied: int
    # The row numbers it couldn't apply to, in file order: for a pick, skipped rows and rows whose quantity can't be
    # read; for a finish, rows without a card, skipped rows and rows whose card has no Edition that fits; for skip and
    # restore, rows already so. Left-out rows (#231) and rows in a group left out (#232) are never applied to. Always []
    # for a group or a Location.
    not_applied: list[int]


class CollectionImportChanges(BaseModel):
    # The draft after every change, at its new draft_revision.
    summary: CollectionImportSummary
    # One result per change, in order.
    results: list[CollectionImportChangeResult]


class PasteCollectionImport(BaseModel):
    """A paste's start body (#234)."""
    model_config = ConfigDict(extra="forbid", strict=True)
    text: str


class CollectionImportSaveResult(BaseModel):
    import_id: UUID
    location_id: UUID
    edition_count: int
    copy_count: str
    owner_revision: int


def sweep_expired(conn) -> int:
    """Deletes up to SWEEP_LIMIT expired drafts, any collector's, oldest first, with their rows (the foreign key
    cascades); how many it deleted. Drafts another request holds are skipped, never waited for. There is no scheduler,
    so the start and current routes run it (#233)."""
    return len(conn.execute("""DELETE FROM collection_import WHERE id IN (
        SELECT id FROM collection_import WHERE expires_at<=now() ORDER BY expires_at,id LIMIT %s FOR UPDATE SKIP LOCKED)
      RETURNING id""", (SWEEP_LIMIT,)).fetchall())


def storage_leaf(conn, user_id: str, location_id: UUID):
    """This collector's Storage Leaf (not a Deck, no children), or None."""
    return conn.execute("""SELECT l.id,l.name FROM location l WHERE l.owner_id=%s AND l.id=%s AND l.kind='storage_leaf'
      AND NOT EXISTS (SELECT 1 FROM location child WHERE child.parent_id=l.id)""", (user_id, location_id)).fetchone()


def source_of(parsed: dict) -> CollectionImportSource:
    """What the row said; its set is the set name, else the set code."""
    fields = {field: parsed.get(field, "") for field in ("quantity", "name", "number", "finish")}
    return CollectionImportSource(**fields, set_name=parsed.get("set_name") or parsed.get("set_code", ""))


def left_out(conn, import_id: UUID, *, reasons: tuple[str, ...]) -> list[CollectionImportLeftOut]:
    found: dict[str, CollectionImportLeftOut] = {}
    for row in conn.execute(LEFT_OUT, (import_id, LEFT_OUT_EXAMPLES)):
        entry = found.setdefault(row["reason"], CollectionImportLeftOut(reason=row["reason"], rows=row["n"],
                                                                         examples=[]))
        entry.examples.append(source_of(row["parsed"]))
    return [found[reason] for reason in reasons if reason in found]


def _set_skipped(conn, import_id: UUID, targets: list, skipped: bool) -> CollectionImportChangeResult:
    eligible = [row["row_number"] for row in targets if row["left_out_reason"] is None and row["included"]]
    changed: set[int] = set()
    if eligible:
        # Only rows whose flag differs count as changed; the rest are reported in not_applied.
        changed = {row["row_number"] for row in conn.execute(
            """UPDATE collection_import_row SET skipped=%s WHERE import_id=%s AND row_number=ANY(%s::int[])
               AND skipped IS DISTINCT FROM %s RETURNING row_number""",
            (skipped, import_id, eligible, skipped)).fetchall()}
    return CollectionImportChangeResult(applied=len(changed),
                                        not_applied=[row["row_number"] for row in targets
                                                     if row["row_number"] not in changed])


def set_group(conn, import_id: UUID, group: str, include: bool) -> CollectionImportChangeResult | None:
    """Leaves the file's group out of the import (include false) or brings it back, keeping each of its rows as it
    was. Returns None for a name no row of the draft has."""
    rows = conn.execute("""SELECT count(*) AS n,count(*) FILTER (WHERE left_out_reason IS NULL) AS kept
      FROM collection_import_row WHERE import_id=%s AND group_name=%s""", (import_id, group)).fetchone()
    if not rows["n"]:
        return None
    changed = conn.execute("""UPDATE collection_import SET excluded_groups=CASE WHEN %s THEN excluded_groups-%s::text
        ELSE excluded_groups||jsonb_build_array(%s::text) END
      WHERE id=%s AND (excluded_groups @> jsonb_build_array(%s::text))=%s RETURNING id""",
                           (include, group, group, import_id, group, include)).fetchone()
    return CollectionImportChangeResult(applied=rows["kept"] if changed else 0, not_applied=[])
