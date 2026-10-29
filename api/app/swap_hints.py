"""The Want List's Swap hint (decklist import #211; spec "The Want List": Swap hint).

A line that still needs copies carries a hint when another Edition in its effective Reprint Group
(``catalog_reprint_group_member``, ``app.reprint_groups``) has copies the counting setting makes available to the line's
Deck. **Swap** then sends one existing Deck List changes batch (``POST /api/decks/{id}/deck-list/changes``) that lowers
the line by the hint's ``count`` and raises or adds the other Edition's line by as many; its Undo is the inverse batch.
Nothing here writes.

**Available copies** come from the one shared allocation (``copy_allocation.allocate``), never a second rule. For a
Deck D and an Edition E of the line's group:

- **Every Deck built at once:** the Spare Copies of E (every copy no Deck's own line holds, Surplus included) less those
  that D and the Decks older than D count for their own lines of E (``LineCount.spare``). That is exactly what a line of
  E in D would count, since Spare Copies go oldest Deck first; Decks newer than D come after it.
- **One Deck at a time:** every copy of E less the copies D's own line of E already counts and less the copies promised
  to open Loans (``EditionCopies.reserved``) that D doesn't hold for its own line. That is every unpromised copy outside
  D, plus D's own copies beyond its line.

So sending a hint's batch lowers D's need by exactly ``count`` and leaves every older Deck's need as it was.

**Never offered twice.** Hints are handed out in one pass over every Deck oldest first, and within a Deck over its lines
in the order the page reads them; each hint holds its copies back from the hints after it. Under Every Deck built at
once the copies held back are shared by every Deck, so one spare copy is offered to one line on the whole page. Under
One Deck at a time each Deck starts again, because that setting counts every copy for every Deck, but within one Deck a
copy is still offered to one line. The pass covers every Deck that lists an Edition of the groups involved, so a scoped
read offers exactly what the All Decks read offers that Deck.

**One Edition per hint:** the one with the most copies available, then the card order the page reads in. Only an
Edition that may start a new Deck List line is offered (active in the active catalog generation, of a Printing that
isn't withdrawn, as the batch route checks), unless D already lists it.

**No group, no hint.** A Printing in no Reprint Group (every Basic Energy among them) gets no hint, not even for its own
other Editions. The import's Basic Energy grouping (spec "Allocation and Edition choice") does not apply here.

**Will accept (Trading #275).** A line whose Card Edition has a widened Will accept choice (a ``trade_accept`` row:
any finish, or any card with the same name, ``card_accepts.accepts``) is also offered the Editions that choice accepts,
with the same availability, the same one-pass, never-offered-twice rules and one Edition per hint, even when its
Printing is in no Reprint Group: "no group, no hint" is relaxed only for the Editions the rule accepts. Taking such a
hint is the same Deck List changes batch, and it is how a spare copy of an accepted card comes to count for the Deck.
With no row (this exact card) nothing is read beyond the empty rule read, and every hint is what it was before. The
choice changes no count: the Editions it brings in only add lines to this capture's own allocation, which is per
Edition, so no figure of another Edition moves, and only lines that need copies are ever hinted.

The capture (``capture_swaps``) runs inside the Want List's capture, under the owner row lock, so the hints belong to
the same committed state as the counts. Its reads are bounded by the Reprint Groups of the lines that need copies: the
groups, their Editions (catalog reads keyed by group), and ``allocate``'s range reads of the owner's Holdings and Deck
List lines of those Editions; plus the owner's Will accept rows for those lines and the Editions they accept. Will
accept is not closed under Reprint Groups, so a scoped read whose owner has any Will accept row hands hints out over
every Deck's needed lines (``want_list.capture_want_list``), and still offers exactly what the All Decks read offers
that Deck.
"""
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from uuid import UUID

from pydantic import BaseModel

from .card_accepts import accepts
from .copy_allocation import Allocation, LineCount, allocate
from .settings import WantListCounting

# The effective groups of the given Editions' Printings.
GROUPS = """SELECT DISTINCT g.group_id FROM catalog_edition e
  JOIN catalog_reprint_group_member g ON g.printing_id=e.printing_id
  WHERE e.id=ANY(%s)"""

