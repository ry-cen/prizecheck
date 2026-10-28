"""Reviewed Live and Marketplace target state for catalog Printings and Editions.

Source data supplies candidates, never approvals. Rules live in code as versioned
registries; a database row records which version the maintainer activated and the
digest of the code that was approved. A rule whose version or digest no longer matches
is treated as inactive, so changed code cannot silently approve anything.

State only moves toward caution on import. A verified mapping or eligible Live
Printing that is contradicted becomes quarantined or suspended, and only a maintainer
decision (not an import, not a rule activation) can clear it. Everything here runs inside
the caller's transaction after ``catalog_begin_correction()`` has taken the clock.
"""
import hashlib
import inspect
import json
import os
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, replace


def number_key(number):
    """The comparison key of a card number: trimmed, uppercase, any "/total" dropped and the leading zeros of the first
    digit run removed (DP05 -> DP5, SWSH001 -> SWSH1, 001 -> 1, XY01 -> XY1; 000 -> 0). None for a missing number.
    tcgplayer_product.number_key is filled with it, and matching rule v4 (design section 4.4) must use the same function."""
    if number is None:
        return None
    text = unicodedata.normalize("NFC", str(number)).strip().split("/", 1)[0].strip().upper()
    if not text:
        return None
    return re.sub(r"\d+", lambda run: run.group().lstrip("0") or "0", text, count=1)



LIVE = "live_derivation"
MATCHING = "marketplace_matching"
UNSPECIFIED_LABEL = "Unspecified Variant"
IDENTITY_REVIEW_KINDS = ("name_change", "reference_change", "variant_ambiguity")


