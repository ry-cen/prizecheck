"""Stored Format Standing (app redesign spec, "Stored Format Standing"; migration 042).

Each Card Printing's Format Standing in each Format (``legal``, ``not_legal`` or ``unknown``; CONTEXT.md) is stored in
``catalog_format_standing``, with the card-level issues behind it, so the Catalog browse route can filter by Format on
the server with stable pages. A Card Edition has its Card Printing's standing (``read_standings``).

A standing is the format evaluator's per-card judgement (``card_standing``): the card-level checks a Deck List line
holding the card gets, that is the line's standing (its set and regulation mark, bans and Reprint Group legality,
``format_evaluator.line_standing``) and the format's excluded attributes (Gym Leader Challenge's Rule Box and ACE SPEC).
It reads the same facts as a Deck's format check (``deck_format_checks``): the Printing's set and collector number in the
active catalog generation, its Card Identity, the printings of its Reprint Group that the active generation holds and
has not withdrawn, and the effective card attributes of all of them. Deck-level rules (deck size, copy limits, the
Basic Pokémon rule, a single type) are not part of a card's standing. Deck List format results are unchanged: they still
run the whole-deck check, and this module does not change the evaluator.

The key. ``catalog_format_standing_key`` holds one row per Format saying what its standings were computed from: the
same parts as a saved Deck result's key (``deck_format_checks.ResultKey``) without the Deck List revision, plus the
active catalog generation. They are the rules file's SHA-256, the code's SHA-256 (``CODE_SHA256``: the evaluator, the
attribute reader and this module), the attribute revision (card attributes and Reprint Groups), the catalog revision and
generation, and the next rule date after the day they were computed for. A Format is current when its stored key equals
the key computed now (``wanted_keys``), otherwise stale. Standings and their key are written in one transaction.

Rebuilds. A rebuild recomputes the stale Formats for the whole catalog in one pass and writes only the rows that changed.

- Eager, after each writer commits, best effort (``rebuild_stale_best_effort``): a catalog import
  (``catalog.execute_run``), an attribute decision (``attribute_corrections.decide``), a Reprint Group decision and a
  Card Identity merge (``reprint_group_reviews``), ``scripts/derive_card_attributes.py``, the API's startup (a deploy can
  change a rules file or this code) and the daily job ``scripts/format_standing_job.py`` (each rule date).
- Fallback: a reader calls ``ensure_current`` before it reads. A missing-card approval and a catalog review decision move
  the catalog revision and rely on it.

Locks. Each Format has a transaction-level advisory lock, ``(LOCK, its index in FORMATS)``. ``ensure_current`` checks the
keys without a lock; for the stale Formats it opens a READ COMMITTED transaction, takes their locks in ``FORMATS`` order
(so two rebuilds never deadlock), waiting at most ``LOCK_WAIT`` for each lock, and reads the keys again. A reader that waited while
another rebuilt finds its Format current and rebuilds nothing, then reads the new standings: READ COMMITTED lets the
read after the wait see the other rebuild's commit (REPEATABLE READ would read from a snapshot taken before the wait).
A rebuild reads the revisions before the facts they cover, so a commit landing between the two leaves standings keyed
older than their content: the next reader rebuilds again, and nobody reuses stale standings.

Reader contract (the Catalog browse route, #173)::

    state = format_standing.ensure_current()      # before the snapshot; StandingBusy -> 503 FORMAT_STANDING_BUSY
    with connect() as conn, conn.transaction():
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        keys = format_standing.current_keys(conn)  # None: a commit since made a Format stale; call ensure_current again
        token = format_standing.standing_token(keys)  # bind it into the cursor; a different token is 409
        ... JOIN catalog_format_standing fs ON fs.printing_id = e.printing_id AND fs.format = %s
            WHERE fs.standing <> 'not_legal'

While the keys are current every Card Printing has one row per Format.
"""
import hashlib
import json
import logging
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from threading import Thread
from uuid import UUID

import psycopg
from fastapi import APIRouter

from . import card_attributes
from . import format_evaluator as evaluator
from .card_attributes import attribute_revision, read_card_attributes

log = logging.getLogger(__name__)
router = APIRouter()