# Every Edition of the given groups, with what the hint shows and the page's card order needs, and whether it may start
# a new Deck List line (deck_list_printing.AVAILABLE_EDITIONS's rule).
MEMBERS = """SELECT e.id AS edition_id,g.group_id,coalesce(pd.display_name,ci.display_name) AS name,
  coalesce(pd.set_id,'') AS set_id,psc.set_code AS set_code,coalesce(pd.set_name,'') AS set_name,
  coalesce(pd.collector_number,'') AS collector_number,e.descriptor,
  EXISTS (SELECT 1 FROM catalog_state s
    JOIN catalog_generation_edition ge ON ge.generation_id=s.active_generation AND ge.edition_id=e.id AND ge.active
    JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
    WHERE s.singleton AND NOT gp.tombstoned) AS available
  FROM catalog_reprint_group_member g
  JOIN catalog_printing p ON p.id=g.printing_id
  JOIN catalog_identity ci ON ci.id=p.identity_id
  JOIN catalog_printing_set_code psc ON psc.printing_id=p.id
  JOIN catalog_edition e ON e.printing_id=p.id
  LEFT JOIN catalog_printing_display pd ON pd.printing_id=p.id
  WHERE g.group_id=ANY(%s)"""

# The owner's Will accept choices for the given Editions (trading #275): an own read, outside the social area.
RULES = 'SELECT edition_id,rule FROM trade_accept WHERE owner_id=%s AND edition_id=ANY(%s)'

# Whether the owner has any Will accept choice at all.
ANY_RULE = 'SELECT EXISTS (SELECT 1 FROM trade_accept WHERE owner_id=%s) AS found'

# MEMBERS' facts for Editions read by id, for a line's Edition or an accepted Edition outside the groups read.
FACTS = """SELECT e.id AS edition_id,NULL::uuid AS group_id,coalesce(pd.display_name,ci.display_name) AS name,
  coalesce(pd.set_id,'') AS set_id,psc.set_code AS set_code,coalesce(pd.set_name,'') AS set_name,
  coalesce(pd.collector_number,'') AS collector_number,e.descriptor,
  EXISTS (SELECT 1 FROM catalog_state s
    JOIN catalog_generation_edition ge ON ge.generation_id=s.active_generation AND ge.edition_id=e.id AND ge.active
    JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
    WHERE s.singleton AND NOT gp.tombstoned) AS available
  FROM catalog_edition e
  JOIN catalog_printing p ON p.id=e.printing_id
  JOIN catalog_identity ci ON ci.id=p.identity_id
  JOIN catalog_printing_set_code psc ON psc.printing_id=p.id
  LEFT JOIN catalog_printing_display pd ON pd.printing_id=p.id
  WHERE e.id=ANY(%s)"""


class SwapHint(BaseModel):
    """A Want List line's Swap hint: "↻ You own a playable version (PAL 254) × 1"."""
    edition_id: UUID        # The owned Edition, in the line's Reprint Group.
    set_code: str           # Its printed set code ("PAL"), or its TCGdex set ID when the set has none (catalog_printing_set_code).
    collector_number: str
    descriptor: dict        # Its Variant Descriptor.
    count: str              # The copies Swap moves (× N): the lesser of the line's need and the copies available.
    listed: str             # That Edition's quantity on this Deck's list now; "0" means Swap adds the line.


@dataclass(frozen=True)
class GroupEdition:
    edition_id: UUID
    group_id: UUID | None   # None: read by id (FACTS), outside every group this capture read.
    name: str
    set_id: str
    set_code: str
    set_name: str
    collector_number: str
    descriptor: dict
    available: bool   # May start a new Deck List line.


@dataclass(frozen=True)
class SwapCapture:
    # Every Edition of the Reprint Groups the lines that need copies belong to.
    editions: dict[UUID, GroupEdition] = field(default_factory=dict)
    # ``allocate`` over those Editions: every Deck's line naming one of them, and every copy of each.
    allocation: Allocation | None = None
    # A needed line's Edition -> the other Editions its Will accept choice accepts (trading #275); absent for this
    # exact card. Every Edition named here is in ``editions``.
    accepted: dict[UUID, frozenset[UUID]] = field(default_factory=dict)


@dataclass(frozen=True)
class Hint:
    edition_id: UUID   # The owned Edition Swap moves copies onto.
    count: int         # The copies Swap moves: the lesser of the line's need and the copies available.
    listed: int        # That Edition's quantity on the Deck's list now; 0 means Swap adds the line.


def capture_swaps(conn, user_id: str, needed: Iterable[UUID], counting: WantListCounting) -> SwapCapture:
    """What the hints of lines naming ``needed`` (Editions of lines that still need copies) read. The caller holds the
    owner row lock and passes the setting it read under it."""
    wanted = sorted(set(needed))
    if not wanted:
        return SwapCapture()
    groups = [row['group_id'] for row in conn.execute(GROUPS, (wanted,))]
    rules = {row['edition_id']: row['rule'] for row in conn.execute(RULES, (user_id, wanted))}
    accepted = {edition: frozenset(found - {edition}) for edition, found in accepts(conn, rules).items()
                if found - {edition}}
    if not groups and not accepted:
        return SwapCapture()
    editions = {row['edition_id']: GroupEdition(**row) for row in conn.execute(MEMBERS, (groups,))} if groups else {}
    outside = sorted((set(accepted) | {edition for found in accepted.values() for edition in found}) - set(editions))
    if outside:
        editions.update({row['edition_id']: GroupEdition(**row) for row in conn.execute(FACTS, (outside,))})
    return SwapCapture(editions=editions, allocation=allocate(conn, user_id, editions, counting), accepted=accepted)