def canonical(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def fingerprint(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def normalized_name(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).split())


def is_unspecified(descriptor) -> bool:
    return isinstance(descriptor, dict) and descriptor.get("label") == UNSPECIFIED_LABEL


# ---------------------------------------------------------------- rules


@dataclass(frozen=True)
class Failure:
    reason: str


class LiveRulesV1:
    """Deterministic Live identity {category, name, set_code, number}.

    Two reviewed paths feed it. A maintainer supplies per-Printing inputs, or an
    uncontested Printing is qualified from its source export candidate through the
    reviewed set table. The table ships empty: no Live set code is evidenced in this
    repository, and codes are never guessed from ``tcgOnline`` or invented.

    Changing this class, its table or the helpers below changes ``code_digest``, and a changed
    digest deactivates the approved rule (every eligible Printing the next import touches
    would be suspended as ``no_active_rule``). A new set code therefore ships as a new
    ``LiveRulesV2`` registered next to V1 and activated by a maintainer; it is never an edit
    of V1. ``test_registered_rule_digests_are_pinned`` fails on any unplanned change.
    """
    CATEGORIES = frozenset(("Pokemon", "Trainer", "Energy"))
    SET_CODES: dict = {}
    SET_CODE = re.compile(r"^[A-Z0-9-]{1,10}$")
    NUMBER = re.compile(r"^[A-Za-z0-9-]{1,20}$")

    @classmethod
    def table(cls):
        return {"categories": sorted(cls.CATEGORIES), "set_codes": dict(cls.SET_CODES)}

    @classmethod
    def _identity(cls, category, name, set_code, number):
        if not isinstance(category, str) or category not in cls.CATEGORIES:
            return Failure("missing_input")
        if not isinstance(name, str) or not normalized_name(name):
            return Failure("missing_input")
        if not isinstance(set_code, str) or not cls.SET_CODE.fullmatch(set_code):
            return Failure("missing_input")
        if isinstance(number, int) and not isinstance(number, bool):
            number = str(number)
        number = number.strip() if isinstance(number, str) else ""
        if not cls.NUMBER.fullmatch(number):
            return Failure("missing_input")
        return {"category": category, "name": normalized_name(name), "set_code": set_code, "number": number}

    @classmethod
    def projection(cls, export):
        """The source fields ``derive_source`` reads. Only a change here may close an eligible Printing."""
        if not isinstance(export, dict):
            return {}
        source_set = export.get("set")
        return {"category": export.get("category"), "name": export.get("name"), "localId": export.get("localId"),
                "set_id": source_set.get("id") if isinstance(source_set, dict) else None}

    @classmethod
    def derive_reviewed(cls, inputs):
        if not isinstance(inputs, dict):
            return Failure("missing_input")
        return cls._identity(inputs.get("category"), inputs.get("name"), inputs.get("set_code"), inputs.get("collector_number"))

    @classmethod
    def derive_source(cls, export, display=None):
        if not isinstance(export, dict) or not export:
            return Failure("missing_input")
        source_set = export.get("set")
        set_id = source_set.get("id") if isinstance(source_set, dict) else None
        category, name, number = export.get("category"), export.get("name"), export.get("localId")
        base = cls._identity(category, name, "X", number)  # validates everything except the set code
        if isinstance(base, Failure) or not isinstance(set_id, str) or not set_id:
            return Failure("missing_input")
        code = cls.SET_CODES.get(set_id)
        if code is None:
            return Failure("rule_uncovered")
        if display is not None and (normalized_name(name) != display["display_name"] or str(number).strip() != display["collector_number"]
                                    or set_id != display["set_id"]):
            return Failure("conflicting_input")  # The source no longer describes the established Printing.
        return cls._identity(category, name, code, number)


class MatchingRulesV1:
    """Marketplace matching: product identity and quote variant are separate checks.

    Product check: the source variant corresponds exactly (``source_candidate``), the
    source set, collector number and name equal the established display, and exactly one
    TCGplayer product ID exists in that variant's block that no other Printing's verified
    Edition already holds. Variant check: a reviewed finish table names exactly one quote
    variant key inside the same block. Equal names or prices never pass.
    """
    VARIANT_KEYS = {"normal": "normal", "reverse": "reverse-holofoil", "holo": "holofoil"}
    BLOCK_METADATA = frozenset(("unit", "updated"))

    @classmethod
    def table(cls):
        return {"variant_keys": dict(cls.VARIANT_KEYS)}

    @classmethod
    def products(cls, lookup):
        """(problem|None, {variant key: product id}) for the candidate's TCGplayer block."""
        pricing = lookup.get("pricing") if isinstance(lookup, dict) else None
        block = pricing.get("tcgplayer") if isinstance(pricing, dict) else None
        if not isinstance(block, dict):
            return "no_product", {}
        found = {key: value["productId"] for key, value in block.items()
                 if key not in cls.BLOCK_METADATA and isinstance(value, dict) and "productId" in value}
        if not found:
            return "no_product", {}
        if len(found) != 1 or any(isinstance(value, bool) or not isinstance(value, int) or value < 1 for value in found.values()):
            return "conflict", found
        third_party = lookup.get("thirdParty")
        listed = third_party.get("tcgplayer") if isinstance(third_party, dict) else None
        if listed is not None and listed != next(iter(found.values())):
            return "conflict", found
        return None, found

    @classmethod
    def projection(cls, correspondence, lookup):
        """The candidate inputs ``evaluate`` reads: correspondence, the TCGplayer product IDs by variant key and thirdParty.tcgplayer.

        Other lookup identifiers (a Cardmarket ID, a variant ID) are enrichment: they never close a verified mapping.
        """
        pricing = lookup.get("pricing") if isinstance(lookup, dict) else None
        block = pricing.get("tcgplayer") if isinstance(pricing, dict) else None
        products = ({key: value["productId"] for key, value in block.items()
                     if key not in cls.BLOCK_METADATA and isinstance(value, dict) and "productId" in value}
                    if isinstance(block, dict) else {})
        third_party = lookup.get("thirdParty") if isinstance(lookup, dict) else None
        return {"correspondence": correspondence, "products": products,
                "third_party_tcgplayer": third_party.get("tcgplayer") if isinstance(third_party, dict) else None}

    @classmethod
    def variant(cls, descriptor, key):
        keys = set(descriptor)
        finish = descriptor.get("type", descriptor.get("finish"))
        if not (keys & {"type", "finish"}) or keys - {"type", "finish", "size"} or ("type" in keys and "finish" in keys):
            return None
        if descriptor.get("size", "standard") != "standard":
            return None
        return key if cls.VARIANT_KEYS.get(finish) == key else None

    @classmethod
    def evaluate(cls, facts, verified_elsewhere):
        """-> (product_id, quote_variant|None) or Failure(reason)."""
        if (facts["correspondence"] != "source_candidate" or is_unspecified(facts["descriptor"])
                or facts["source"] != "tcgdex" or not facts["source_id"]):
            return Failure("not_established")
        record, display = facts["source_record"], facts["display"]
        source_set = record.get("set") if isinstance(record, dict) else None
        if (not display or not isinstance(source_set, dict) or source_set.get("id") != display["set_id"]
                or str(record.get("localId")) != display["collector_number"]
                or not isinstance(record.get("name"), str) or normalized_name(record["name"]) != display["display_name"]):
            return Failure("physical_mismatch")
        problem, found = cls.products(facts["lookup"])
        if problem:
            return Failure(problem)
        [(key, product)] = found.items()
        variant = cls.variant(facts["descriptor"], key)
        if verified_elsewhere(product, variant):
            return Failure("duplicate")
        return product, variant


class MatchingRulesV2(MatchingRulesV1):
    """V1, read through the reviewed finish table when a variant block lists several products.

    TCGdex repeats the card's whole TCGplayer block, one entry per finish key, inside every variant. V1 refuses any
    block with more than one product. V2 keeps only the entry the finish table names for this Edition's descriptor and
    then applies every V1 check to it, the thirdParty ID included. A descriptor the table does not cover, or a block
    without that key, is left as it is, so V1's checks still fail it.
    """

    @classmethod
    def finish_key(cls, descriptor):
        return next((key for key in cls.VARIANT_KEYS.values() if cls.variant(descriptor, key) == key), None)

    @classmethod
    def narrow(cls, lookup, key):
        """``lookup`` with its TCGplayer block cut to ``key`` and the block metadata, when the block lists several products."""
        pricing = lookup.get("pricing") if isinstance(lookup, dict) else None
        block = pricing.get("tcgplayer") if isinstance(pricing, dict) else None
        if key is None or not isinstance(block, dict) or not isinstance(block.get(key), dict):
            return lookup
        if sum(1 for name, value in block.items()
               if name not in cls.BLOCK_METADATA and isinstance(value, dict) and "productId" in value) < 2:
            return lookup
        kept = {name: value for name, value in block.items() if name == key or name in cls.BLOCK_METADATA}
        return {**lookup, "pricing": {**pricing, "tcgplayer": kept}}

    @classmethod
    def evaluate(cls, facts, verified_elsewhere):
        lookup = cls.narrow(facts["lookup"], cls.finish_key(facts["descriptor"]))
        return super().evaluate({**facts, "lookup": lookup}, verified_elsewhere)


class MatchingRulesV3(MatchingRulesV2):
    """V2, with the variant's lookup identity set aside before the finish is read.

    TCGdex lists a variant's ``thirdParty`` IDs inside the variant itself, so they reach the Edition descriptor. V1 and
    V2 read any key beyond type/finish/size as an extra facet, so those descriptors named no finish and never matched.
    V3 drops ``thirdParty`` from the descriptor only; the lookup's own ``thirdParty.tcgplayer`` is still checked against
    the selected product.

    TCGdex also often keeps the card's TCGplayer block on the card instead of inside each variant. ``borrowed_block``
    decides when a variant without a block of its own reads the card's; the import and the price fetch both ask it.
    """
    LOOKUP_KEYS = frozenset(("thirdParty",))

    @classmethod
    def plain(cls, descriptor):
        if not isinstance(descriptor, dict):
            return descriptor
        return {key: value for key, value in descriptor.items() if key not in cls.LOOKUP_KEYS}

    @classmethod
    def borrowed_block(cls, card_pricing, descriptor, sibling_descriptors):
        """The card's TCGplayer block for a variant that lists none, or None.

        Only for a plain finish the finish table covers, when the card's block has a product for that finish and no
        sibling variant reads as the same finish once ``thirdParty`` is set aside: two such siblings would otherwise
        contend for one entry, and which one won would depend on row order. Every other variant borrows nothing.
        """
        block = card_pricing.get("tcgplayer") if isinstance(card_pricing, dict) else None
        plain = cls.plain(descriptor)
        key = cls.finish_key(plain) if isinstance(plain, dict) else None
        if not isinstance(block, dict) or key is None or not isinstance(block.get(key), dict) or "productId" not in block[key]:
            return None
        if [cls.plain(sibling) for sibling in sibling_descriptors].count(plain) != 1:
            return None
        return block

    @classmethod
    def evaluate(cls, facts, verified_elsewhere):
        return super().evaluate({**facts, "descriptor": cls.plain(facts["descriptor"])}, verified_elsewhere)


class MatchingRulesV4(MatchingRulesV3):
    """V3, then two more reviewed product sources, both behind every V1 physical check.

    1. The variant's own TCGdex ``thirdParty.tcgplayer`` ID, when V3 finds no product in the priced block (the block is
       absent or lists none). V3's ``conflict`` outcomes are never overridden.
    2. The reviewed Black Star promo path, only for a Printing with no TCGdex product ID anywhere whose set is in
       ``TCGPLAYER_GROUPS``: the TCGCSV group's products on the card's number, accepted when exactly one has a name that
       equals the card's name once one trailing number qualifier is removed. Only an Edition without a special facet
       (a stamp other than 1st Edition, foil, another subtype or size) takes it. Everything else stays ``no_product``.

    New sets or changes to the name rule ship as a later rule version, never as an edit of this class.
    """
    TCGPLAYER_GROUPS = {"basep": 1418, "np": 1423, "dpp": 1421, "hgssp": 1453, "bwp": 1407, "xyp": 1451, "smp": 1861,
                        "swshp": 2545, "svp": 22872, "mep": 24451}
    FIRST_EDITION = "1st-edition"
    PLAIN_FACETS = frozenset(("type", "finish", "size", "subtype", "stamp"))
    PAREN_QUALIFIER = re.compile(r" \(([^()]+)\)$")

    @classmethod
    def table(cls):
        # number_key (above, in this module) fills tcgplayer_product.number_key; its source is part of the approved rule.
        return {**super().table(), "tcgplayer_groups": dict(cls.TCGPLAYER_GROUPS), "number_key": _source(number_key)}

    @classmethod
    def number_key(cls, number):
        return number_key(number)

    @staticmethod
    def fold(text):
        return " ".join(unicodedata.normalize("NFC", text).split()).casefold()

    @classmethod
    def match_name(cls, product_name, number):
        """The product name, folded, minus one trailing " - <n>" or " (<n>)" qualifier naming this card's own number."""
        name, own = cls.fold(product_name), cls.number_key(number)
        head, dash, tail = name.rpartition(" - ")
        if dash and own is not None and not re.search(r"[()\[\]]", tail) and cls.number_key(tail) == own:
            return head.rstrip()
        found = cls.PAREN_QUALIFIER.search(name)
        if found and own is not None and cls.number_key(found.group(1)) == own:
            return name[:found.start()].rstrip()
        return name

    @classmethod
    def listed_product(cls, lookup):
        third_party = lookup.get("thirdParty") if isinstance(lookup, dict) else None
        return third_party.get("tcgplayer") if isinstance(third_party, dict) else None

    @classmethod
    def has_tcgdex_id(cls, lookup):
        return bool(cls.products(lookup)[1]) or cls.listed_product(lookup) is not None

    @classmethod
    def record_has_tcgdex_id(cls, record):
        """Whether the card record names a TCGplayer product anywhere: the card's own block or any variant's."""
        if not isinstance(record, dict):
            return False
        detailed = record.get("variants_detailed")
        return cls.has_tcgdex_id(record) or (isinstance(detailed, list) and any(cls.has_tcgdex_id(item) for item in detailed))

    @classmethod
    def matched_by_number(cls, facts):
        """Whether the card-number path is what can name this Edition's product: the Printing has no TCGdex ID anywhere
        (not on this variant, nor on the card or a sibling variant)."""
        display = facts.get("display")
        return (bool(display) and display["set_id"] in cls.TCGPLAYER_GROUPS and not cls.has_tcgdex_id(facts["lookup"])
                and not cls.record_has_tcgdex_id(facts.get("source_record")))

    @classmethod
    def special(cls, descriptor):
        plain = cls.plain(descriptor)
        stamps = plain.get("stamp") or []
        return (bool(set(plain) - cls.PLAIN_FACETS) or plain.get("size", "standard") != "standard"
                or plain.get("subtype") not in (None, "unlimited", "shadowless")
                or not isinstance(stamps, list) or any(stamp != cls.FIRST_EDITION for stamp in stamps))

    @classmethod
    def promo_product(cls, facts):
        """The one TCGCSV product on the card's number whose name equals the card's, or None."""
        if cls.special(facts["descriptor"]):
            return None
        display = facts["display"]
        wanted = cls.fold(display["display_name"])
        exact = {candidate["product_id"] for candidate in facts.get("tcgplayer_candidates") or ()
                 if cls.match_name(candidate["name"], display["collector_number"]) == wanted}
        return next(iter(exact)) if len(exact) == 1 else None

    @classmethod
    def evaluate(cls, facts, verified_elsewhere):
        result = super().evaluate(facts, verified_elsewhere)
        if not (isinstance(result, Failure) and result.reason == "no_product"):
            return result
        listed = cls.listed_product(facts["lookup"])
        if type(listed) is int and 1 <= listed <= 2**31 - 1:
            product = listed
        elif cls.matched_by_number(facts):
            product = cls.promo_product(facts)
        else:
            product = None
        if product is None:
            return result
        variant = cls.finish_key(cls.plain(facts["descriptor"]))
        return Failure("duplicate") if verified_elsewhere(product, variant) else (product, variant)


LIVE_RULES = {1: LiveRulesV1}
MATCHING_RULES = {1: MatchingRulesV1, 2: MatchingRulesV2, 3: MatchingRulesV3, 4: MatchingRulesV4}
REGISTRIES = {LIVE: LIVE_RULES, MATCHING: MATCHING_RULES}


def _source(obj):
    try:
        return inspect.getsource(obj)
    except (OSError, TypeError):
        return getattr(obj, "__qualname__", repr(obj))


def code_digest(kind: str, version: int) -> str:
    """sha256 of the rule's reviewed table plus all interpreter source it executes.

    Inherited rule classes and the shared helpers are covered, so a subclass cannot
    pick up unreviewed logic from its base without changing the approved digest.
    """
    rule = REGISTRIES[kind][version]
    parts = [canonical(rule.table())]
    parts += [_source(klass) for klass in rule.__mro__ if klass is not object]
    parts += [_source(helper) for helper in (normalized_name, is_unspecified, canonical)]
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


@dataclass(frozen=True)
class ActiveRule:
    kind: str
    version: int
    activation_id: object
    rule: type


def load_active(conn, kind):
    row = conn.execute("""SELECT a.id,a.version,a.code_digest FROM catalog_rule_state s
      JOIN catalog_rule_activation a ON a.id=s.activation_id WHERE s.kind=%s""", (kind,)).fetchone()
    if not row or row["version"] is None:
        return None
    rule = REGISTRIES[kind].get(row["version"])
    if rule is None or code_digest(kind, row["version"]) != row["code_digest"]:
        return None  # Fail closed: unknown version or code that is no longer the approved code.
    return ActiveRule(kind, row["version"], row["id"], rule)


# ---------------------------------------------------------------- marketplace state


@dataclass(frozen=True)
class EditionState:
    state: str = "unverified"
    reason: str | None = None
    product_id: int | None = None
    quote_variant: str | None = None
    basis: str | None = None
    decision_id: object = None
    activation_id: object = None
    accepted_fingerprint: str | None = None
    auto_closed: bool = False
    accepted_projection: str | None = None  # fingerprint of the rule inputs of the accepted candidate


EDITION_COLUMNS = ("mapping_state", "mapping_reason", "product_id", "quote_variant", "mapping_basis", "mapping_decision_id",
                   "matching_activation_id", "accepted_fingerprint", "auto_closed", "accepted_projection")


def edition_state(row) -> EditionState:
    return EditionState(*(row[column] for column in EDITION_COLUMNS))


def _product_variant(facts, found):
    [(key, product)] = found.items()
    return product, MatchingRulesV1.variant(facts["descriptor"], key)


def evaluate_edition(current, facts, rejections, active, verified_elsewhere):
    """Next marketplace state for one Edition given a changed or re-examined candidate.

    ``facts`` carries: fingerprint, correspondence, lookup, descriptor, source, source_id,
    source_record and display. ``rejections`` are source fingerprints a maintainer already
    rejected. ``verified_elsewhere(product_id)`` says another Printing's verified Edition
    holds that product. Returns a new EditionState.
    """
    candidate_fp = facts["fingerprint"]
    if current.state == "quarantined":
        return current  # Strict clearing: nothing but a maintainer decision lifts it.
    projection_fp = fingerprint(MatchingRulesV1.projection(facts["correspondence"], facts["lookup"]))
    if current.state == "verified":
        if candidate_fp == current.accepted_fingerprint or candidate_fp in rejections:
            return current
        if current.accepted_projection is not None and projection_fp == current.accepted_projection:
            return replace(current, accepted_fingerprint=candidate_fp)  # enrichment the rule never reads: accept silently
        problem, found = MatchingRulesV1.products(facts["lookup"])
        if facts["correspondence"] == "unresolved":
            reason = "physical_conflict"
        elif problem == "conflict":
            reason = "candidate_conflict"
        elif problem is None and verified_elsewhere(*_product_variant(facts, found)):
            reason = "duplicate_mapping"
        else:
            reason = "candidate_changed"
        return replace(current, state="quarantined", reason=reason, auto_closed=True)
    # unverified
    if is_unspecified(facts["descriptor"]):
        return replace(current, reason="unspecified_variant")
    if current.reason == "reviewed_unmapped":
        return current
    if current.auto_closed:
        return replace(current, reason=current.reason or "no_matching_rule")
    if active is None:
        return replace(current, reason="no_matching_rule")  # no rejection lookup needed on the default path
    if candidate_fp in rejections:
        return replace(current, reason="reviewed_unmapped")
    result = active.rule.evaluate(facts, verified_elsewhere)
    if isinstance(result, Failure):
        return replace(current, reason="duplicate_mapping" if result.reason == "duplicate" else "rule_failed")
    product_id, quote_variant = result
    return EditionState(state="verified", reason=None, product_id=product_id, quote_variant=quote_variant,
                        basis="matching_rule", activation_id=active.activation_id, accepted_fingerprint=candidate_fp,
                        auto_closed=True, accepted_projection=projection_fp)


def complete_quote_variant(current, facts, active, verified_elsewhere):
    """A matching-rule Edition verified without a quote variant gets the one the active rule now names.

    Only while the accepted candidate is unchanged and the active rule confirms the same product; the state, product and
    basis stay as they are, and the activation that named the variant is recorded. Anything else returns ``current``.
    """
    if (current.state != "verified" or current.quote_variant is not None or current.basis != "matching_rule"
            or active is None or facts["fingerprint"] != current.accepted_fingerprint):
        return current
    result = active.rule.evaluate(facts, verified_elsewhere)
    if isinstance(result, Failure) or result[0] != current.product_id or result[1] is None:
        return current
    return replace(current, quote_variant=result[1], activation_id=active.activation_id)


# ---------------------------------------------------------------- Live state


@dataclass(frozen=True)
class PrintingState:
    state: str = "unsupported"
    reason: str | None = "no_active_rule"
    basis: str | None = None
    inputs: object = None
    identity: object = None
    claim: str | None = None
    decision_id: object = None
    activation_id: object = None
    accepted_fingerprint: str | None = None
    auto_closed: bool = False
    accepted_projection: str | None = None  # fingerprint of the rule inputs of the accepted export candidate


PRINTING_COLUMNS = ("live_state", "live_reason", "live_basis", "live_inputs", "live_identity", "live_claim",
                    "live_decision_id", "live_activation_id", "live_accepted_fingerprint", "live_auto_closed",
                    "live_accepted_projection")


def printing_state(row) -> PrintingState:
    return PrintingState(*(row[column] for column in PRINTING_COLUMNS))


def claim_key(identity) -> str:
    return f"{identity['set_code'].casefold()}|{identity['number'].casefold()}"


def evaluate_printing(current, export_candidate, contested, rejections, active, collides, reviewed=False, display=None):
    """Next Live state for one Printing.

    ``contested`` is True while an identity review (name, reference or variant) is pending.
    ``collides(claim)`` says another Printing derives the same set code and number.
    ``reviewed`` marks a maintainer decision being applied, which alone may lift suspension.
    ``display`` is the established Printing display, which a source-derived identity must match.
    """
    candidate_fp = fingerprint(export_candidate)
    projection_fp = fingerprint(LiveRulesV1.projection(export_candidate) if active is None else active.rule.projection(export_candidate))
    if not reviewed:
        if current.state == "suspended":
            return current
        if current.state == "unsupported" and (current.auto_closed or current.reason == "reviewed_unsupported"):
            return current
    maintainer = current.decision_id is not None and current.inputs is not None
    derived = Failure("no_active_rule")
    if active is not None:
        derived = (active.rule.derive_reviewed(current.inputs) if maintainer else active.rule.derive_source(export_candidate, display))
    claim = claim_key(derived) if isinstance(derived, dict) else None
    was_eligible = current.state == "eligible" or current.state == "suspended" or current.auto_closed

    def deny(reason, claim=claim):
        # Once a Printing has been eligible, losing eligibility is a suspension, never a quiet downgrade.
        state = "suspended" if was_eligible else "unsupported"
        return replace(current, state=state, reason=reason, basis=None if state == "unsupported" else current.basis,
                       identity=None, claim=claim, activation_id=None if state == "unsupported" else current.activation_id,
                       auto_closed=was_eligible)

    if isinstance(derived, Failure):
        if derived.reason == "conflicting_input" and not reviewed and contested():
            return deny("identity_review_pending", None)  # the pending review is the better explanation
        return deny(derived.reason, None)
    if collides(claim):
        return deny("conflicting_input")
    if not reviewed:
        if candidate_fp in rejections and current.state != "eligible":
            return replace(current, state="unsupported", reason="reviewed_unsupported", identity=None, claim=None)
        if contested():
            return deny("identity_review_pending")
        if current.state == "eligible" and candidate_fp != current.accepted_fingerprint and candidate_fp not in rejections \
                and (current.accepted_projection is None or current.accepted_projection != projection_fp):
            return deny("source_changed")  # a rule input moved; other export changes are accepted silently below
        if current.state == "eligible" and derived != current.identity:
            return deny("rule_uncovered")  # A different rule version must not change a public identity unreviewed.
    return PrintingState(state="eligible", reason=None, basis="maintainer" if maintainer else "rule",
                         inputs=current.inputs if maintainer else None, identity=derived, claim=claim,
                         decision_id=current.decision_id if maintainer else None, activation_id=active.activation_id,
                         accepted_fingerprint=candidate_fp, auto_closed=True, accepted_projection=projection_fp)


# ---------------------------------------------------------------- persistence


class LazySet:
    """A set loaded on first membership test, so unchanged paths issue no query."""

    def __init__(self, load):
        self.load, self.values = load, None

    def __contains__(self, value):
        if self.values is None:
            self.values = set(self.load())
        return value in self.values


class TargetContext:
    """Active rules and per-operation scratch shared by every refresh in one transaction."""

    def __init__(self, conn):
        self.conn = conn
        self.live = load_active(conn, LIVE)
        self.matching = load_active(conn, MATCHING)
        self.run_claims = Counter()
        self._waiting = None

    def source_claim(self, export, display=None):
        if self.live is None:
            return None
        derived = self.live.rule.derive_source(export, display)
        return claim_key(derived) if isinstance(derived, dict) else None

    def prime_claims(self, exports):
        """Count source-derived Live claims so same-operation collisions leave neither side eligible."""
        for export in exports:
            claim = self.source_claim(export)
            if claim:
                self.run_claims[claim] += 1

    def waiting(self, printing_id):
        """Printings parked as contested or colliding; they re-evaluate when their cause may have cleared."""
        if self._waiting is None:
            self._waiting = {row["printing_id"] for row in self.conn.execute("""SELECT printing_id FROM catalog_printing_metadata
              WHERE live_state='unsupported' AND NOT live_auto_closed
                AND live_reason IN ('identity_review_pending','conflicting_input')""")}
        return printing_id in self._waiting


def verified_elsewhere(conn, printing_id, edition_id):
    """Whether a (product, quote variant) pair is already held by another verified Edition.

    A product may be shared by sibling Editions, but never by another Printing. A quote variant
    names one price slot of the Printing's source card, so it belongs to a single verified
    Edition of that Printing whatever product the sibling holds: the published quote lookup
    carries the card and variant key, not the product.
    """
    def held(product_id, quote_variant=None):
        return conn.execute("""SELECT 1 FROM catalog_edition_metadata m JOIN catalog_edition e ON e.id=m.edition_id
          WHERE m.mapping_state='verified' AND m.edition_id<>%s
            AND ((m.product_id=%s AND e.printing_id<>%s)
              OR (e.printing_id=%s AND %s::text IS NOT NULL AND m.quote_variant=%s::text)) LIMIT 1""",
                            (edition_id, product_id, printing_id, printing_id, quote_variant, quote_variant)).fetchone() is not None
    return held


def tcgplayer_candidates(conn, set_id, collector_number):
    """TCGCSV products in the set's reviewed group on the card's number, for matching rule v4's promo path."""
    key = number_key(collector_number)
    if key is None:
        return []
    return [{"product_id": row["product_id"], "name": row["name"], "number": row["number"]} for row in conn.execute(
        "SELECT product_id,name,number FROM tcgplayer_product WHERE group_id=%s AND number_key=%s ORDER BY product_id",
        (MatchingRulesV4.TCGPLAYER_GROUPS[set_id], key))]


def refresh_editions(conn, context, edition_ids, complete=False):
    """Re-evaluate marketplace state for Editions whose candidate changed or whose rule changed.

    ``complete`` also gives an unchanged verified Edition the quote variant the active rule now names
    (``complete_quote_variant``).
    """
    if not edition_ids:
        return 0
    rows = conn.execute("""SELECT e.id,e.printing_id,e.descriptor,p.source,p.source_id,em.mapping_candidate,
      em.mapping_state,em.mapping_reason,em.product_id,em.quote_variant,em.mapping_basis,em.mapping_decision_id,
      em.matching_activation_id,em.accepted_fingerprint,em.accepted_projection,em.auto_closed,pm.source_record,
      d.set_id,d.collector_number,d.display_name
      FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
      JOIN catalog_edition_metadata em ON em.edition_id=e.id
      LEFT JOIN catalog_printing_metadata pm ON pm.printing_id=p.id
      LEFT JOIN catalog_printing_display d ON d.printing_id=p.id
      WHERE e.id=ANY(%s) ORDER BY e.id""", (list(edition_ids),)).fetchall()
    changed = 0
    for row in rows:
        candidate = row["mapping_candidate"]
        if not candidate:
            continue  # Never imported: nothing to evaluate.
        facts = {"fingerprint": fingerprint(candidate), "correspondence": candidate.get("correspondence"),
                 "lookup": candidate.get("candidate") or {}, "descriptor": row["descriptor"], "source": row["source"],
                 "source_id": row["source_id"], "source_record": row["source_record"] or {},
                 "display": {"set_id": row["set_id"], "collector_number": row["collector_number"],
                             "display_name": row["display_name"]} if row["set_id"] is not None else None}
        if row["set_id"] in MatchingRulesV4.TCGPLAYER_GROUPS:
            facts["tcgplayer_candidates"] = tcgplayer_candidates(conn, row["set_id"], row["collector_number"])
        rejections = LazySet(lambda edition_id=row["id"]: [r["source_fingerprint"] for r in conn.execute(
            "SELECT source_fingerprint FROM catalog_metadata_rejection WHERE edition_id=%s AND target='marketplace'",
            (edition_id,))])
        current = edition_state(row)
        elsewhere = verified_elsewhere(conn, row["printing_id"], row["id"])
        new = evaluate_edition(current, facts, rejections, context.matching, elsewhere)
        if complete and new == current:
            new = complete_quote_variant(current, facts, context.matching, elsewhere)
        if new == current:
            continue
        bump = 1 if (new.state == "verified") != (current.state == "verified") else 0
        conn.execute("""UPDATE catalog_edition_metadata SET mapping_state=%s,mapping_reason=%s,product_id=%s,quote_variant=%s,
          mapping_basis=%s,mapping_decision_id=%s,matching_activation_id=%s,accepted_fingerprint=%s,accepted_projection=%s,
          auto_closed=%s,mapping_revision=mapping_revision+%s,updated_at=now() WHERE edition_id=%s""",
                     (new.state, new.reason, new.product_id, new.quote_variant, new.basis, new.decision_id,
                      new.activation_id, new.accepted_fingerprint, new.accepted_projection, new.auto_closed, bump, row["id"]))
        changed += 1
    return changed


PRINTING_SELECT = """SELECT m.export_candidate,m.live_state,m.live_reason,m.live_basis,m.live_inputs,m.live_identity,m.live_claim,
  m.live_decision_id,m.live_activation_id,m.live_accepted_fingerprint,m.live_auto_closed,
  m.live_accepted_projection,d.set_id,d.collector_number,d.display_name
  FROM catalog_printing_metadata m LEFT JOIN catalog_printing_display d ON d.printing_id=m.printing_id
  WHERE m.printing_id=%s"""


def _write_printing(conn, printing_id, new):
    conn.execute("""UPDATE catalog_printing_metadata SET live_state=%s,live_reason=%s,live_basis=%s,live_inputs=%s::jsonb,
      live_identity=%s::jsonb,live_claim=%s,live_decision_id=%s,live_activation_id=%s,live_accepted_fingerprint=%s,
      live_accepted_projection=%s,live_auto_closed=%s,updated_at=now() WHERE printing_id=%s""",
                 (new.state, new.reason, new.basis, None if new.inputs is None else json.dumps(new.inputs),
                  None if new.identity is None else json.dumps(new.identity), new.claim, new.decision_id,
                  new.activation_id, new.accepted_fingerprint, new.accepted_projection, new.auto_closed, printing_id))


def refresh_printing(conn, context, printing_id, reviewed=False):
    """Re-evaluate Live state for one Printing and suspend any eligible Printing it collides with."""
    row = conn.execute(PRINTING_SELECT, (printing_id,)).fetchone()
    if row is None:
        return False
    current, export = printing_state(row), row["export_candidate"]
    display = ({"set_id": row["set_id"], "collector_number": row["collector_number"], "display_name": row["display_name"]}
               if row["set_id"] is not None else None)
    holders = {}

    def holders_of(claim):
        if claim not in holders:
            holders[claim] = conn.execute("""SELECT printing_id,live_state FROM catalog_printing_metadata
              WHERE live_claim=%s AND printing_id<>%s FOR UPDATE""", (claim, printing_id)).fetchall()
        return holders[claim]

    own = context.source_claim(export, display) if export else None

    def collides(claim):
        return bool(holders_of(claim)) or context.run_claims[claim] > (1 if own == claim else 0)

    rejections = LazySet(lambda: [r["source_fingerprint"] for r in conn.execute(
        "SELECT source_fingerprint FROM catalog_metadata_rejection WHERE printing_id=%s AND target='live'", (printing_id,))])

    def contested():
        return conn.execute("""SELECT 1 FROM catalog_review WHERE printing_id=%s AND status='pending' AND kind=ANY(%s) LIMIT 1""",
                            (printing_id, list(IDENTITY_REVIEW_KINDS))).fetchone() is not None

    new = evaluate_printing(current, export, contested, rejections, context.live, collides, reviewed, display)
    if new.reason == "conflicting_input" and new.claim:
        for other in holders_of(new.claim):
            if other["live_state"] == "eligible":
                peer = printing_state(conn.execute(PRINTING_SELECT, (other["printing_id"],)).fetchone())
                _write_printing(conn, other["printing_id"], replace(peer, state="suspended", reason="conflicting_input",
                                                                     identity=None, auto_closed=True))
    if new == current:
        return False
    _write_printing(conn, printing_id, new)
    return True


def activate_rule(conn, kind, version, reviewer_id, evidence_url, reason):
    """Record a maintainer's rule activation (version None deactivates) and re-evaluate affected targets.

    Re-evaluation covers unsupported and eligible Printings and unverified, not auto-closed
    Editions only: quarantined, suspended and previously verified targets are never re-qualified. A matching-rule
    Edition verified without a quote variant may gain the one the new rule names (``complete_quote_variant``).
    """
    if kind not in REGISTRIES or (version is not None and version not in REGISTRIES[kind]):
        raise ValueError("Unknown rule kind or version")
    revision = conn.execute("SELECT catalog_begin_correction() AS revision").fetchone()["revision"]
    activation = conn.execute("""INSERT INTO catalog_rule_activation(kind,version,code_digest,reviewer_id,evidence_url,reason,clock_revision)
      VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                              (kind, version, code_digest(kind, version) if version else None, reviewer_id,
                               evidence_url, reason, revision)).fetchone()["id"]
    conn.execute("UPDATE catalog_rule_state SET activation_id=%s WHERE kind=%s", (activation, kind))
    context = TargetContext(conn)
    if kind == LIVE:
        rows = conn.execute("""SELECT printing_id,export_candidate FROM catalog_printing_metadata
          WHERE live_state IN ('unsupported','eligible') AND NOT (live_state='unsupported'
            AND (live_auto_closed OR live_reason='reviewed_unsupported'))
            AND (export_candidate<>'{}'::jsonb OR live_inputs IS NOT NULL) ORDER BY printing_id""").fetchall()
        context.prime_claims(row["export_candidate"] for row in rows if row["export_candidate"])
        return {"printings": sum(refresh_printing(conn, context, row["printing_id"]) for row in rows), "editions": 0}
    ids = [row["edition_id"] for row in conn.execute("""SELECT edition_id FROM catalog_edition_metadata
      WHERE mapping_state='unverified' AND NOT auto_closed ORDER BY edition_id""")]
    changed = sum(refresh_editions(conn, context, ids[start:start + 500]) for start in range(0, len(ids), 500))
    ids = [row["edition_id"] for row in conn.execute("""SELECT edition_id FROM catalog_edition_metadata
      WHERE mapping_state='verified' AND quote_variant IS NULL AND mapping_basis='matching_rule' ORDER BY edition_id""")]
    changed += sum(refresh_editions(conn, context, ids[start:start + 500], complete=True) for start in range(0, len(ids), 500))
    return {"printings": 0, "editions": changed}


def rematch_promos(conn, batch=500):
    """Re-evaluate unverified ``rule_failed`` Editions of the reviewed promo sets under the active rule; returns the count changed.

    For promos TCGCSV lists after the rule was activated. Batches of ``batch`` Editions, each in its own transaction.
    Does nothing without an active matching rule, so an Edition is never relabelled ``no_matching_rule`` here.
    """
    if load_active(conn, MATCHING) is None:
        return 0
    ids = [row["edition_id"] for row in conn.execute("""SELECT m.edition_id FROM catalog_edition_metadata m
      JOIN catalog_edition e ON e.id=m.edition_id JOIN catalog_printing_display d ON d.printing_id=e.printing_id
      WHERE m.mapping_state='unverified' AND NOT m.auto_closed AND m.mapping_reason='rule_failed' AND d.set_id=ANY(%s)
      ORDER BY m.edition_id""", (list(MatchingRulesV4.TCGPLAYER_GROUPS),))]
    changed = 0
    for start in range(0, len(ids), batch):
        with conn.transaction():
            conn.execute("SELECT catalog_begin_correction()")
            changed += refresh_editions(conn, TargetContext(conn), ids[start:start + batch])
    return changed


AUTOMATIC_MATCHING_EVIDENCE = "https://github.com/ry-cen/tcg-tracker/blob/dev/api/app/catalog_targets.py"
AUTOMATIC_MATCHING_REASON = "Automatic: MARKETPLACE_MATCHING=automatic keeps the newest matching rule active"


def automatic_matching() -> bool:
    return os.environ.get("MARKETPLACE_MATCHING") == "automatic"


def ensure_matching_rule(conn):
    """With MARKETPLACE_MATCHING=automatic, keep the newest matching rule active without an owner approval.

    The activation is recorded for the bound owner like a manual one and re-evaluates the same Editions. It is a no-op
    when automatic matching is off, the newest version is already active with its current code, or no owner is bound.
    Runs in the caller's transaction; returns ``activate_rule``'s counts, or None when nothing changed.
    """
    if not automatic_matching():
        return None
    version = max(MATCHING_RULES)
    conn.execute("SELECT catalog_begin_correction()")
    conn.execute("SELECT 1 FROM catalog_rule_state WHERE kind=%s FOR UPDATE", (MATCHING,))
    active = load_active(conn, MATCHING)
    if active is not None and active.version == version:
        return None
    owner = conn.execute("SELECT user_id FROM owner_binding WHERE singleton").fetchone()
    if owner is None:
        return None
    return activate_rule(conn, MATCHING, version, owner["user_id"], AUTOMATIC_MATCHING_EVIDENCE, AUTOMATIC_MATCHING_REASON)


# ---------------------------------------------------------------- readers (PostgreSQL is authoritative)


@dataclass(frozen=True)
class EditionTargets:
    state: str
    reason: str | None
    mapping_revision: int
    product_id: int | None
    quote_lookup: dict | None


@dataclass(frozen=True)
class LiveTarget:
    state: str
    reason: str | None
    identity: dict | None
    rule_version: int | None


def edition_targets(conn, ids):
    """Marketplace eligibility per Edition. Product and price lookup exist only while verified."""
    result = {}
    for row in conn.execute("""SELECT m.edition_id,m.mapping_state,m.mapping_reason,m.mapping_revision,m.product_id,m.quote_variant,
      p.source,p.source_id FROM catalog_edition_metadata m JOIN catalog_edition e ON e.id=m.edition_id
      JOIN catalog_printing p ON p.id=e.printing_id WHERE m.edition_id=ANY(%s)""", (list(ids),)):
        verified = row["mapping_state"] == "verified"
        lookup = ({"source": "tcgdex", "card": row["source_id"], "variant": row["quote_variant"]}
                  if verified and row["quote_variant"] and row["source"] == "tcgdex" and row["source_id"] else None)
        result[row["edition_id"]] = EditionTargets(
            row["mapping_state"], None if verified else row["mapping_reason"], row["mapping_revision"],
            row["product_id"] if verified else None, lookup)
    return result


def printing_live(conn, ids):
    """Live eligibility per Printing, independent of any Edition's marketplace state."""
    result = {}
    for row in conn.execute("""SELECT m.printing_id,m.live_state,m.live_reason,m.live_identity,a.version
      FROM catalog_printing_metadata m LEFT JOIN catalog_rule_activation a ON a.id=m.live_activation_id
      WHERE m.printing_id=ANY(%s)""", (list(ids),)):
        eligible = row["live_state"] == "eligible"
        result[row["printing_id"]] = LiveTarget(row["live_state"], row["live_reason"], row["live_identity"] if eligible else None,
                                                row["version"])
    return result
