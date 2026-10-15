"""Collection Import reading (#226, #227; spec "Reading the input"): an uploaded file's bytes to source rows.

Pure: no database and no network. The collector never says which app a file came from; its header decides:

- **Presets** (a recognised header always wins): the TCGplayer app (12 and 14 columns), Collectr (14 and 16 columns,
  its dated "Market Price (As of …)" column matched by prefix), PriceCharting (its "Name [Variant] #N" product name
  split into name, finish words and number), TCG Collector, Dragon Shield and Sorted (Sorted's "Current Price (…)"
  column matched by prefix too).
- **The loose fallback** maps any other header by column names that look like quantity, name, set, set code, number,
  finish, product ID and the rest of FIELDS. It reads a file with a Product ID column, or with a set (name or code)
  column and a number or name column; anything less is IMPORT_UNREADABLE.

A zip upload (found by its first bytes, whatever the content type) must hold exactly one file entry named .csv, .tsv or
.txt, stored or deflated, unencrypted and not itself an archive (else IMPORT_BAD_ZIP). Directory entries and Finder
metadata (__MACOSX/, ._*, .DS_Store) are ignored, though an encrypted one still refuses the archive; it is decompressed as a stream and refused
IMPORT_TOO_LARGE past MAX_IMPORT_BYTES. The text is UTF-8 (a BOM is dropped), else Windows-1252. A leading Excel
"sep=X" line (quoted or not) is skipped and names the delimiter; otherwise the first non-blank line decides between tab
and comma. Quoting and line endings (LF or CRLF) are standard CSV. Blank lines are not rows. Every cell goes through
normalise_cell. Each row keeps its cells written back as one CSV line (raw_text, for downloads), its group (a portfolio,
folder or list) and the fields matching and later tickets read; other columns (condition, SKU, prices, dates, notes)
are dropped quietly. The detected source is stored with the draft for matching only, and nothing here is shown to the
collector.
"""
import csv
import io
import re
import zipfile
from dataclasses import dataclass

from . import decklist_text

# One import holds at most 5 MiB and 10,000 source rows (ADR 0014), counted after unzipping. 5 MiB is the start
# route's limit in the gateway (auth/src/server.ts IMPORT_ROUTES) and nginx's "5m" (deploy/docker/nginx.conf).
MAX_IMPORT_BYTES = 5 * 1024 * 1024
MAX_IMPORT_ROWS = 10_000

# The detected source, stored as collection_import.source. Never shown and never in a response.
TCGPLAYER_APP = "tcgplayer_app"
COLLECTR = "collectr"
PRICECHARTING = "pricecharting"
TCG_COLLECTOR = "tcg_collector"
DRAGON_SHIELD = "dragon_shield"
SORTED = "sorted"
LOOSE = "loose"
SOURCES = (TCGPLAYER_APP, COLLECTR, PRICECHARTING, TCG_COLLECTOR, DRAGON_SHIELD, SORTED, LOOSE)

# Every source row has each of these fields, "" when its file has no such column or the cell is blank:
# - quantity: as written; the matcher reads it (a blank is one copy);
# - name, simple_name: the card's name as written; simple_name is the TCGplayer app's tagless "Simple Name";
# - set_name, set_code, number: as written; PriceCharting's set_name is its console without the leading "Pokemon";
# - finish: the finish column, or PriceCharting's [bracketed] words joined by ", ";
# - language, rarity: as written; PriceCharting's language is "Japanese" or "Chinese" from its console;
# - product_id: the TCGplayer product ID only (never PriceCharting's own id);
# - category: the game column as written (Collectr Category, Sorted Collection), or PriceCharting's "Pokemon" or, for
#   another game, its whole console;
# - watchlist: "true" for a watchlist row, else "";
# - grade: the grade as written, "" when ungraded;
# - list_type: Sorted's List Type ("Folder", "Deck").
FIELDS = ("quantity", "name", "simple_name", "set_name", "set_code", "number", "finish", "language", "rarity",
          "product_id", "category", "watchlist", "grade", "list_type")

