"""Collection Import matching (#226; spec "Matching"): each source row to one Card Edition of the active catalog.

#226 matches by set name and collector number only. The set name is compared trimmed, case-folded and with runs of
whitespace as one space; the number drops anything after a "/" (the set's card count) and is compared under the
catalog's number key (catalog_browse.NUMBER_KEY, "001" is "1"). Two batched queries answer every row of a file. A
Printing counts only when it has an active Card Edition in the active generation:

- no such Printing: not_found;
- more than one: ambiguous, with no Printing;
- one Printing with one Edition: matched;
- one Printing with several Editions, one of them the Unspecified Variant: finish_unknown, on the Unspecified Edition;
- one Printing with several Editions and no Unspecified Variant: ambiguous, with the Printing and no Edition.

The finish column is not read yet (#230), nor Product IDs, names or aliases (#228, #229). A row without a readable
quantity, set name or number is unreadable. Pure SQL reads: nothing here writes, reads prices or starts a catalog pull.
"""
from dataclasses import dataclass
from uuid import UUID

from .catalog_browse import NUMBER_KEY
from .catalog_targets import is_unspecified

MAX_QUANTITY = 2**63 - 1
READY = ("matched", "finish_unknown", "by_name")
NEEDS_YOU = ("ambiguous", "not_found", "unreadable")
STATUSES = READY + NEEDS_YOU
# Row predicates over collection_import_row, for an alias: READY_ROW.format(r="r"). A skipped or left-out row (later
# tickets) is neither ready nor needs the collector.
READY_ROW = ("{r}.status IN ('matched','finish_unknown','by_name') AND NOT {r}.skipped "
             "AND {r}.left_out_reason IS NULL")
NEEDS_YOU_ROW = ("{r}.status IN ('ambiguous','not_found','unreadable') AND NOT {r}.skipped "
                 "AND {r}.left_out_reason IS NULL")
# A set name trimmed, case-folded and with runs of whitespace as one space.
SET_KEY = "lower(regexp_replace(btrim({}),'\\s+',' ','g'))"

PRINTINGS = f"""SELECT w.set_name,w.number,gp.printing_id
  FROM (SELECT DISTINCT set_name,number FROM unnest(%s::text[],%s::text[]) AS u(set_name,number)) w
  JOIN catalog_generation_printing gp ON gp.generation_id=%s AND NOT gp.tombstoned
    AND {SET_KEY.format('gp.set_name')}={SET_KEY.format('w.set_name')}
    AND {NUMBER_KEY.format('gp.collector_number')}={NUMBER_KEY.format('w.number')}"""
EDITIONS = """SELECT ge.printing_id,e.id AS edition_id,e.descriptor
  FROM catalog_generation_edition ge JOIN catalog_edition e ON e.id=ge.edition_id
  WHERE ge.generation_id=%s AND ge.active AND ge.printing_id=ANY(%s::uuid[])
  ORDER BY ge.printing_id,e.descriptor_key,e.id"""


@dataclass(frozen=True)
class RowMatch:
    status: str
    # None when the row's quantity can't be read.
    quantity: int | None
    printing_id: UUID | None
    edition_id: UUID | None


def quantity_of(text: str) -> int | None:
    """A blank quantity is one copy; otherwise ASCII digits from 1 to MAX_QUANTITY, or None."""
    text = text.strip()
    if not text:
        return 1
    if not text.isascii() or not text.isdecimal() or len(text) > 19:
        return None
    value = int(text)
    return value if 1 <= value <= MAX_QUANTITY else None


def number_of(text: str) -> str:
    """The collector number without the set's card count: "042/102" is "042"."""
    return text.split("/", 1)[0].strip()


def match(conn, generation: UUID, rows: list) -> list:
    """One RowMatch per source row (reader.SourceRow), in order, against `generation`."""
    keys = []
    for row in rows:
        keys.append((row.fields["set_name"], number_of(row.fields["number"])))
    wanted = sorted({key for key in keys if key[0].strip() and key[1]})
    found: dict = {}
    if wanted:
        for hit in conn.execute(PRINTINGS, ([key[0] for key in wanted], [key[1] for key in wanted], generation)):
            found.setdefault((hit["set_name"], hit["number"]), set()).add(hit["printing_id"])
    printing_ids = sorted({printing for printings in found.values() for printing in printings}, key=str)
    editions: dict = {}
    if printing_ids:
        for edition in conn.execute(EDITIONS, (generation, printing_ids)):
            editions.setdefault(edition["printing_id"], []).append(edition)
    matches = []
    for row, key in zip(rows, keys):
        quantity = quantity_of(row.fields["quantity"])
        if quantity is None or not key[0].strip() or not key[1]:
            matches.append(RowMatch("unreadable", quantity, None, None))
            continue
        printings = sorted((printing for printing in found.get(key, ()) if editions.get(printing)), key=str)
        if not printings:
            matches.append(RowMatch("not_found", quantity, None, None))
        elif len(printings) > 1:
            matches.append(RowMatch("ambiguous", quantity, None, None))
        else:
            printing = printings[0]
            choices = editions[printing]
            unspecified = [choice for choice in choices if is_unspecified(choice["descriptor"])]
            if len(choices) == 1:
                matches.append(RowMatch("matched", quantity, printing, choices[0]["edition_id"]))
            elif unspecified:
                matches.append(RowMatch("finish_unknown", quantity, printing, unspecified[0]["edition_id"]))
            else:
                matches.append(RowMatch("ambiguous", quantity, printing, None))
    return matches
