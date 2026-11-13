"""Identity helpers for TCGdex card records: the source descriptor of a variant, the TCGplayer block a variant
carries or borrows, and duplicate-variant folding. Used by catalog import and metadata review; pure, no I/O."""
import json

from .catalog_targets import MatchingRulesV3


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