# The advisory lock of Format FORMATS[i] is (LOCK, i), the two-key form: no other lock in this codebase uses it.
LOCK = 914707
# How long a reader waits for another rebuild of the same Format before it gives up (StandingBusy).
LOCK_WAIT = "30s"
# Standings are reusable only while the code that produced them is unchanged: any edit to the evaluator, the attribute
# reader or this module makes every Format stale (one rebuild each).
CODE_SHA256 = hashlib.sha256(b"".join(Path(path).read_bytes()
                                      for path in (evaluator.__file__, card_attributes.__file__, __file__))).hexdigest()

# Every Card Printing with its Card Identity, Reprint Group, and set and collector number in the active catalog
# generation, as deck_format_checks.LINES reads a Deck List line's Printing. A Printing without a row there has no set.
FACTS = """SELECT p.id AS printing_id,ci.id AS identity_id,ci.display_name AS identity_name,gp.set_id,gp.collector_number,
    gp.tombstoned,g.group_id
  FROM catalog_printing p
  JOIN catalog_identity ci ON ci.id=p.identity_id
  LEFT JOIN catalog_state s ON s.singleton
  LEFT JOIN catalog_generation_printing gp ON gp.generation_id=s.active_generation AND gp.printing_id=p.id
  LEFT JOIN catalog_reprint_group_member g ON g.printing_id=p.id"""
KEYS = """SELECT format,rules_sha256,code_sha256,attribute_revision,catalog_revision,active_generation,next_rule_date
  FROM catalog_format_standing_key WHERE format=ANY(%s)"""
WRITE = """INSERT INTO catalog_format_standing AS s(printing_id,format,standing,findings)
  SELECT t.printing_id,%s,t.standing,t.findings::jsonb
  FROM unnest(%s::uuid[],%s::text[],%s::text[]) AS t(printing_id,standing,findings)
  ON CONFLICT (printing_id,format) DO UPDATE SET standing=EXCLUDED.standing,findings=EXCLUDED.findings
  WHERE (s.standing,s.findings) IS DISTINCT FROM (EXCLUDED.standing,EXCLUDED.findings)"""
WRITE_KEY = """INSERT INTO catalog_format_standing_key AS k(format,rules_sha256,code_sha256,attribute_revision,
    catalog_revision,active_generation,next_rule_date,built_on,built_at,printings,builds)
  VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,1)
  ON CONFLICT (format) DO UPDATE SET rules_sha256=EXCLUDED.rules_sha256,code_sha256=EXCLUDED.code_sha256,
    attribute_revision=EXCLUDED.attribute_revision,catalog_revision=EXCLUDED.catalog_revision,
    active_generation=EXCLUDED.active_generation,next_rule_date=EXCLUDED.next_rule_date,built_on=EXCLUDED.built_on,
    built_at=EXCLUDED.built_at,printings=EXCLUDED.printings,builds=k.builds+1"""
STANDINGS = """SELECT e.id AS edition_id,fs.format,fs.standing,fs.findings
  FROM catalog_edition e JOIN catalog_format_standing fs ON fs.printing_id=e.printing_id
  WHERE e.id=ANY(%s) AND fs.format=ANY(%s)"""


class StandingBusy(Exception):
    """A reader waited ``LOCK_WAIT`` for another rebuild of a stale Format and gave up; nothing was changed."""


@dataclass(frozen=True)
class StandingKey:
    """What one Format's standings were (or must be) computed from."""
    format: str
    rules_sha256: str
    code_sha256: str
    attribute_revision: int
    catalog_revision: int
    active_generation: UUID | None
    next_rule_date: date | None


@dataclass(frozen=True)
class StandingState:
    keys: Mapping[str, StandingKey]     # the stored key of each Format asked for
    rebuilt: tuple[str, ...]            # the Formats this call rebuilt, in FORMATS order


@dataclass(frozen=True)
class Standing:
    status: evaluator.Status
    findings: tuple[dict, ...]          # [{code, reason, effect}] in the evaluator's order


def today() -> date:
    """The day standings are computed for: today in UTC, like a Deck's format check."""
    return datetime.now(timezone.utc).date()


def _connect():
    from .main import connect  # Here, not at import: app.main includes this module's router while it loads.
    return connect()


def _names(names: Iterable[str]) -> tuple[str, ...]:
    wanted = set(names)
    if wanted - set(evaluator.FORMATS):
        raise ValueError(f"unknown format: {', '.join(sorted(wanted - set(evaluator.FORMATS)))}")
    return tuple(name for name in evaluator.FORMATS if name in wanted)


