"""Reprint Groups: the Card Printings within one Card Identity whose rules text is exactly equal (CONTEXT.md).

Format legality and bans apply to a whole group (``app.format_evaluator``); copy limits still count by Card Identity.
``ReprintTextRules`` reduces a Printing's TCGdex source record to its rules text. Printings with the same Card Identity
and the same rules text share a group. A group's ID is a pure function of the two (``group_id``), so it is stable
across re-imports, and a new reprint joins its existing group. Missing or malformed text puts a Printing in no group:
absent text is never "equal".

Only ``refresh_reprint_groups`` writes derived groups. Every catalog import runs it, and so does
``scripts/derive_card_attributes.py``. It groups the TCGdex Printings of one catalog generation that are not
tombstoned, so withdrawn and digital-only Printings are in no group. Manually approved Printings have no source text;
they join a group only through maintainer review (``app.reprint_group_reviews``).

Reviewed records override derivation (migration 033): a link puts a Printing's derived group into a reviewed group, and
an assignment puts one Printing into a group. Both name Printings, so they survive re-imports, re-derivation and
renamed derived groups. Database triggers keep the effective membership current after every write to the derived or
reviewed tables. Readers use the ``catalog_reprint_group_member`` view of it, never the derived table. A change to any
Printing's group advances the shared attribute revision (``advance_attribute_revision``), at most once per transaction.
"""
import hashlib
import inspect
import json
import unicodedata
from uuid import UUID, uuid5

from .card_attributes import advance_attribute_revision

# Derived group IDs are uuid5(GROUP_NAMESPACE, "<identity_id>:<text_key>"). Changing this renames every group.
GROUP_NAMESPACE = UUID("6f1d2c9e-4b8a-5d3f-9a71-2c0e8b4d7a15")


class ReprintTextRules:
    """Rules text, version ``VERSION``. Any edit to this class changes ``rules_digest()``: bump ``VERSION`` and re-pin
    the digest in ``api/tests/test_reprint_groups.py``.

    - **Trainer and Energy**: the category and the effect text. A card without effect text (every Basic Energy) is in
      no group.
    - **Pokémon**: HP, types, attacks (name, Energy cost, damage, effect) and abilities (type, name, effect), in source
      order. It needs HP, at least one type, and at least one attack or ability, and every attack a name and every
      ability a type, name and effect. Otherwise it is in no group.
    - **Text** is compared after NFC, with every whitespace run (line breaks included) collapsed to one space, and
      with the typographic characters TCGdex spells both ways folded: ‘ ’ ʼ to ', “ ” to ", − to - and × to x. For
      example Rare Candy bw10-105 says "can’t" where xy5-135 says "can't", and Ultra Ball sv01-196 breaks a line
      that swsh9-186 does not.
    - **Kept as printed**: letter case ("Basic" and "basic" are different text; capitalized words are game terms) and
      parenthetical reminder text (TCGdex does not tell reminder text from rules text). Reworded printings are merged
      by maintainer review, never here: Rare Candy sm1-129 ("to evolve it.") is not grouped with me01-125 ("to evolve
      it, skipping the Stage 1.").
    - **Order-free**: an attack's Energy cost compares as a sorted list and a Pokémon's types as a sorted set. Damage
      compares as text, since TCGdex gives both 30 and "30".
    - **Not compared**: trainer and Energy type (pre-Black & White Trainers have no ``trainerType``; 14 Special
      Energies are labelled Normal; no group in the 2026-10-10 crawl has two different known values), stage, weakness,
      resistance and retreat (TCGdex leaves them out on some promos and reprints: comparing them split 219 Pokémon
      groups in the crawl, nearly all on missing data), the name (the Card Identity covers it), set, rarity and
      flavour text.
    """
    VERSION = 1
    FOLD = {"\u2018": "'", "\u2019": "'", "\u02bc": "'", "\u201c": '"', "\u201d": '"', "\u2212": "-", "\u00d7": "x"}
    TEXT_CATEGORIES = ("Trainer", "Energy")

    @classmethod
    def table(cls):
        return {key: value for key, value in vars(cls).items() if key.isupper()}

    @classmethod
    def text(cls, value):
        """The normalized text, or None when ``value`` is not a string or is blank."""
        if not isinstance(value, str):
            return None
        folded = unicodedata.normalize("NFC", value).translate(str.maketrans(cls.FOLD))
        return " ".join(folded.split()) or None

    @classmethod
    def rules_text(cls, record):
        """The Printing's rules text as a JSON-ready dict, or None when it is in no group."""
        if not isinstance(record, dict):
            return None
        category = record.get("category")
        if category in cls.TEXT_CATEGORIES:
            effect = cls.text(record.get("effect"))
            return None if effect is None else {"category": category, "effect": effect}
        if category != "Pokemon":
            return None
        hp, types = record.get("hp"), record.get("types")
        if type(hp) is not int or hp <= 0:
            return None
        if not isinstance(types, list) or not types or not all(isinstance(item, str) and item for item in types):
            return None
        attacks, abilities = record.get("attacks") or [], record.get("abilities") or []
        if not isinstance(attacks, list) or not isinstance(abilities, list) or not (attacks or abilities):
            return None
        texts = {"category": "Pokemon", "hp": hp, "types": sorted(set(types)), "attacks": [], "abilities": []}
        for attack in attacks:
            if not isinstance(attack, dict):
                return None
            name, cost = cls.text(attack.get("name")), attack.get("cost") or []
            if name is None or not isinstance(cost, list) or not all(isinstance(item, str) and item for item in cost):
                return None
            damage, effect = attack.get("damage"), attack.get("effect")
            if type(damage) is int:
                damage = str(damage)
            if damage is not None and not isinstance(damage, str) or effect is not None and not isinstance(effect, str):
                return None
            texts["attacks"].append({"name": name, "cost": sorted(cost), "damage": cls.text(damage) or "",
                                     "effect": cls.text(effect) or ""})
        for ability in abilities:
            if not isinstance(ability, dict):
                return None
            kind, name, effect = (cls.text(ability.get(key)) for key in ("type", "name", "effect"))
            if kind is None or name is None or effect is None:
                return None
            texts["abilities"].append({"type": kind, "name": name, "effect": effect})
        return texts