ZIP_EXTENSIONS = (".csv", ".tsv", ".txt")
_ZIP_MAGIC = (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")
_ZIP_CHUNK = 64 * 1024
_SEP_LINE = re.compile(r'\s*"?\s*sep=([^"\r\n])\s*"?\s*', re.IGNORECASE)


class ImportRefused(Exception):
    """The file can't start an import. ``code`` is the API's error code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class SourceRow:
    # 1 for the first row after the header.
    row_number: int
    # The row's cells, as decoded, written back as one CSV line.
    raw_text: str
    # Every name in FIELDS -> its cell, normalised and stripped.
    fields: dict
    # The row's portfolio, folder or list, or None.
    group: str | None


@dataclass(frozen=True)
class SourceFile:
    # The detected source (one of SOURCES); for matching only, never shown.
    source: str
    # The header's cells, normalised and stripped.
    header: list
    rows: list
    # The FIELDS this file has a column for (#231: a blank rarity means something only where the file has a rarity
    # column).
    columns: frozenset = frozenset()


def normalise_cell(text: str) -> str:
    """Every cell, header cells included, goes through here before it is compared or stored: decklist import's
    normalisation (decklist_text.normalise), so zero-width characters are removed, no-break spaces read as spaces,
    the text is NFC and curly apostrophes read as "'". Callers strip."""
    return decklist_text.normalise(text)


class _Prefix(str):
    """A preset column matched by how it starts, for a header that carries a date or a price source."""


@dataclass(frozen=True)
class _Preset:
    source: str
    columns: tuple
    # Preset column -> field in FIELDS.
    fields: dict
    # The column holding the row's group, or None.
    group: str | None = None
    # Source-specific clean-up of a row's fields: shape(fields, cell), where cell(column) is that column's value.
    shape: object = None


def _pricecharting(fields: dict, cell) -> None:
    """Splits "Name [Variant] #N" (in either order) and "Pokemon [Japanese|Chinese] <set>"; the grade falls back to
    the grading company."""
    text = fields["name"]
    tags = [tag.strip() for tag in re.findall(r"\[([^\]]*)\]", text) if tag.strip()]
    text = re.sub(r"\[[^\]]*\]", " ", text)
    numbers = list(re.finditer(r"(?:^|\s)#(\S+)", text))
    if numbers:
        fields["number"] = numbers[-1].group(1)
        text = text[:numbers[-1].start()] + " " + text[numbers[-1].end():]
    fields["name"] = " ".join(text.split())
    fields["finish"] = ", ".join(tags)
    console = fields["set_name"]
    words = console.split()
    if words and words[0].casefold() in ("pokemon", "pokémon"):
        fields["category"] = words[0]
        fields["set_name"] = " ".join(words[1:])
        if len(words) > 1 and words[1].casefold() in ("japanese", "chinese"):
            fields["language"] = words[1]
    else:
        fields["category"] = console
    if fields["grade"].casefold() in ("", "ungraded"):
        fields["grade"] = cell("grading-company")


_TCGPLAYER_FIELDS = {"Quantity": "quantity", "Name": "name", "Simple Name": "simple_name", "Set": "set_name",
                     "Set Code": "set_code", "Card Number": "number", "Printing": "finish", "Language": "language",
                     "Rarity": "rarity", "Product ID": "product_id"}
_TCGPLAYER_12 = ("Quantity", "Name", "Simple Name", "Set", "Card Number", "Set Code", "Printing", "Condition",
                 "Language", "Rarity", "Product ID", "SKU")
_COLLECTR_FIELDS = {"Category": "category", "Set": "set_name", "Product Name": "name", "Card Number": "number",
                    "Rarity": "rarity", "Variance": "finish", "Grade": "grade", "Quantity": "quantity",
                    "Watchlist": "watchlist"}
_COLLECTR_14 = ("Portfolio Name", "Category", "Set", "Product Name", "Card Number", "Rarity", "Variance", "Grade",
                "Card Condition", "Average Cost Paid", "Quantity", _Prefix("Market Price"), "Watchlist", "Date Added")

PRESETS = (
    _Preset(TCGPLAYER_APP, _TCGPLAYER_12, _TCGPLAYER_FIELDS),
    _Preset(TCGPLAYER_APP, _TCGPLAYER_12 + ("Price", "Price Each"), _TCGPLAYER_FIELDS),
    _Preset(COLLECTR, _COLLECTR_14, _COLLECTR_FIELDS, "Portfolio Name"),
    _Preset(COLLECTR, _COLLECTR_14[:12] + ("Price Override", "Watchlist", "Date Added", "Notes"), _COLLECTR_FIELDS,
            "Portfolio Name"),
    _Preset(PRICECHARTING,
            ("id", "product-name", "console-name", "price-in-pennies", "include-string", "condition-string", "sku",
             "notes", "cost-basis-in-pennies", "quantity", "date-entered", "date-purchased", "grading-company",
             "grading-cert-id", "folder"),
            {"product-name": "name", "console-name": "set_name", "quantity": "quantity", "include-string": "grade"},
            "folder", _pricecharting),
    _Preset(TCG_COLLECTOR,
            ("TCG region", "Expansion", "Card number", "Card number sorting order", "Card name", "Rarity",
             "Card variant", "Card language", "Card condition", "Note", "Quantity"),
            {"Expansion": "set_name", "Card number": "number", "Card name": "name", "Rarity": "rarity",
             "Card variant": "finish", "Card language": "language", "Quantity": "quantity"}),
    _Preset(DRAGON_SHIELD,
            ("Folder Name", "Quantity", "Trade Quantity", "Card Name", "Set Code", "Set Name", "Card Number",
             "Condition", "Printing", "Language", "Price Bought", "Date Bought", "LOW", "MID", "MARKET"),
            {"Quantity": "quantity", "Card Name": "name", "Set Code": "set_code", "Set Name": "set_name",
             "Card Number": "number", "Printing": "finish", "Language": "language"},
            "Folder Name"),
    _Preset(SORTED,
            ("List Type", "List Name", "Collection", "Format", "Board", "Quantity", "Card Name", "Set Code", "Set Name",
             "Card Number", "Condition", "Printing", "Rarity", "Language", "Price Bought", "Date Bought",
             "Parent List Type", "Parent List Name", _Prefix("Current Price"), "List Cover Image",
             "Parent List Cover Image"),
            {"List Type": "list_type", "Collection": "category", "Quantity": "quantity", "Card Name": "name",
             "Set Code": "set_code", "Set Name": "set_name", "Card Number": "number", "Printing": "finish",
             "Rarity": "rarity", "Language": "language"},
            "List Name"),
)

# The loose fallback: a header cell, lower-cased with runs of anything but letters, digits and "#" as one space,
# names the field it fills. The first column naming a field wins.
_LOOSE_FIELDS = {
    "quantity": ("quantity", "qty", "count", "copies", "amount", "owned"),
    "name": ("name", "card name", "card", "product name", "product", "title"),
    "simple_name": ("simple name",),
    "set_name": ("set", "set name", "expansion", "expansion name"),
    "set_code": ("set code", "set id", "expansion code"),
    "number": ("number", "card number", "collector number", "card no", "no", "num", "nr", "#", "card #",
               "collector #"),
    "finish": ("finish", "printing", "variant", "variance", "card variant", "foil", "treatment"),
    "language": ("language", "card language", "lang"),
    "rarity": ("rarity",),
    "product_id": ("product id", "productid", "tcgplayer id", "tcgplayer product id"),
    "category": ("category", "game"),
    "watchlist": ("watchlist",),
    "grade": ("grade",),
}
_LOOSE_GROUP = ("folder", "folder name", "collection name", "list", "list name", "binder", "binder name", "portfolio",
                "portfolio name", "group")
_LOOSE_NAMES = {alias: name for name, aliases in _LOOSE_FIELDS.items() for alias in aliases}


def _key(text: str) -> str:
    """A header cell as presets compare it: normalised, whitespace collapsed, case-folded."""
    return " ".join(normalise_cell(text).split()).casefold()


def _loose_key(text: str) -> str:
    return re.sub(r"[^0-9a-z#]+", " ", _key(text)).strip()


@dataclass(frozen=True)
class _Layout:
    source: str
    # Field -> its column's index in the file.
    columns: dict
    # The group column's index, or None.
    group: int | None
    # Header key -> column index, for a preset's shape.
    positions: dict
    shape: object = None

    def read(self, record: list) -> tuple:
        cells = [normalise_cell(cell).strip() for cell in record]

        def at(index):
            return cells[index] if index is not None and index < len(cells) else ""

        fields = {name: at(self.columns.get(name)) for name in FIELDS}
        if self.shape:
            self.shape(fields, lambda column: at(self.positions.get(_key(column))))
        fields["watchlist"] = "true" if fields["watchlist"].casefold() == "true" else ""
        if fields["grade"].casefold() == "ungraded":
            fields["grade"] = ""
        return fields, (at(self.group) or None)


def _matches(cell: str, column: str) -> bool:
    if isinstance(column, _Prefix):
        return _key(cell).startswith(_key(column))
    return _key(cell) == _key(column)


def _layout(header: list) -> _Layout:
    """The header's preset, else the loose fallback; IMPORT_UNREADABLE when neither reads it."""
    positions = {}
    for index, cell in enumerate(header):
        positions.setdefault(_key(cell), index)
    for preset in PRESETS:
        if len(header) == len(preset.columns) and all(map(_matches, header, preset.columns)):
            return _Layout(preset.source, {field: positions[_key(column)] for column, field in preset.fields.items()},
                           positions[_key(preset.group)] if preset.group else None, positions, preset.shape)
    columns, group = {}, None
    for index, cell in enumerate(header):
        key = _loose_key(cell)
        if key in _LOOSE_NAMES:
            columns.setdefault(_LOOSE_NAMES[key], index)
        elif key in _LOOSE_GROUP and group is None:
            group = index
    readable = "product_id" in columns or (
        ("set_name" in columns or "set_code" in columns) and ("number" in columns or "name" in columns))
    if not readable:
        raise ImportRefused("IMPORT_UNREADABLE")
    return _Layout(LOOSE, columns, group, positions)


def _finder_metadata(name: str) -> bool:
    """macOS Finder's metadata entries (under __MACOSX/, named ._*, or .DS_Store): never read, never counted."""
    parts = name.split("/")
    return parts[0] == "__MACOSX" or parts[-1].startswith("._") or parts[-1] == ".DS_Store"


def _unzip(data: bytes) -> bytes:
    """The one file in a zip upload, decompressed as a stream and stopped past MAX_IMPORT_BYTES."""
    parts, size = [], 0
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        entries = [info for info in archive.infolist() if not info.is_dir() and not _finder_metadata(info.filename)]
        if len(entries) != 1 or any(info.flag_bits & 0x1 for info in archive.infolist()):
            raise ImportRefused("IMPORT_BAD_ZIP")
        entry = entries[0]
        if not entry.filename.lower().endswith(ZIP_EXTENSIONS):
            raise ImportRefused("IMPORT_BAD_ZIP")
        if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise ImportRefused("IMPORT_BAD_ZIP")
        if entry.file_size > MAX_IMPORT_BYTES:
            raise ImportRefused("IMPORT_TOO_LARGE")
        with archive.open(entry) as stream:
            while chunk := stream.read(_ZIP_CHUNK):
                size += len(chunk)
                if size > MAX_IMPORT_BYTES:
                    raise ImportRefused("IMPORT_TOO_LARGE")
                parts.append(chunk)
    except ImportRefused:
        raise
    except Exception:
        # A damaged, truncated or hostile archive: whatever zipfile or the decompressor raised.
        raise ImportRefused("IMPORT_BAD_ZIP") from None
    content = b"".join(parts)
    if content.startswith(_ZIP_MAGIC):
        raise ImportRefused("IMPORT_BAD_ZIP")
    return content


def _decode(data: bytes) -> str:
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        pass
    try:
        return data.removeprefix(b"\xef\xbb\xbf").decode("cp1252")
    except UnicodeDecodeError:
        raise ImportRefused("IMPORT_UNREADABLE") from None


def _delimiter(text: str) -> tuple:
    """(delimiter, text without a leading "sep=" line)."""
    first, _, rest = text.partition("\n")
    hint = _SEP_LINE.fullmatch(first)
    if hint:
        return hint.group(1), rest
    for line in text.splitlines():
        if line.strip():
            return ("\t" if line.count("\t") > line.count(",") else ","), text
    return ",", text


def _line(cells: list) -> str:
    buffer = io.StringIO()
    csv.writer(buffer, lineterminator="").writerow(cells)
    return buffer.getvalue()


def read(data: bytes) -> SourceFile:
    """The file's source rows. Refuses IMPORT_TOO_LARGE (over MAX_IMPORT_BYTES, raw or unzipped), IMPORT_BAD_ZIP,
    IMPORT_UNREADABLE (not text, a NUL character, not CSV, or a header neither a preset nor the fallback reads),
    IMPORT_EMPTY (a header and no rows) and IMPORT_TOO_MANY_ROWS (stopping at row MAX_IMPORT_ROWS + 1)."""
    if len(data) > MAX_IMPORT_BYTES:
        raise ImportRefused("IMPORT_TOO_LARGE")
    if data.startswith(_ZIP_MAGIC):
        data = _unzip(data)
    text = _decode(data)
    # PostgreSQL text and jsonb can't hold NUL, and no tracker writes one.
    if "\x00" in text:
        raise ImportRefused("IMPORT_UNREADABLE")
    delimiter, text = _delimiter(text)
    records = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)
    rows = []
    try:
        header = next((record for record in records if any(normalise_cell(cell).strip() for cell in record)), None)
        if header is None:
            raise ImportRefused("IMPORT_UNREADABLE")
        while not normalise_cell(header[-1]).strip():
            header.pop()
        layout = _layout(header)
        for record in records:
            if not any(normalise_cell(cell).strip() for cell in record):
                continue
            if len(rows) == MAX_IMPORT_ROWS:
                raise ImportRefused("IMPORT_TOO_MANY_ROWS")
            fields, group = layout.read(record)
            rows.append(SourceRow(len(rows) + 1, _line(record), fields, group))
    except csv.Error:
        raise ImportRefused("IMPORT_UNREADABLE") from None
    if not rows:
        raise ImportRefused("IMPORT_EMPTY")
    return SourceFile(layout.source, [normalise_cell(cell).strip() for cell in header], rows, frozenset(layout.columns))
