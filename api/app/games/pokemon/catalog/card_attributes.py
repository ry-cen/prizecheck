"""Card attributes of each Card Printing, derived from its catalog source record.

The attributes are the regulation mark, card kind, Basic Energy status, types, Rule Box, ACE SPEC, Radiant and
Prism Star status, Basic Pokémon status and Trainer Type. ``CardAttributeRules`` holds the derivation rules: fixing a misderived class of cards is a
commit here, and the next catalog import (or ``scripts/derive_card_attributes.py``) re-derives every Printing.

The effective attributes are the one source of card type (app redesign spec, "Card type: one source"): format checks
and Collection's category and type filters read them. Trainer Type is reviewed like the other attributes, but no
format rule reads it, so it is not a public format fact (``FORMAT_FACT_COLUMNS``). Evolves from, the name of the
Pokémon a Pokémon evolves from, is derived with the attributes but is not one of them: it is never reviewed or
corrected, and only groups Deck List lines (``derive_evolves_from``, migration 041).

``None`` means unknown. Missing, malformed or contradictory source data leaves an attribute unknown; it is never
guessed. Manually approved Printings have no source record, so every attribute is unknown until a reviewed
correction supplies it (``app.games.pokemon.catalog.attribute_corrections``).

Readers use the effective attributes in the ``catalog_card_attribute`` view (``read_card_attributes``), never the
derived table: a reviewed correction overrides each attribute it sets until it is removed, and re-derivation never
touches it. One revision counter, ``catalog_attribute_state.revision``, advances at most once per transaction that
changes any Printing's attributes (``advance_attribute_revision``).
"""
import hashlib
import inspect
import json
import re
import unicodedata
from dataclasses import astuple, dataclass, fields
from uuid import UUID


@dataclass(frozen=True)
class CardAttributes:
    regulation_mark: str | None = None   # one upper-case letter
    card_kind: str | None = None         # 'pokemon', 'trainer' or 'energy'
    basic_energy: bool | None = None
    types: tuple[str, ...] | None = None  # Pokémon types in source order; empty for Trainer and Energy cards
    rule_box: bool | None = None
    ace_spec: bool | None = None
    radiant: bool | None = None
    prism_star: bool | None = None
    basic_pokemon: bool | None = None    # migration 038 appends its column to the view
    trainer_type: str | None = None      # last: 'supporter', 'item', 'tool' or 'stadium'; Trainers only (migration 041)


UNKNOWN = CardAttributes()
ATTRIBUTE_COLUMNS = tuple(field.name for field in fields(CardAttributes))
# The attributes Published Deck format checks read from the shared records store (migrations 036 and 038). Trainer Type
# is left out: no format rule reads it, so a Trainer Type change neither re-stamps a Printing nor changes its record.
FORMAT_FACT_COLUMNS = tuple(column for column in ATTRIBUTE_COLUMNS if column != "trainer_type")