RULES = ReprintTextRules
# The source fields the rules read.
SOURCE_FIELDS = ("abilities", "attacks", "category", "effect", "hp", "types")


def rules_digest() -> str:
    """sha256 of the rules' tables and source, pinned in the tests so a rules edit must bump ``VERSION``."""
    parts = [json.dumps(RULES.table(), sort_keys=True, ensure_ascii=False), inspect.getsource(RULES)]
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


def text_key(rules_text: dict) -> str:
    return hashlib.sha256(json.dumps(rules_text, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
                          .encode()).hexdigest()


def group_id(identity_id, key: str) -> UUID:
    return uuid5(GROUP_NAMESPACE, f"{identity_id}:{key}")


def refresh_reprint_groups(conn, generation_id=None, printing_ids=None) -> int:
    """Re-derive the Reprint Group of every TCGdex Printing in a catalog generation (default: the active one) from its
    stored source record, inside the caller's transaction. ``printing_ids`` limits it to those Printings (a Card
    Identity merge re-derives only the Printings it moved).

    A Printing that is tombstoned, absent from the generation, manually approved or without rules text leaves its
    derived group. A Printing with a pending name or reference review keeps its current group: its source record may
    no longer describe the established Printing. Only changed rows are written, and the attribute revision advances
    when any Printing's derived group changed. Returns the number of Printings whose derived group changed.
    """
    if generation_id is None:
        generation_id = conn.execute("SELECT active_generation FROM catalog_state WHERE singleton"
                                     ).fetchone()["active_generation"]
        if generation_id is None:
            return 0
    scope = None if printing_ids is None else [UUID(str(value)) for value in printing_ids]
    sources = conn.execute("""SELECT p.id AS printing_id, p.identity_id,
        EXISTS (SELECT 1 FROM catalog_review r WHERE r.printing_id = p.id AND r.status = 'pending'
                AND r.kind IN ('name_change', 'reference_change')) AS pending,
        (SELECT coalesce(jsonb_object_agg(f.key, f.value), '{}'::jsonb) FROM jsonb_each(m.source_record) f
         WHERE f.key = ANY(%s)) AS fields
      FROM catalog_generation_printing gp
      JOIN catalog_printing p ON p.id = gp.printing_id
      JOIN catalog_printing_metadata m ON m.printing_id = p.id
      WHERE gp.generation_id = %s AND NOT gp.tombstoned AND p.source = 'tcgdex'
        AND jsonb_typeof(m.source_record) = 'object' AND (%s::uuid[] IS NULL OR p.id = ANY(%s::uuid[]))""",
                           (list(SOURCE_FIELDS), generation_id, scope, scope)).fetchall()
    current = {row["printing_id"]: row for row in conn.execute(
        """SELECT printing_id, group_id, text_key, rules_version FROM catalog_derived_reprint_group
          WHERE %s::uuid[] IS NULL OR printing_id = ANY(%s::uuid[])""", (scope, scope))}
    kept, wanted = set(), {}
    for source in sources:
        if source["pending"]:
            kept.add(source["printing_id"])
            continue
        texts = RULES.rules_text(source["fields"])
        if texts is not None:
            key = text_key(texts)
            wanted[source["printing_id"]] = (group_id(source["identity_id"], key), key)
    writes, changed = [], 0
    for printing_id, (group, key) in wanted.items():
        existing = current.get(printing_id)
        if (existing and (existing["group_id"], existing["text_key"], existing["rules_version"])
                == (group, key, RULES.VERSION)):
            continue
        changed += existing is None or existing["group_id"] != group
        writes.append((printing_id, group, key))
    removed = sorted(current.keys() - wanted.keys() - kept)
    changed += len(removed)
    if writes:
        printing_ids, group_ids, keys = (list(column) for column in zip(*writes))
        conn.execute("""INSERT INTO catalog_derived_reprint_group (printing_id, group_id, text_key, rules_version)
          SELECT printing_id, group_id, text_key, %s FROM unnest(%s::uuid[], %s::uuid[], %s::text[])
            AS w(printing_id, group_id, text_key)
          ON CONFLICT (printing_id) DO UPDATE SET group_id = EXCLUDED.group_id, text_key = EXCLUDED.text_key,
            rules_version = EXCLUDED.rules_version, updated_at = now()""",
                     (RULES.VERSION, printing_ids, group_ids, keys))
    if removed:
        conn.execute("DELETE FROM catalog_derived_reprint_group WHERE printing_id = ANY(%s)", (removed,))
    if changed:
        advance_attribute_revision(conn)
    return changed


def read_reprint_groups(conn, printing_ids) -> dict:
    """Effective Reprint Group ID by Printing ID; None for a Printing in no group."""
    ids = [UUID(str(value)) for value in printing_ids]
    found = {row["printing_id"]: row["group_id"] for row in conn.execute(
        "SELECT printing_id, group_id FROM catalog_reprint_group_member WHERE printing_id = ANY(%s)", (ids,))}
    return {printing_id: found.get(printing_id) for printing_id in ids}
