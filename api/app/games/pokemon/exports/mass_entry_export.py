"""Pure TCGplayer Mass Entry formatter for a captured private Deck.

Offers a quantity/product-ID link only when every row has a verified product ID, and otherwise
complete text. It never produces a partial link, a guessed product ID, a guessed TCGplayer set
code, or a text-prefill URL. Quantities are Python integers and are never capped or split in text.
"""
import re
from dataclasses import dataclass
from typing import Iterable, Iterator, Literal

MAX_URL_BYTES = 2000  # Local usability threshold for the fully percent-encoded URL, not a destination maximum.
MAX_LINK_QUANTITY = 999  # Local per-product policy; the destination's own limit is unverified.
BASE_URL = "https://www.tcgplayer.com/massentry?productline=Pokemon&c="
SEPARATOR = "%7C%7C"  # The observed "||" between segments, percent-encoded.
_UNSAFE = re.compile(r"[\x00-\x20\x7f-\x9f  ]+")


@dataclass(frozen=True)
class MassEntryInputRow:
    """One Edition row. `specificity` is a verified TCGplayer (set code, collector number), or None."""
    key: str
    printing_key: str
    display_name: str
    quantity: int
    product_id: int | None
    specificity: tuple[str, str] | None


@dataclass(frozen=True)
class MassEntryLine:
    quantity: int
    text: str
    less_specific: bool
    keys: tuple[str, ...]


@dataclass(frozen=True)
class MassEntryExport:
    status: Literal["link", "text", "empty"]
    url: str | None
    fallback_reason: Literal["missing_mapping", "encoded_length", "quantity_unsupported"] | None
    lines: tuple[MassEntryLine, ...]
    total_copies: int


def _clean(value: str) -> str:
    """Collapse control characters and whitespace so one card can never become several Mass Entry lines."""
    return _UNSAFE.sub(" ", value).strip()


def _lines(rows: list[MassEntryInputRow]) -> tuple[MassEntryLine, ...]:
    """One line per Printing, summing its Editions. Same-name Printings are never merged."""
    groups: dict[str, list[MassEntryInputRow]] = {}
    for item in rows:
        groups.setdefault(item.printing_key, []).append(item)
    lines = []
    for printing_key, members in groups.items():
        name = _clean(members[0].display_name) or "Unnamed card"
        specificity = next((m.specificity for m in members if m.specificity), None)
        quantity = sum(m.quantity for m in members)
        text = f"{quantity} {name}"
        if specificity:
            text += f" [{_clean(specificity[0])}] {_clean(specificity[1])}"
        lines.append((name.casefold(), printing_key, MassEntryLine(
            quantity, text, specificity is None, tuple(sorted(m.key for m in members)))))
    return tuple(line for *_, line in sorted(lines, key=lambda entry: entry[:2]))


def format_mass_entry(rows: Iterable[MassEntryInputRow], *, max_url_bytes: int = MAX_URL_BYTES,
                      max_link_quantity: int = MAX_LINK_QUANTITY) -> MassEntryExport:
    rows = list(rows)
    for item in rows:
        if not isinstance(item.quantity, int) or isinstance(item.quantity, bool) or item.quantity < 1:
            raise ValueError("Quantities must be positive integers")
    if not rows:
        return MassEntryExport("empty", None, None, (), 0)
    lines = _lines(rows)
    total = sum(item.quantity for item in rows)

    def text(reason):
        return MassEntryExport("text", None, reason, lines, total)

    if any(item.product_id is None for item in rows):
        return text("missing_mapping")
    products: dict[int, int] = {}
    for item in rows:
        products[item.product_id] = products.get(item.product_id, 0) + item.quantity
    if any(quantity > max_link_quantity for quantity in products.values()):
        return text("quantity_unsupported")
    url = BASE_URL + SEPARATOR.join(f"{products[product]}-{product}" for product in sorted(products))
    if len(url.encode("ascii")) > max_url_bytes:
        return text("encoded_length")
    return MassEntryExport("link", url, None, lines, total)


def iter_mass_entry_text(export: MassEntryExport) -> Iterator[str]:
    """Yield the complete text in chunks whose concatenation equals mass_entry_text(export)."""
    for index, line in enumerate(export.lines):
        yield line.text if index == 0 else "\n" + line.text


def mass_entry_text(export: MassEntryExport) -> str:
    return "".join(iter_mass_entry_text(export))
