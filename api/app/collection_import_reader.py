"""Collection Import reading (#226; spec "Reading the input"): an uploaded file's bytes to source rows.

Pure: no database and no network. #226 reads the TCGplayer app's CSV export in its 12-column (older) and 14-column
(newer, with prices) headers; #227 adds the other trackers, the loose fallback, zip files and pasted text. The text is
UTF-8 (a BOM is dropped), else Windows-1252; quoting and line endings (LF or CRLF) are standard CSV. Blank lines are not
rows. Each row keeps its cells written back as one CSV line (raw_text, for downloads in the file's own columns) and the
fields matching reads; columns PrizeCheck doesn't track (condition, SKU, prices) are dropped quietly. The detected
source is stored with the draft for matching only, and nothing here is shown to the collector.
"""
import csv
import io
from dataclasses import dataclass

# One import holds at most 5 MiB and 10,000 source rows (ADR 0014). 5 MiB is nginx's "5m", which the gateway follow-up
# must use for the start route too.
MAX_IMPORT_BYTES = 5 * 1024 * 1024
MAX_IMPORT_ROWS = 10_000

TCGPLAYER_APP = "tcgplayer_app"
_TCGPLAYER_APP_12 = ("Quantity", "Name", "Simple Name", "Set", "Card Number", "Set Code", "Printing", "Condition",
                     "Language", "Rarity", "Product ID", "SKU")
_TCGPLAYER_APP_14 = _TCGPLAYER_APP_12 + ("Price", "Price Each")
# Column -> parsed field. Columns not listed here are dropped.
_TCGPLAYER_FIELDS = {"Quantity": "quantity", "Name": "name", "Set": "set_name", "Set Code": "set_code",
                     "Card Number": "number", "Printing": "finish", "Language": "language", "Rarity": "rarity",
                     "Product ID": "product_id"}
# Every source row has each of these fields, "" when its file has no such column or the cell is blank.
FIELDS = ("quantity", "name", "set_name", "set_code", "number", "finish", "language", "rarity", "product_id")


class ImportRefused(Exception):
    """The file can't start an import. ``code`` is the API's error code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class SourceRow:
    # 1 for the first row after the header.
    row_number: int
    # The row's cells written back as one CSV line.
    raw_text: str
    # Every name in FIELDS -> its cell, stripped.
    fields: dict


@dataclass(frozen=True)
class SourceFile:
    # The detected source (TCGPLAYER_APP); for matching only, never shown.
    source: str
    header: list
    rows: list


def _decode(data: bytes) -> str:
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        pass
    try:
        return data.decode("cp1252")
    except UnicodeDecodeError:
        raise ImportRefused("IMPORT_UNREADABLE") from None


def _line(cells: list) -> str:
    buffer = io.StringIO()
    csv.writer(buffer, lineterminator="").writerow(cells)
    return buffer.getvalue()


def read(data: bytes) -> SourceFile:
    """The file's source rows. Refuses IMPORT_TOO_LARGE (over MAX_IMPORT_BYTES), IMPORT_UNREADABLE (not text, a NUL
    character, not CSV, or a header this ticket doesn't read), IMPORT_EMPTY (a header and no rows) and
    IMPORT_TOO_MANY_ROWS (stopping at row MAX_IMPORT_ROWS + 1)."""
    if len(data) > MAX_IMPORT_BYTES:
        raise ImportRefused("IMPORT_TOO_LARGE")
    text = _decode(data)
    # PostgreSQL text and jsonb can't hold NUL, and no tracker writes one.
    if "\x00" in text:
        raise ImportRefused("IMPORT_UNREADABLE")
    records = csv.reader(io.StringIO(text, newline=""))
    rows = []
    try:
        header = next((record for record in records if any(cell.strip() for cell in record)), None)
        if header is None or tuple(cell.strip() for cell in header) not in (_TCGPLAYER_APP_12, _TCGPLAYER_APP_14):
            raise ImportRefused("IMPORT_UNREADABLE")
        columns = [cell.strip() for cell in header]
        for record in records:
            if not any(cell.strip() for cell in record):
                continue
            if len(rows) == MAX_IMPORT_ROWS:
                raise ImportRefused("IMPORT_TOO_MANY_ROWS")
            cells = dict(zip(columns, record))
            fields = {name: "" for name in FIELDS}
            for column, name in _TCGPLAYER_FIELDS.items():
                fields[name] = cells.get(column, "").strip()
            rows.append(SourceRow(len(rows) + 1, _line(record), fields))
    except csv.Error:
        raise ImportRefused("IMPORT_UNREADABLE") from None
    if not rows:
        raise ImportRefused("IMPORT_EMPTY")
    return SourceFile(TCGPLAYER_APP, columns, rows)