def card_standing(line: evaluator.ResolvedLine, rules: evaluator.FormatRules, on: date,
                  reprint_groups: Mapping[UUID, list[evaluator.PrintingFacts]]) -> Standing:
    """One card's standing on ``on``: the card-level part of ``evaluate_format`` for a line holding it, built from the
    evaluator's own pieces (``line_standing`` and the excluded-attribute check). Before ``rules.covers_from`` every card
    is unknown, with the evaluator's date issue."""
    if on < rules.covers_from:
        result = evaluator.evaluate_format((), rules, on)
    else:
        issues = evaluator._Issues()
        for finding in evaluator.line_standing(line, rules, on, reprint_groups).findings:
            issues.add(finding.code, finding.reason, "card", finding.violation, (line,))
        evaluator._exclusions(issues, line, rules)
        result = issues.result(rules, on)
    return Standing(result.status, tuple({"code": issue.code, "reason": issue.reason, "effect": issue.effect}
                                         for issue in result.issues))


def wanted_keys(conn, names: Iterable[str] = evaluator.FORMATS, on: date | None = None) -> dict[str, StandingKey]:
    """The key each named Format's standings must have to be current on ``on`` (default today). It reads the revisions;
    read them before the facts they cover."""
    on = on or today()
    state = conn.execute("SELECT revision,active_generation FROM catalog_state WHERE singleton").fetchone()
    attributes = attribute_revision(conn)
    keys = {}
    for name in _names(names):
        rules = evaluator.format_rules(name)
        keys[name] = StandingKey(name, rules.sha256, CODE_SHA256, attributes, state["revision"],
                                 state["active_generation"], evaluator.next_rule_date(rules, on))
    return keys


def stored_keys(conn, names: Iterable[str] = evaluator.FORMATS) -> dict[str, StandingKey]:
    """The stored key of each named Format that has one."""
    return {row["format"]: StandingKey(**row) for row in conn.execute(KEYS, (list(_names(names)),)).fetchall()}


def current_keys(conn, names: Iterable[str] = evaluator.FORMATS, on: date | None = None) -> dict[str, StandingKey] | None:
    """In the caller's snapshot: the stored keys when every named Format is current there, otherwise None."""
    wanted = wanted_keys(conn, names, on)
    stored = stored_keys(conn, names)
    return stored if stored == wanted else None


def standing_token(keys: Mapping[str, StandingKey]) -> str:
    """A digest of the keys for a browse cursor. It changes whenever any of these Formats' standings may change, and
    never with the time of a rebuild alone."""
    parts = [[key.format, key.rules_sha256, key.code_sha256, key.attribute_revision, key.catalog_revision,
              str(key.active_generation) if key.active_generation else None,
              key.next_rule_date.isoformat() if key.next_rule_date else None]
             for key in sorted(keys.values(), key=lambda key: evaluator.FORMATS.index(key.format))]
    return hashlib.sha256(json.dumps(parts, separators=(",", ":")).encode()).hexdigest()[:32]


def read_standings(conn, edition_ids: Iterable, names: Iterable[str] = evaluator.FORMATS) -> dict[UUID, dict[str, Standing]]:
    """Each Card Edition's stored standing in each named Format: its Card Printing's. An Edition or Format without a row
    is left out; call ``ensure_current`` first."""
    found = {}
    for row in conn.execute(STANDINGS, ([UUID(str(value)) for value in edition_ids], list(_names(names)))).fetchall():
        found.setdefault(row["edition_id"], {})[row["format"]] = Standing(row["standing"], tuple(row["findings"]))
    return found


def _stale(wanted: Mapping[str, StandingKey], stored: Mapping[str, StandingKey]) -> tuple[str, ...]:
    return tuple(name for name in wanted if stored.get(name) != wanted[name])


