"""Pure catalog planning from explicitly assessed Riftbound pulls."""
from dataclasses import asdict, dataclass, replace
import hashlib
import json
import math
import re
from typing import Iterable, Mapping, Optional, Sequence, Tuple, Union
from uuid import UUID

from .model import (FLAGS, FLAG_IDENTITY_TEXT_CONFLICT, FLAG_CARD_SCOPE_PENDING,
                    FLAG_MARKER_GROUPING_PENDING, FLAG_DUPLICATE_NUMBER_PENDING,
                    FLAG_EXTENDED_FIELD_REPEATED, FLAG_PRINTING_DETAILS_DIFFER,
                    GroupResult, GroupSnapshot, PrintingCandidate, PrintingKey, CardScope, EditionCandidate, PriceObservation)
from .lifecycle import PullQuality, compare_group
from .normalize import (SourceResponseError, DETAIL_FIELDS, MULTI_VALUE_DETAILS, NO_VALUE,
                        rules_text, split_values)

# Open owner question: add Unspecified when an existing named finish becomes unpriced.
# True matches #626; the alternative preserves only the existing options.
NAMED_FINISH_UNPRICED_ADDS_UNSPECIFIED: bool = True

MAX_PRODUCT_ID = 9_999_999_999_999_999_999
MAX_GROUP_ID = 2_147_483_647
MAX_KEY_TEXT_BYTES = 500
MAX_DEPTH = 32


def valid_id(value, maximum):
    return type(value) is int and 1 <= value <= maximum


def valid_text(value):
    if not isinstance(value, str) or '\x00' in value:
        return False
    try:
        value.encode('utf-8')
    except UnicodeEncodeError:
        return False
    return True


GROUP_PULL_HELD = 'group_pull_held'
REVIEW_KINDS = FLAGS + ('missing_from_source', 'group_change', 'display_change', 'duplicate_product_id', GROUP_PULL_HELD)  # 14, in this order
PRODUCT_HOLD_FLAGS = frozenset({FLAG_IDENTITY_TEXT_CONFLICT, FLAG_CARD_SCOPE_PENDING, FLAG_MARKER_GROUPING_PENDING,
                                FLAG_DUPLICATE_NUMBER_PENDING, FLAG_EXTENDED_FIELD_REPEATED, FLAG_PRINTING_DETAILS_DIFFER})
UNSPECIFIED = {"kind": "unspecified", "label": "Unspecified Variant"}           # Pokémon's descriptor, catalog.py:122
DESCRIPTOR_BY_FINISH = {'normal': {"finish": "normal"}, 'foil': {"finish": "foil"}, 'unspecified': UNSPECIFIED}

@dataclass(frozen=True)
class EditionRow: descriptor_key: str; descriptor: dict    # editions tuples are always sorted by descriptor_key
@dataclass(frozen=True)
class GroupInfo:
    group_id: int
    name: str

    def __post_init__(self):
        if not valid_id(self.group_id, MAX_GROUP_ID) or not valid_text(self.name):
            raise ValueError('invalid group metadata')
@dataclass(frozen=True)
class GroupPull:                    # quality has NO default: constructing without it is a TypeError
    info: GroupInfo
    result: Union[GroupResult, SourceResponseError, None]
    quality: PullQuality
    raw: dict                       # {"products": <response as received>, "prices": <response as received>} or {"error": str}
    reasons: Tuple[str, ...] = ()
@dataclass(frozen=True)
class ExistingPrinting:             # one per catalog_generation_printing row of the ACTIVE generation, any source
    printing_id: UUID
    source_id: str                  # catalog_generation_printing.source_id: '<productId>' or 'manual:<printing uuid>'
    group_id: Optional[int]         # int(set_id) when catalog_printing.source='tcgcsv'; None when 'manual'
    identity_key: str
    identity_display_name: str
    set_id: str
    set_name: str
    collector_number: str
    display_name: str
    search_name: str
    source_fingerprint: str
    editions: Tuple[EditionRow, ...]            # its active Editions (descriptor_key, descriptor from catalog_edition), sorted by descriptor_key
@dataclass(frozen=True)
class PreviousState:
    snapshots: Mapping[int, GroupSnapshot]      # from riftbound_group_snapshot
    printings: Mapping[str, ExistingPrinting]   # by source_id
    evidence: Mapping[str, str]                 # identity_key -> evidence_sha256
@dataclass(frozen=True)
class PrintingRow:
    source_id: str                  # same two forms as ExistingPrinting.source_id
    group_id: Optional[int]         # None only for carried manual rows
    printing_id: Optional[UUID]     # the existing catalog_printing.id; None only for a new TCGCSV product
    identity_key: str
    identity_display_name: str
    set_id: str
    set_name: str
    collector_number: str
    display_name: str
    search_name: str
    source_fingerprint: str
    editions: Tuple[EditionRow, ...]
    carried: bool