class CardAttributeRules:
    """Derivation rules, version ``VERSION``. Any edit to this class or its tables changes ``rules_digest()``:
    bump ``VERSION`` and re-pin the digest in ``api/tests/test_card_attributes.py``.

    - **Regulation mark**: ``regulationMark`` when it is a single letter, folded to upper case (TCGdex has one
      ``"j"``). Anything else, including the string ``"None"`` and an absent mark, is unknown.
    - **Card kind**: ``category`` Pokemon, Trainer or Energy. Every other attribute except the mark needs it.
    - **Basic Energy**: an Energy whose ``energyType`` is Normal (or Basic) *and* whose name is "{Type} Energy" or
      "Basic {Type} Energy". TCGdex labels 14 Special Energies Normal (for example Reversal Energy sv04-266); their
      names are not Basic Energy names, so they are not Basic Energy. A Special ``energyType`` is not Basic
      Energy; an Energy without ``energyType`` is unknown. Pokémon and Trainers are not Basic Energy.
    - **Types**: a Pokémon's ``types`` when every entry is a known type, otherwise unknown. Trainer and Energy
      cards have no types.
    - **Rule Box**: a Pokémon whose printed name carries a Rule Box mechanic (EX, GX, V, VMAX, VSTAR, V-UNION,
      BREAK, ex) and whose ``suffix``/``stage`` agree or are silent; a Radiant Pokémon; any Prism Star card.
      ``suffix``/``stage`` claiming a mechanic the name lacks (Raichu sv02-064 has ``suffix`` ex) is a
      contradiction, so unknown. A bare " V" without the source's V suffix (Unown V dp6-79) is unknown, as are
      pre-Black & White mechanics the rules don't cover (LEGEND, LV.X, Pokémon Star). ACE SPEC is its own
      attribute and does not make a card Rule Box.
    - **ACE SPEC**: a Trainer or Energy with ``rarity`` "ACE SPEC Rare", or whose exact name is in
      ``ACE_SPEC_NAMES``: ACE SPEC status follows the name across reprints, and Black & White printings carry no
      marker. ``ACE_SPEC_HOMONYMS`` are older, different cards that share an ACE SPEC name (Base Set Computer
      Search, pre-Black & White Master Ball). Otherwise a Trainer or Energy is not an ACE SPEC when its set is in
      ``ACE_SPEC_SETTLED_SETS`` (every English set released by 2026-10-10, checked by research) and unknown in any
      other set (for example me06). A Basic Energy is never an ACE SPEC. Pokémon are not ACE SPEC.
    - **Radiant**: a Pokémon named "Radiant ...". ``rarity`` "Radiant Rare" without that name is unknown.
    - **Prism Star**: a card whose name contains ◇ (U+25C7). The ☆ and ★ of Pokémon Star are not Prism Star.
    - **Basic Pokémon**: a Pokémon whose ``stage`` is in ``BASIC_STAGES`` (Basic, including Basic Pokémon V, ex, Mega
      Evolution ex such as Mega Kangaskhan ex me01-104, Radiant and Prism Star Pokémon; and the e-card era's Baby
      Pokémon, a kind of Basic Pokémon). Every other known stage is not Basic: Stage 1 and 2, the XY ``MEGA`` stage
      (Mega Evolution Pokémon-EX evolve from a Pokémon-EX), VMAX, VSTAR, BREAK, LEVEL-UP, V-UNION and RESTORED (the
      Pokémon TCG Rules, Twilight Masquerade edition: "Pokémon V-UNION are not Basic Pokémon!", p. 27, and
      "Restored Pokémon are not Basic Pokémon!", p. 39). A Rule Box stage whose mechanic the printed name lacks
      (Zacian swshp-SWSH135 with ``stage`` BREAK) is a contradiction, so unknown; so is a LEGEND, which the rules
      do not cover. A missing ``stage`` (716 Black & White to Sun & Moon EX, GX and TAG TEAM printings) or one these
      rules don't know is unknown. Trainer and Energy cards are not Basic Pokémon, including the 119 Energy cards
      TCGdex gives ``stage`` Basic and the Fossil Items that are "played as Basic Pokémon" (Unidentified Fossil,
      Antique Helix Fossil): such an Item is a Trainer in the hand and deck, so it never counts as a Basic Pokémon
      during setup (Pokémon Rulings Compendium, TPCi Rules Team 2018-02-08, ruling 1189), and the deck-building
      rule ("your deck must have at least one Basic Pokémon in it", p. 22) exists for setup.
    - **Trainer Type**: a Trainer's ``trainerType`` when it is one of ``TRAINER_TYPES`` (Supporter, Item, Tool,
      Stadium); any other value, such as "Technical Machine", and an absent one (220 printings before Black & White)
      are unknown. Pokémon and Energy cards have no Trainer Type.
    - **Evolves from** (``evolves_from``, not an attribute): a Pokémon's ``evolveFrom``, the name of the Pokémon it
      evolves from, with its whitespace collapsed, when it is a non-empty string of at most ``EVOLVES_FROM_MAX``
      characters. Anything else, and every Trainer and Energy card, has none.
    """
    VERSION = 3
    KINDS = {"Pokemon": "pokemon", "Trainer": "trainer", "Energy": "energy"}
    POKEMON_TYPES = ("Grass", "Fire", "Water", "Lightning", "Psychic", "Fighting", "Darkness", "Metal", "Fairy",
                     "Dragon", "Colorless")
    BASIC_ENERGY_TYPES = ("Normal", "Basic")
    BASIC_ENERGY_NAME = r"(?:Basic )?(?:Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal|Fairy) Energy"
    # Printed-name tokens, tested in order against the name without a trailing " δ" (Delta Species).
    NAME_MECHANICS = (("VMAX", r"[ -]VMAX"), ("VSTAR", r"[ -]VSTAR"), ("V-UNION", r"[ -]V-UNION"), ("V", r" V"),
                      ("GX", r"[ -]GX"), ("EX", r"[ -]EX"), ("ex", r" ex"), ("BREAK", r" BREAK"))
    RULE_BOX_SUFFIXES = ("EX", "GX", "TAG TEAM-GX", "V", "ex")
    PLAIN_SUFFIXES = ("Prime", "SP")
    UNCOVERED_SUFFIXES = ("Legend",)
    RULE_BOX_STAGES = ("VMAX", "VSTAR", "V-UNION", "MEGA", "BREAK")
    PLAIN_STAGES = ("Basic", "Stage1", "Stage2", "RESTORED", "Baby")
    UNCOVERED_STAGES = ("LEVEL-UP",)
    BASIC_STAGES = ("Basic", "Baby")
    NOT_BASIC_STAGES = ("Stage1", "Stage2", "RESTORED", "LEVEL-UP", "VMAX", "VSTAR", "V-UNION", "MEGA", "BREAK")
    STAR_GLYPHS = ("☆", "★")
    TRAINER_TYPES = {"Supporter": "supporter", "Item": "item", "Tool": "tool", "Stadium": "stadium"}
    EVOLVES_FROM_MAX = 120
    PRISM_STAR = "◇"
    RADIANT_PREFIX = "Radiant "
    RADIANT_RARITY = "Radiant Rare"
    ACE_SPEC_RARITY = "ACE SPEC Rare"
    # Every name printed as an ACE SPEC: the 33 TCGdex "ACE SPEC Rare" printings plus the 13 Black & White ACE SPECs
    # (Boundaries Crossed to Plasma Blast).
    ACE_SPEC_NAMES = ("Amulet of Hope", "Awakening Drum", "Brilliant Blender", "Computer Search", "Crystal Edge",
                      "Crystal Wall", "Dangerous Laser", "Deluxe Bomb", "Dowsing Machine", "Energy Search Pro",
                      "Enriching Energy", "G Booster", "G Scope", "Gold Potion", "Grand Tree", "Hero's Cape",
                      "Hyper Aroma", "Legacy Energy", "Life Dew", "Master Ball", "Max Rod", "Maximum Belt",
                      "Megaton Blower", "Miracle Headset", "Neo Upper Energy", "Neutralization Zone",
                      "Poké Vital A", "Precious Trolley", "Prime Catcher", "Reboot Pod", "Rock Guard",
                      "Scoop Up Cyclone", "Scramble Switch", "Secret Box", "Sparkling Crystal", "Survival Brace",
                      "Treasure Tracker", "Unfair Stamp", "Victory Piece")
    # Different, older cards that share an ACE SPEC name.
    ACE_SPEC_HOMONYMS = ("base1-71", "base4-101", "ecard1-143", "ex8-88", "ex11-99", "ex16-78", "gym2-116")
    # Sets whose ACE SPEC printings are all known: every English set in the 2026-10-10 TCGdex crawl except Pokémon
    # TCG Pocket (research: tcgdex-legality-data.md, mega-evolution-ace-spec.md). Add a set here once checked.
    ACE_SPEC_SETTLED_SETS = ("2011bw", "2012bw", "2014xy", "2015xy", "2016xy", "2017sm", "2018sm", "2019sm",
                             "2021swsh", "2022swsh", "2023sv", "2024sv", "30th", "30th-c", "base1", "base2",
                             "base3", "base4", "base5", "basep", "bog", "bw1", "bw10", "bw11", "bw2", "bw3", "bw4",
                             "bw5", "bw6", "bw7", "bw8", "bw9", "bwp", "cel25", "cel25cc", "col1", "dc1", "det1",
                             "dp1", "dp2", "dp3", "dp4", "dp5", "dp6", "dp7", "dpp", "dv1", "ecard1", "ecard2",
                             "ecard3", "ex1", "ex10", "ex11", "ex12", "ex13", "ex14", "ex15", "ex16", "ex2", "ex3",
                             "ex4", "ex5", "ex5.5", "ex6", "ex7", "ex8", "ex9", "exu", "fut2020", "g1", "gym1",
                             "gym2", "hgss1", "hgss2", "hgss3", "hgss4", "hgssp", "lc", "me01", "me02", "me02.5",
                             "me03", "me04", "me05", "mee", "mep", "mfb", "miscp", "neo1", "neo2", "neo3", "neo4",
                             "np", "pl1", "pl2", "pl3", "pl4", "pop1", "pop2", "pop3", "pop4", "pop5", "pop6",
                             "pop7", "pop8", "pop9", "ru1", "si1", "sm1", "sm10", "sm11", "sm115", "sm12", "sm2",
                             "sm3", "sm3.5", "sm4", "sm5", "sm6", "sm7", "sm7.5", "sm8", "sm9", "sma", "smp",
                             "sv01", "sv02", "sv03", "sv03.5", "sv04", "sv04.5", "sv05", "sv06", "sv06.5", "sv07",
                             "sv08", "sv08.5", "sv09", "sv10", "sv10.5b", "sv10.5w", "sve", "svp", "swsh1",
                             "swsh10", "swsh10.5", "swsh10tg", "swsh11", "swsh11tg", "swsh12", "swsh12.5",
                             "swsh12.5gg", "swsh12tg", "swsh2", "swsh3", "swsh3.5", "swsh4", "swsh4.5",
                             "swsh4.5sv", "swsh5", "swsh6", "swsh7", "swsh8", "swsh9", "swsh9tg", "swshp",
                             "tk-bw-e", "tk-bw-z", "tk-dp-l", "tk-dp-m", "tk-ex-latia", "tk-ex-latio", "tk-ex-m",
                             "tk-ex-p", "tk-hs-g", "tk-hs-r", "tk-sm-l", "tk-sm-r", "tk-xy-b", "tk-xy-latia",
                             "tk-xy-latio", "tk-xy-n", "tk-xy-p", "tk-xy-su", "tk-xy-sy", "tk-xy-w", "xy0", "xy1",
                             "xy10", "xy11", "xy12", "xy2", "xy3", "xy4", "xy5", "xy6", "xy7", "xy8", "xy9", "xya",
                             "xyp")

    @classmethod
    def table(cls):
        return {key: value for key, value in vars(cls).items() if key.isupper()}

    @classmethod
    def derive(cls, source_id, record) -> CardAttributes:
        if not isinstance(record, dict):
            return UNKNOWN
        mark = cls.regulation_mark(record.get("regulationMark"))
        kind = cls.KINDS.get(record.get("category"))
        name = record.get("name")
        if kind is None or not isinstance(name, str) or not name.strip():
            return CardAttributes(regulation_mark=mark)
        name = " ".join(unicodedata.normalize("NFC", name).split())
        prism_star = cls.PRISM_STAR in name
        if kind == "pokemon":
            radiant = cls.radiant(name, record.get("rarity"))
            return CardAttributes(mark, kind, False, cls.types(record.get("types")),
                                  cls.pokemon_rule_box(name, record.get("suffix"), record.get("stage"), radiant, prism_star),
                                  False, radiant, prism_star,
                                  cls.basic_pokemon(name, record.get("suffix"), record.get("stage")))
        set_data = record.get("set")
        set_id = set_data.get("id") if isinstance(set_data, dict) else None
        basic = cls.basic_energy(kind, name, record.get("energyType"))
        return CardAttributes(mark, kind, basic, (), prism_star,
                              cls.ace_spec(source_id, set_id, name, record.get("rarity"), basic), False, prism_star,
                              False, cls.trainer_type(kind, record.get("trainerType")))

    @classmethod
    def trainer_type(cls, kind, value):
        return cls.TRAINER_TYPES.get(value) if kind == "trainer" and isinstance(value, str) else None

    @classmethod
    def evolves_from(cls, record):
        if not isinstance(record, dict) or cls.KINDS.get(record.get("category")) != "pokemon":
            return None
        value = record.get("evolveFrom")
        if not isinstance(value, str):
            return None
        name = " ".join(unicodedata.normalize("NFC", value).split())
        return name if 0 < len(name) <= cls.EVOLVES_FROM_MAX else None

    @classmethod
    def regulation_mark(cls, value):
        if isinstance(value, str) and re.fullmatch(r"[A-Za-z]", value.strip()):
            return value.strip().upper()
        return None

    @classmethod
    def types(cls, value):
        if (isinstance(value, list) and value
                and all(isinstance(item, str) and item in cls.POKEMON_TYPES for item in value)):
            return tuple(dict.fromkeys(value))
        return None

    @classmethod
    def basic_energy(cls, kind, name, energy_type):
        if kind != "energy" or energy_type == "Special":
            return False
        if energy_type in cls.BASIC_ENERGY_TYPES:
            return re.fullmatch(cls.BASIC_ENERGY_NAME, name) is not None
        return None

    @classmethod
    def radiant(cls, name, rarity):
        if name.startswith(cls.RADIANT_PREFIX):
            return True
        return None if rarity == cls.RADIANT_RARITY else False

    @classmethod
    def name_mechanic(cls, name):
        bare = re.sub(r" δ$", "", name)
        for mechanic, pattern in cls.NAME_MECHANICS:
            if re.search(pattern + r"$", bare):
                return mechanic
        return None

    @classmethod
    def pokemon_rule_box(cls, name, suffix, stage, radiant, prism_star):
        if prism_star or radiant:
            return True
        if radiant is None:
            return None
        known_suffix = suffix is None or suffix in cls.RULE_BOX_SUFFIXES + cls.PLAIN_SUFFIXES + cls.UNCOVERED_SUFFIXES
        known_stage = stage is None or stage in cls.RULE_BOX_STAGES + cls.PLAIN_STAGES + cls.UNCOVERED_STAGES
        if not known_suffix or not known_stage:
            return None  # A mechanic these rules don't know.
        mechanic = cls.name_mechanic(name)
        claimed = suffix in cls.RULE_BOX_SUFFIXES or stage in cls.RULE_BOX_STAGES
        if mechanic and claimed:
            return True
        if mechanic == "V":
            return None  # "Unown V": only the source's V suffix tells a Pokémon V from a name ending in V.
        if mechanic:
            return True  # The printed name carries the mechanic; the source suffix/stage is missing.
        if claimed:
            return None  # The source claims a mechanic the printed name lacks.
        if suffix in cls.UNCOVERED_SUFFIXES or stage in cls.UNCOVERED_STAGES or any(glyph in name for glyph in cls.STAR_GLYPHS):
            return None
        return False

    @classmethod
    def basic_pokemon(cls, name, suffix, stage):
        """A Pokémon's Basic Pokémon status from its ``stage``."""
        if suffix in cls.UNCOVERED_SUFFIXES:
            return None  # LEGEND: a mechanic these rules don't cover.
        if stage in cls.BASIC_STAGES:
            return True
        if stage in cls.RULE_BOX_STAGES and cls.name_mechanic(name) is None:
            return None  # The source claims a Rule Box stage the printed name lacks.
        return False if stage in cls.NOT_BASIC_STAGES else None

    @classmethod
    def ace_spec(cls, source_id, set_id, name, rarity, basic_energy):
        if basic_energy:
            return False  # A Basic Energy is never an ACE SPEC.
        if rarity == cls.ACE_SPEC_RARITY or (name.replace("\u2019", "'") in cls.ACE_SPEC_NAMES
                                             and source_id not in cls.ACE_SPEC_HOMONYMS):
            return True
        return False if set_id in cls.ACE_SPEC_SETTLED_SETS else None


