"""The in-memory result of normalising one TCGCSV group (#534).

Nothing here is a schema, a `catalog_*` row or a source value for the database. A candidate is a proposal the
writer has yet to decide on. Behaviour the owner has not decided is never applied: the product stays in the
output and carries a flag from FLAGS naming the open question, with the source data intact.
"""
from dataclasses import dataclass, field
from typing import Optional, Tuple

# Owner-approved grouping (2026-11-09): same name, or the same name plus an `(Alternate Art)` marker, is one Card
# Identity; same name with conflicting rules text goes to review and is never merged.
FLAG_IDENTITY_TEXT_CONFLICT = 'identity_text_conflict'

# "Retained and flagged, policy pending": the acceptance spec proposes an answer (PC-2, PC-5, PC-9 and the marker
# and duplicate-number cases), but the owner has not adopted it.
FLAG_CARD_SCOPE_PENDING = 'card_scope_pending'
FLAG_FINISH_POLICY_PENDING = 'finish_policy_pending'
FLAG_MARKER_GROUPING_PENDING = 'marker_grouping_pending'
FLAG_DUPLICATE_NUMBER_PENDING = 'duplicate_number_pending'
# A multi-value field with an apparent delimiter other than the verified one; the value is kept raw.
FLAG_MULTI_VALUE_UNPARSED = 'multi_value_delimiter_unrecognised'
# A price row for a product the group's product list does not have.
FLAG_PRICE_WITHOUT_PRODUCT = 'price_without_product'
# An extended field name that appears more than once on a product: every value is kept, none is chosen.
FLAG_EXTENDED_FIELD_REPEATED = 'extended_field_repeated'
# Printings grouped into one identity by name and rules text that disagree on other card details (Domain, Tag, Card
# Type, costs, Might; not Rarity, which belongs to each printing). The identity is kept and not split; the flag names the fields and sends it to review.
FLAG_PRINTING_DETAILS_DIFFER = 'printing_details_differ'

FLAGS = (FLAG_IDENTITY_TEXT_CONFLICT, FLAG_CARD_SCOPE_PENDING, FLAG_FINISH_POLICY_PENDING,
         FLAG_MARKER_GROUPING_PENDING, FLAG_DUPLICATE_NUMBER_PENDING, FLAG_MULTI_VALUE_UNPARSED,
         FLAG_PRICE_WITHOUT_PRODUCT, FLAG_EXTENDED_FIELD_REPEATED, FLAG_PRINTING_DETAILS_DIFFER)


@dataclass(frozen=True)
class PrintingKey:
    """The source product within its group (set). The same Number in two groups gives two keys."""
    group_id: int
    product_id: int


@dataclass(frozen=True)
class CardScope:
    """What the product has, as observed. It does not say whether the product is a card."""
    has_number: bool
    has_card_type: bool
    card_types: Tuple[str, ...]
    card_type_unparsed: bool  # the Card Type had an unrecognised separator and was kept raw
    looks_sealed: bool  # neither a Number nor a Card Type
    looks_token: bool   # `Token` is one of the Card Type values


@dataclass(frozen=True)
class PriceObservation:
    """One price row as the source gave it. Carried as data; it never decides whether an Edition exists."""
    low: Optional[float]
    mid: Optional[float]
    high: Optional[float]
    market: Optional[float]
    direct_low: Optional[float]


@dataclass(frozen=True)
class EditionCandidate:
    """A price subtype the product has. `finish` is None for a subtype outside FINISH_BY_SUBTYPE."""
    subtype: str
    finish: Optional[str]
    prices: Tuple[PriceObservation, ...]  # one per price row with this subtype
    flags: Tuple[str, ...] = ()


@dataclass(frozen=True)
class PrintingCandidate:
    key: PrintingKey
    name: str
    clean_name: Optional[str]
    base_name: str            # name with a trailing parenthetical marker removed
    marker: Optional[str]     # the trailing parenthetical's text, if any
    identity_key: Optional[str]  # None while the product awaits review
    number: Optional[str]     # the source's form, e.g. `001/100`
    rarity: Optional[str]
    scope: CardScope
    card_types: Tuple[str, ...]
    domains: Tuple[str, ...]
    tags: Tuple[str, ...]
    energy_cost: Optional[str]
    power_cost: Optional[str]
    might: Optional[str]
    description_html: Optional[str]
    flavor_text_html: Optional[str]   # raw, with the source's HTML
    flavor_text_plain: Optional[str]
    image_url: Optional[str]
    modified_on: Optional[str]
    # The first value of each extended field name, raw. Convenience only; extended_entries has every entry.
    extended: dict = field(hash=False)
    extended_entries: Tuple[Tuple[str, Optional[str]], ...]  # every (name, value), in source order
    price_subtypes: Tuple[str, ...]   # observed, in source order, without repeats
    editions: Tuple[EditionCandidate, ...]
    flags: Tuple[str, ...] = ()


@dataclass(frozen=True)
class IdentityCandidate:
    """Group-local: `identity_key` is unique only within the group it came from. Matching an identity across
    groups, and conflicts between groups, are the writer's open problem."""
    identity_key: str
    display_name: str
    printings: Tuple[PrintingKey, ...]


@dataclass(frozen=True)
class ReviewItem:
    code: str          # one of FLAGS
    product_ids: Tuple[int, ...]
    detail: str


@dataclass(frozen=True)
class GroupResult:
    group_id: Optional[int]
    identities: Tuple[IdentityCandidate, ...]
    printings: Tuple[PrintingCandidate, ...]
    review: Tuple[ReviewItem, ...]
    counts: dict = field(default_factory=dict, hash=False)