@dataclass(frozen=True)
class ReviewRow: source_id: str; kind: str; source_fingerprint: str; detail: str; candidate: dict
@dataclass(frozen=True)
class GroupOutcome:                 # status: compare_group's 'compared' | 'pull_failed' | 'pull_suspicious' | 'quality_unknown', or 'not_pulled'
    group_id: int
    status: str
    written: int
    held_missing: int
    held_review: int
@dataclass(frozen=True)
class RunPlan:
    printings: Tuple[PrintingRow, ...]          # the WHOLE next generation, sorted by row_order(source_id)
    reviews: Tuple[ReviewRow, ...]              # deduplicated on (source_id, kind, source_fingerprint), sorted by
                                                # (row_order(source_id), kind, source_fingerprint)
    snapshots: Mapping[int, GroupSnapshot]      # only groups whose decision status is 'compared'; prices stripped
    evidence: Mapping[str, str]                 # identity_key -> sha for identities first seen in this run
    outcomes: Tuple[GroupOutcome, ...]          # sorted by group_id
    content_sha256: str                         # content_digest(printings)
    compared: int                               # number of groups with status 'compared'


def raw_bytes(value: object) -> bytes:
    """Encode raw evidence with ASCII escapes, or a stable unencodable marker."""
    try:
        return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True,
                          allow_nan=True).encode('ascii')
    except (TypeError, ValueError, RecursionError):
        return b'{"unencodable":' + json.dumps(type(value).__name__).encode('ascii') + b'}'


def storage_violations(info, raw, result) -> Tuple[str, ...]:
    """Check text, JSON values, ID domains and indexed text limits without recursion.

    Raw tuples are invalid. Tuples from the model's derived data serialize as arrays.
    """
    codes = set()

    def walk(root, derived=False):
        stack = [(root, 0)]
        while stack:
            value, depth = stack.pop()
            kind = type(value)
            if kind is str:
                if not valid_text(value):
                    codes.add('invalid_text')
            elif kind in (dict, list) or derived and kind is tuple:
                if depth > MAX_DEPTH:
                    codes.add('invalid_value')
                    continue
                if kind is dict:
                    for key, item in value.items():
                        if type(key) is not str:
                            codes.add('invalid_value')
                        stack.append((key, depth + 1))
                        stack.append((item, depth + 1))
                else:
                    stack.extend((item, depth + 1) for item in value)
            elif kind is float:
                if not math.isfinite(value):
                    codes.add('invalid_value')
            elif kind not in (int, bool, type(None)):
                codes.add('invalid_value')

    try:
        walk(raw)
        if type(raw) is dict:
            for what in ('products', 'prices'):
                payload = raw.get(what)
                records = payload.get('results') if type(payload) is dict else payload
                if type(records) is not list:
                    continue
                for row in records:
                    if type(row) is not dict:
                        continue
                    if not valid_id(row.get('productId'), MAX_PRODUCT_ID):
                        codes.add('invalid_id')
                    if (what == 'products' or 'groupId' in row) and not valid_id(row.get('groupId'), MAX_GROUP_ID):
                        codes.add('invalid_id')
                    fields = ('cleanName', 'imageUrl', 'modifiedOn') if what == 'products' else ('subTypeName',)
                    if any(row.get(field) is not None and type(row[field]) is not str for field in fields):
                        codes.add('invalid_value')
        if isinstance(result, GroupResult):
            walk(asdict(result), derived=True)
            if result.group_id is not None and result.group_id != info.group_id:
                codes.add('invalid_id')
            for p in (*result.printings, *result.excluded):
                if not valid_id(p.key.product_id, MAX_PRODUCT_ID) or not valid_id(p.key.group_id, MAX_GROUP_ID):
                    codes.add('invalid_id')
            for p in result.printings:
                for text in (p.name, p.name.casefold(), p.identity_key, p.number):
                    if text is not None and valid_text(text) and len(text.encode('utf-8')) > MAX_KEY_TEXT_BYTES:
                        codes.add('text_too_long')
    except Exception:
        # The gate must return a verdict even for non-JSON inputs or recursive model data.
        codes.add('invalid_value')
    return tuple(sorted(codes))


def descriptor_key(descriptor: dict) -> str:
    return json.dumps(descriptor, sort_keys=True)


def _sha(value, *, ensure_ascii=True):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                    ensure_ascii=ensure_ascii).encode('utf-8')).hexdigest()


def row_order(source_id: str) -> Tuple[int, int, str]:
    if re.fullmatch(r'[0-9]+', source_id):
        return (0, int(source_id), '')
    if source_id.startswith('manual:'):
        try:
            UUID(source_id[7:])
            return (1, 0, source_id)
        except ValueError:
            pass
    raise ValueError('invalid generation source_id')


