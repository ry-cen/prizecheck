"""Pure validation of a fetched TCGdex card record against a published Edition mapping (08-A, plan 2.5).

``select_quote`` never touches the network or any store. Absence is only a matching block whose ``marketPrice`` is
null or missing (user decision D2); a missing block, a product mismatch or a 404 is a Failure, never Absent.
"""
import json
from dataclasses import dataclass
from datetime import datetime

from .catalog_targets import MatchingRulesV2, MatchingRulesV3
from app.quote_contract import parse_amount


def source_descriptor(variant: dict) -> dict:
    # Existing descriptor correspondence stays intact until the target-datastore
    # preflight: no cleaned keys, aliases or compatibility mapping are applied.
    descriptor = {key: value for key, value in variant.items()
                  if key not in ("variantId", "pricing", "cardmarket", "tcgplayer") and value is not None}
    if isinstance(descriptor.get("stamps"), list):
        descriptor["stamps"] = sorted(descriptor["stamps"], key=lambda value: json.dumps(value, sort_keys=True))
    return descriptor


def priced_variant(record: dict, variant: dict) -> dict:
    """``variant`` with a TCGplayer block: its own, or the card's when it lists none.

    TCGdex often keeps the card's TCGplayer block (one entry per finish) on the card instead of repeating it inside each
    variant. Whether a variant borrows it is the reviewed rule's decision (``MatchingRulesV3.borrowed_block``); the
    matching rule and the price fetch then narrow it to the variant's entry exactly as they narrow a block the variant
    repeats. A variant that borrows nothing keeps the card's block as printing-level evidence.
    """
    pricing = variant.get("pricing")
    if isinstance(pricing, dict) and isinstance(pricing.get("tcgplayer"), dict):
        return variant
    detailed = record.get("variants_detailed") if isinstance(record, dict) else None
    siblings = [source_descriptor(item) for item in distinct_variants(detailed) if isinstance(item, dict)] if isinstance(detailed, list) else []
    block = MatchingRulesV3.borrowed_block(record.get("pricing") if isinstance(record, dict) else None,
                                           source_descriptor(variant), siblings)
    if block is None:
        return variant
    return {**variant, "pricing": {**(pricing if isinstance(pricing, dict) else {}), "tcgplayer": block}}


def distinct_variants(detailed: list) -> list:
    """TCGdex lists some variants twice, entry for entry. One entry stands for the pair; entries that share a
    descriptor but differ in lookup identity remain a collision."""
    seen, result = set(), []
    for item in detailed:
        key = json.dumps(item, sort_keys=True) if isinstance(item, dict) else None
        if key is None or key not in seen:
            result.append(item)
        if key is not None:
            seen.add(key)
    return result


@dataclass(frozen=True)
class Quote:
    amount: str
    card: str
    variant: str
    provider_updated_at: str | None


@dataclass(frozen=True)
class Absent:
    pass


@dataclass(frozen=True)
class Failure:
    reason: str   # one of 'malformed', 'lookup_drift', 'ambiguous'


def _provider_updated_at(value):
    """The source's own timestamp, or None when missing, unparsable or naive. Never the current time."""
    if type(value) is not str or not 0 < len(value) <= 40:
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return value if moment.tzinfo is not None and moment.utcoffset() is not None else None


def select_quote(record, descriptor, lookup, product_id) -> Quote | Absent | Failure:
    if not isinstance(lookup, dict) or type(lookup.get('card')) is not str or type(lookup.get('variant')) is not str:
        return Failure('malformed')
    if not isinstance(record, dict) or record.get('id') != lookup['card']:
        return Failure('malformed')
    detailed = record.get('variants_detailed')
    if not isinstance(detailed, list) or not isinstance(descriptor, dict):
        return Failure('malformed')
    matches = [item for item in distinct_variants(detailed) if isinstance(item, dict) and source_descriptor(item) == descriptor]
    if not matches:
        return Failure('lookup_drift')
    if len(matches) > 1:
        return Failure('ambiguous')
    variant = lookup['variant']
    # The variant block may repeat the card's other finishes, or come from the card; only the published variant's entry is read.
    entry = MatchingRulesV2.narrow(priced_variant(record, matches[0]), variant)
    problem, products = MatchingRulesV2.products(entry)
    if problem is not None or set(products) != {variant} or product_id is None or str(products[variant]) != str(product_id):
        return Failure('lookup_drift')
    node = entry['pricing']['tcgplayer'][variant]
    price = node.get('marketPrice')
    if price is None:
        return Absent()
    if type(price) is int:
        price = str(price)
    amount = parse_amount(price)
    if amount is None:
        return Failure('malformed')
    return Quote(price, lookup['card'], variant, _provider_updated_at(entry['pricing']['tcgplayer'].get('updated')))