RULES = CardAttributeRules
# The source fields the rules read; ``set`` supplies the set ID.
SOURCE_FIELDS = ("category", "energyType", "evolveFrom", "name", "rarity", "regulationMark", "set", "stage", "suffix",
                 "trainerType", "types")


def rules_digest() -> str:
    """sha256 of the rules' tables and source, pinned in the tests so a rules edit must bump ``VERSION``."""
    parts = [json.dumps(RULES.table(), sort_keys=True, ensure_ascii=False), inspect.getsource(RULES)]
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


def derive(source_id, record) -> CardAttributes:
    return RULES.derive(source_id, record)


def derive_evolves_from(record) -> str | None:
    return RULES.evolves_from(record)


def _row(attributes: CardAttributes):
    values = astuple(attributes)
    types = ATTRIBUTE_COLUMNS.index("types")
    return values[:types] + (list(values[types]) if values[types] is not None else None,) + values[types + 1:]


def _attributes(row) -> CardAttributes:
    values = {column: row[column] for column in ATTRIBUTE_COLUMNS}
    if values["types"] is not None:
        values["types"] = tuple(values["types"])
    return CardAttributes(**values)


def advance_attribute_revision(conn) -> int:
    """Advance the one revision that covers card attributes and Reprint Groups, at most once per transaction.

    Every call in one transaction returns the revision the first call took (``catalog_advance_attribute_revision``,
    migration 033), so derivation, a reviewed correction and Reprint Group changes in one transaction advance it once.
    Call it in every transaction that changes any Printing's effective attributes or Reprint Group. The revision row
    stays locked until commit, so revisions are commit-ordered.
    """
    return conn.execute("SELECT catalog_advance_attribute_revision() AS revision").fetchone()["revision"]