def has_rules(conn, user_id: str) -> bool:
    """Whether the owner has made any Will accept choice (a scoped read then hands hints out over every Deck)."""
    return conn.execute(ANY_RULE, (user_id,)).fetchone()['found']


def hints(capture: SwapCapture, decks: Sequence[UUID],
          order: Callable[[GroupEdition], tuple]) -> dict[tuple[UUID, UUID], Hint]:
    """Each hinted line's hint, by (Deck id, Edition id). ``decks`` is every Deck of the owner, oldest first
    (``copy_allocation.deck_order``); ``order`` is the page's card order for an Edition. Pure."""
    allocation = capture.allocation
    if allocation is None:
        return {}
    rank = {deck: index for index, deck in enumerate(decks)}
    by_edition: dict[UUID, list[LineCount]] = {}
    by_deck: dict[UUID, list[LineCount]] = {}
    for (deck, edition), line in allocation.lines.items():
        by_edition.setdefault(edition, []).append(line)
        by_deck.setdefault(deck, []).append(line)
    members: dict[UUID, list[GroupEdition]] = {}
    for edition in capture.editions.values():
        if edition.group_id is not None:
            members.setdefault(edition.group_id, []).append(edition)

    def candidates(edition: UUID) -> list[GroupEdition]:
        """The Editions a line of ``edition`` may be offered: its Reprint Group's, then those its Will accept choice
        accepts (trading #275), each once."""
        group = capture.editions[edition].group_id
        found = {other.edition_id: other for other in (members.get(group, []) if group is not None else [])}
        for other in sorted(capture.accepted.get(edition, ())):
            found.setdefault(other, capture.editions[other])
        return list(found.values())

    def available(deck: UUID, edition: UUID) -> int:
        owned = allocation.owned.get(edition, 0)
        lines = by_edition.get(edition, [])
        rule = allocation.copies.get(edition)
        if allocation.counting == 'one_at_a_time':
            # Every copy the Deck doesn't already count, less those promised to open Loans; the Deck's own reserved
            # copies are among the ones it counts. Lent copies are in no Holding, so they never come off ``owned``, and
            # Borrowed Copies were never in it (#254).
            own = allocation.lines.get((deck, edition))
            reserved = rule.reserved - rule.reserved_own.get(deck, 0) if rule else 0
            return max(0, owned - reserved - (own.quantity - own.need - own.lent - own.borrowed if own else 0))
        spare = rule.spare if rule else 0
        return spare - sum(line.spare for line in lines if rank[line.deck_id] <= rank[deck])

    found: dict[tuple[UUID, UUID], Hint] = {}
    held_back: dict[UUID, int] = {}
    for deck in decks:
        if allocation.counting == 'one_at_a_time':
            held_back = {}
        short = sorted((line for line in by_deck.get(deck, []) if line.need > 0),
                       key=lambda line: order(capture.editions[line.edition_id]))
        for line in short:
            best: tuple[int, GroupEdition] | None = None
            for other in candidates(line.edition_id):
                if other.edition_id == line.edition_id:
                    continue
                if not other.available and (deck, other.edition_id) not in allocation.lines:
                    continue
                free = available(deck, other.edition_id) - held_back.get(other.edition_id, 0)
                if free > 0 and (best is None or (-free, order(other)) < (-best[0], order(best[1]))):
                    best = (free, other)
            if best is None:
                continue
            free, other = best
            count = min(line.need, free)
            held_back[other.edition_id] = held_back.get(other.edition_id, 0) + count
            listed = allocation.lines.get((deck, other.edition_id))
            found[(deck, line.edition_id)] = Hint(edition_id=other.edition_id, count=count,
                                                  listed=listed.quantity if listed else 0)
    return found


def swap_hint(hint: Hint | None, capture: SwapCapture) -> SwapHint | None:
    """The route's form of a hint, or None for a line without one."""
    if hint is None:
        return None
    edition = capture.editions[hint.edition_id]
    return SwapHint(edition_id=hint.edition_id, set_code=edition.set_code,
                    collector_number=edition.collector_number, descriptor=edition.descriptor,
                    count=str(hint.count), listed=str(hint.listed))