def review_order(source_id: str) -> Tuple[int, int, str]:
    if re.fullmatch(r'group:[0-9]+', source_id):
        return (2, int(source_id[6:]), '')
    return row_order(source_id)


def content_digest(printings: Iterable[PrintingRow]) -> str:
    entries = [[p.source_id, p.identity_key, p.set_id, p.set_name, p.collector_number,
                p.display_name, p.search_name, p.source_fingerprint,
                sorted(e.descriptor_key for e in p.editions)]
               for p in sorted(printings, key=lambda p: row_order(p.source_id))]
    return _sha(entries, ensure_ascii=False)


def snapshot_to_json(snapshot: GroupSnapshot) -> dict:
    return json.loads(json.dumps(asdict(snapshot)))


def snapshot_from_json(data: dict) -> GroupSnapshot:
    def tuples(value):
        if isinstance(value, list):
            return tuple(tuples(v) for v in value)
        if isinstance(value, dict):
            return {k: tuples(v) for k, v in value.items()}
        return value
    printings = []
    for record in data['printings']:
        p = tuples(record)
        p['key'] = PrintingKey(**p['key'])
        p['scope'] = CardScope(**p['scope'])
        p['editions'] = tuple(EditionCandidate(**{**e, 'prices': tuple(PriceObservation(**v) for v in e['prices'])})
                              for e in p['editions'])
        printings.append(PrintingCandidate(**p))
    return GroupSnapshot(data['group_id'], tuple(printings))


def _evidence(p):
    details = []
    for field in DETAIL_FIELDS:
        raw = p.extended.get(field)
        if raw is None or raw.strip() in ('', NO_VALUE):
            details.append(None)
        elif field in MULTI_VALUE_DETAILS:
            details.append(tuple(sorted(split_values(raw)[0])))
        else:
            details.append(raw.strip())
    return _sha([rules_text(p.description_html), details])