def attribute_revision(conn) -> int:
    return conn.execute("SELECT revision FROM catalog_attribute_state WHERE singleton").fetchone()["revision"]


def refresh_card_attributes(conn) -> int:
    """Re-derive every TCGdex Printing's attributes from its stored source record, inside the caller's transaction.

    Only rows whose values, evolves-from or rules version differ are written, and the revision advances once when any
    Printing's attributes changed. Evolves from is not an attribute: a change to it alone is written but advances
    nothing, since no format check reads it. A Printing with a pending name or reference review keeps its current
    attributes: its source record may no longer describe the established Printing. Manual Printings have no source
    record and get nothing. Returns the number of Printings whose attributes changed.
    """
    sources = conn.execute("""SELECT p.id AS printing_id, p.source_id,
        (SELECT coalesce(jsonb_object_agg(f.key, f.value), '{}'::jsonb) FROM jsonb_each(m.source_record) f
         WHERE f.key = ANY(%s)) AS fields
      FROM catalog_printing_metadata m JOIN catalog_printing p ON p.id = m.printing_id
      WHERE p.source = 'tcgdex' AND jsonb_typeof(m.source_record) = 'object'
        AND NOT EXISTS (SELECT 1 FROM catalog_review r WHERE r.printing_id = p.id AND r.status = 'pending'
                        AND r.kind IN ('name_change', 'reference_change'))""", (list(SOURCE_FIELDS),)).fetchall()
    current = {row["printing_id"]: row for row in conn.execute(
        "SELECT * FROM catalog_derived_attribute WHERE printing_id = ANY(%s)",
        ([row["printing_id"] for row in sources],))}
    writes, changed = [], 0
    for source in sources:
        attributes = derive(source["source_id"], source["fields"])
        evolves_from = derive_evolves_from(source["fields"])
        existing = current.get(source["printing_id"])
        previous = _attributes(existing) if existing else UNKNOWN
        if (existing and previous == attributes and existing["evolves_from"] == evolves_from
                and existing["rules_version"] == RULES.VERSION):
            continue
        changed += previous != attributes
        writes.append((source["printing_id"], RULES.VERSION, *_row(attributes), evolves_from))
    if writes:
        columns = ", ".join((*ATTRIBUTE_COLUMNS, "evolves_from"))
        updates = ", ".join(f"{column} = EXCLUDED.{column}"
                            for column in ("rules_version", *ATTRIBUTE_COLUMNS, "evolves_from"))
        with conn.cursor() as cursor:
            cursor.executemany(f"""INSERT INTO catalog_derived_attribute (printing_id, rules_version, {columns})
              VALUES (%s, %s, {", ".join(["%s"] * (len(ATTRIBUTE_COLUMNS) + 1))})
              ON CONFLICT (printing_id) DO UPDATE SET {updates}, updated_at = now()""", writes)
    if changed:
        advance_attribute_revision(conn)
    return changed


def read_card_attributes(conn, printing_ids) -> dict:
    """Effective attributes by Printing ID; a Printing without attributes is ``UNKNOWN``."""
    ids = [UUID(str(value)) for value in printing_ids]
    found = {row["printing_id"]: _attributes(row) for row in conn.execute(
        f"SELECT printing_id, {', '.join(ATTRIBUTE_COLUMNS)} FROM catalog_card_attribute WHERE printing_id = ANY(%s)",
        (ids,))}
    return {printing_id: found.get(printing_id, UNKNOWN) for printing_id in ids}