def _evaluate(conn, wanted: Mapping[str, StandingKey], on: date) -> dict[str, tuple[list, list, list]]:
    """Every Card Printing's standing in each Format of ``wanted``, as the arrays ``WRITE`` takes, in one pass."""
    rows = conn.execute(FACTS).fetchall()
    attributes = read_card_attributes(conn, [row["printing_id"] for row in rows])
    facts = {row["printing_id"]: evaluator.PrintingFacts(row["printing_id"], row["set_id"],
                                                         attributes[row["printing_id"]], row["collector_number"])
             for row in rows}
    # A group's printings that the active generation holds and has not withdrawn (deck_format_checks.MEMBERS).
    groups = {}
    for row in rows:
        if row["group_id"] is not None and row["set_id"] is not None and not row["tombstoned"]:
            groups.setdefault(row["group_id"], []).append(facts[row["printing_id"]])
    lines = [evaluator.ResolvedLine(edition_id=row["printing_id"], quantity=1, identity_id=row["identity_id"],
                                    identity_name=row["identity_name"], printing=facts[row["printing_id"]],
                                    reprint_group_id=row["group_id"]) for row in rows]
    ids = [line.printing.printing_id for line in lines]
    computed = {}
    for name in wanted:
        rules = evaluator.format_rules(name)
        standings = [card_standing(line, rules, on, groups) for line in lines]
        computed[name] = (ids, [standing.status for standing in standings],
                          [json.dumps(standing.findings, ensure_ascii=False, separators=(",", ":"))
                           for standing in standings])
    return computed


def _rebuild(conn, names: tuple[str, ...], on: date) -> tuple[str, ...]:
    """Rebuild whichever of ``names`` are still stale once their locks are held, in one transaction."""
    try:
        with conn.transaction():
            conn.execute("SELECT set_config('lock_timeout',%s,true)", (LOCK_WAIT,))
            for name in names:
                conn.execute("SELECT pg_advisory_xact_lock(%s::int,%s::int)", (LOCK, evaluator.FORMATS.index(name)))
            conn.execute("SELECT set_config('lock_timeout','0',true)")
            wanted = wanted_keys(conn, names, on)      # the revisions first, then the facts they cover
            stale = _stale(wanted, stored_keys(conn, names))
            if not stale:
                return ()
            computed = _evaluate(conn, {name: wanted[name] for name in stale}, on)
            built_at = datetime.now(timezone.utc)
            for name in stale:
                ids, statuses, findings = computed[name]
                written = conn.execute(WRITE, (name, ids, statuses, findings)).rowcount
                key = wanted[name]
                conn.execute(WRITE_KEY, (name, key.rules_sha256, key.code_sha256, key.attribute_revision,
                                         key.catalog_revision, key.active_generation, key.next_rule_date, on, built_at,
                                         len(ids)))
                log.info("Format Standing rebuilt: %s, %d Printings, %d changed", name, len(ids), written)
            return stale
    except psycopg.errors.LockNotAvailable:
        raise StandingBusy("another rebuild held a Format's lock longer than the wait") from None


def ensure_current(names: Iterable[str] = evaluator.FORMATS, on: date | None = None) -> StandingState:
    """Make the named Formats current on ``on`` (default today) and return their stored keys.

    A current Format costs one read. A stale one is rebuilt under its advisory lock; when another caller is already
    rebuilding it, this one waits (at most ``LOCK_WAIT`` per lock, then ``StandingBusy``) and then reads the new standings. Opens
    its own connection: call it before, never inside, a read snapshot."""
    names = _names(names)
    on = on or today()
    with _connect() as conn:
        # The re-check after the lock wait must see the other rebuild's commit, whatever the server's default.
        conn.isolation_level = psycopg.IsolationLevel.READ_COMMITTED
        stale = _stale(wanted_keys(conn, names, on), stored_keys(conn, names))
        conn.commit()
        rebuilt = _rebuild(conn, stale, on) if stale else ()
        keys = stored_keys(conn, names)
        conn.commit()
    return StandingState(keys, rebuilt)


def rebuild_stale_best_effort(names: Iterable[str] = evaluator.FORMATS, on: date | None = None) -> StandingState | None:
    """Post-commit hook: rebuild every stale named Format now. Never raises and never affects the committed work; on
    failure it logs the error class and returns None, and the next reader rebuilds."""
    try:
        return ensure_current(names, on)
    except Exception as exc:
        log.warning("Format Standing not rebuilt (%s); the next reader rebuilds it", type(exc).__name__)
        return None


@router.on_event("startup")
def rebuild_on_startup():
    # A deploy can change a rules file or the evaluator. A rebuild takes seconds, so it never holds up startup or health
    # checks; readers that arrive first wait on its lock.
    Thread(target=rebuild_stale_best_effort, daemon=True, name="format-standing").start()