def plan_run(previous: PreviousState, pulls: Sequence[GroupPull]) -> RunPlan:
    rows = {sid: PrintingRow(**vars(e), carried=True) for sid, e in previous.printings.items()}
    by_group = {p.info.group_id: p for p in pulls}
    if len(by_group) != len(pulls):
        raise ValueError('duplicate group pull')
    for pull in pulls:
        if pull.quality not in ('acceptable', 'suspicious', 'unknown'):
            raise ValueError('invalid pull quality')
        if pull.result is not None and not isinstance(pull.result, (GroupResult, SourceResponseError)):
            raise TypeError('invalid pull result')
    by_group = {gid: replace(p, quality='suspicious', reasons=tuple(sorted(set(p.reasons) | set(codes))))
                if p.quality == 'acceptable' and (codes := storage_violations(p.info, p.raw, p.result)) else p
                for gid, p in by_group.items()}
    snapshots, outcomes, reviews, evidence = {}, [], {}, {}
    decisions, candidates, fingerprints, proposed, seen = {}, {}, {}, {}, {}
    identity_shas = {}
    for gid, pull in sorted(by_group.items()):
        decision = compare_group(previous.snapshots.get(gid, GroupSnapshot(gid, ())),
                                 pull.result, quality=pull.quality)
        decisions[gid] = decision
        if decision.status != 'compared':
            continue
        snapshots[gid] = replace(decision.snapshot, printings=tuple(
            replace(p, editions=tuple(replace(e, prices=()) for e in p.editions))
            for p in decision.snapshot.printings))
        records = pull.raw['products']
        if isinstance(records, dict):
            records = records['results']
        raw = {p['productId']: p for p in records}
        candidates[gid] = {p.key.product_id: p for p in (*pull.result.printings, *pull.result.excluded)}
        for pid in candidates[gid]:
            fingerprints[gid, pid] = _sha(raw[pid])
            seen.setdefault(pid, set()).add(gid)
        for identity in pull.result.identities:
            members = [candidates[gid][k.product_id] for k in identity.printings]
            first = next((p for p in members if p.marker is None), members[0])
            sha = _evidence(first)
            identity_shas[gid, identity.identity_key] = sha
            proposed.setdefault(identity.identity_key, set()).add(sha)

    def review(gid, pid, kind, detail, fingerprint=None):
        p = candidates.get(gid, {}).get(pid)
        fingerprint = fingerprint or fingerprints.get((gid, pid)) or hashlib.sha256(detail.encode()).hexdigest()
        sid = str(pid)
        reviews[sid, kind, fingerprint] = ReviewRow(sid, kind, fingerprint, detail,
            {'group_id': gid, 'product_id': pid, 'flags': sorted(p.flags) if p else []})

    all_groups = set(by_group) | set(previous.snapshots) | {
        e.group_id for e in previous.printings.values() if e.group_id is not None}
    for gid in sorted(all_groups):
        if gid not in decisions or decisions[gid].status != 'compared':
            status = decisions[gid].status if gid in decisions else 'not_pulled'
            pull = by_group.get(gid)
            reasons = ((status,) if status in ('not_pulled', 'quality_unknown')
                       else pull.reasons or (status,))
            raw_sha = hashlib.sha256(raw_bytes(pull.raw)).hexdigest() if pull is not None else None
            fingerprint = _sha([status, sorted(reasons), raw_sha])
            sid = f'group:{gid}'
            reviews[sid, GROUP_PULL_HELD, fingerprint] = ReviewRow(
                sid, GROUP_PULL_HELD, fingerprint, ', '.join(reasons),
                {'group_id': gid, 'status': status, 'reasons': sorted(reasons)})
            outcomes.append(GroupOutcome(gid, status, 0, 0, 0))
            continue
        pull, decision = by_group[gid], decisions[gid]
        identities = {i.identity_key: i for i in pull.result.identities}
        written = held = 0
        for p in sorted(pull.result.printings, key=lambda p: p.key.product_id):
            pid, sid = p.key.product_id, str(p.key.product_id)
            e = previous.printings.get(sid)
            conflict = p.identity_key in proposed and (
                (identity_shas[gid, p.identity_key] != previous.evidence[p.identity_key])
                if p.identity_key in previous.evidence else len(proposed[p.identity_key]) > 1)
            duplicate = len(seen[pid]) > 1
            moved = e is not None and e.group_id != gid
            if conflict:
                review(gid, pid, 'identity_text_conflict', 'conflicts with the Card Identity already in the catalog')
            if duplicate:
                review(gid, pid, 'duplicate_product_id', 'product appears in multiple groups')
            if moved:
                review(gid, pid, 'group_change', 'product moved to another group')
            editions = {v.descriptor_key: v for v in e.editions} if e else {}
            finishes = {v.finish for v in p.editions if v.finish in DESCRIPTOR_BY_FINISH}
            for finish in sorted(finishes - {'unspecified'}):
                d = dict(DESCRIPTOR_BY_FINISH[finish])
                editions[descriptor_key(d)] = EditionRow(descriptor_key(d), d)
            if 'unspecified' in finishes and (NAMED_FINISH_UNPRICED_ADDS_UNSPECIFIED or not editions):
                d = dict(UNSPECIFIED)
                editions[descriptor_key(d)] = EditionRow(descriptor_key(d), d)
            if (set(p.flags) & PRODUCT_HOLD_FLAGS or p.identity_key is None or conflict or duplicate or moved
                    or not any(v.finish in DESCRIPTOR_BY_FINISH for v in p.editions)):
                held += 1
                continue
            identity = identities[p.identity_key]
            if e:
                if (p.identity_key, p.name, p.number, pull.info.name) != (
                        e.identity_key, e.display_name, e.collector_number, e.set_name):
                    review(gid, pid, 'display_change', 'display differs from the accepted catalog')
                row = replace(rows[sid], carried=False, source_fingerprint=fingerprints[gid, pid],
                              editions=tuple(editions[k] for k in sorted(editions)))
            else:
                row = PrintingRow(sid, gid, None, p.identity_key, identity.display_name,
                    str(gid), pull.info.name, p.number, p.name, p.name.casefold(), fingerprints[gid, pid],
                    tuple(editions[k] for k in sorted(editions)), False)
            rows[sid] = row
            written += 1
            # A display-change proposal may keep the accepted identity on this row.
            # Its proposed identity's evidence is eligible only when this row uses it.
            if row.identity_key == p.identity_key and row.identity_key not in previous.evidence:
                evidence[row.identity_key] = identity_shas[gid, row.identity_key]
        missing = 0
        for key in decision.held_missing:
            e = previous.printings.get(str(key.product_id))
            if e:
                missing += 1
                review(gid, key.product_id, 'missing_from_source', 'previously accepted product is missing', e.source_fingerprint)
        for item in pull.result.review:
            for pid in item.product_ids:
                review(gid, pid, item.code, item.detail)
        for p in pull.result.excluded:
            if len(seen[p.key.product_id]) > 1:
                review(gid, p.key.product_id, 'duplicate_product_id', 'product appears in multiple groups')
            if str(p.key.product_id) in previous.printings:
                review(gid, p.key.product_id, 'card_scope_pending', 'previously accepted product is now excluded as a token')
        outcomes.append(GroupOutcome(gid, 'compared', written, missing, held))
    ordered = tuple(rows[sid] for sid in sorted(rows, key=row_order))
    return RunPlan(ordered, tuple(reviews[k] for k in sorted(reviews, key=lambda k: (review_order(k[0]), *k[1:]))),
                   snapshots, evidence, tuple(outcomes), content_digest(ordered), len(snapshots))
