"""Trusted PostgreSQL-to-shared-records writer for public-safe catalog records.

Anonymous readers resolve opaque Edition/Printing references, Live eligibility and
marketplace eligibility only through these records. Values are a strict allowlist
(see ``printing_value``/``edition_value``/``quarantine_value``): public references,
display fields, the physical descriptor, the public review revision and the effective
Live/marketplace state with its fixed reason code. Internal UUIDs, source IDs, owners,
Holdings, sessions, reviewer identity, evidence, free-text reasons, reports, rejected
fingerprints, source candidates and quote amounts never appear here.

Delivery rests on two facts. Every correction takes a commit-ordered ``public_revision``
from one PostgreSQL clock and enqueues the target in the same transaction (a dirty-target
outbox). A drain re-reads current committed PostgreSQL state and writes a record only when
its revision is NEWER than the stored one, using compare-and-swap. A stale, late, replayed
or concurrent drainer therefore cannot reintroduce older state, and a restored store is
repaired by ``rebuild``. The records store is derived and rebuildable: a failed write never
rolls back the PostgreSQL commit that triggered it and never touches Published Deck
snapshots, visibility or the discovery revision.
"""
import logging
import time
from dataclasses import dataclass

from .public_projection import ProjectionUnavailable, public_record_store
from .public_records import (catalog_edition_key, catalog_printing_key, quarantine_key, quote_states)

log = logging.getLogger(__name__)
LOCK = 914706               # Session advisory lock: one drainer at a time. Correctness never depends on it.
EDITION_CAS = 64            # Editions per CAS: catalog + quarantine key each, so 128 keys.
PRINTING_CAS = 128
CHUNK_TARGETS = 64          # Pending targets taken per snapshot, in (priority, sequence) order.
ATTEMPTS = 4                # Rebuild-and-retry rounds when a CAS loses or the store looks ahead.
CHUNK_SECONDS = 10          # Per store call, so a full catalog is never bounded by one deadline.
LOCK_WAITS = 100            # Rebuild retries a busy drain lock for up to ~20 s.
LOCK_WAIT_SECONDS = 0.2
REQUEST_BUDGET = 2.0        # Seconds a request path may spend draining after its own commit.
LIVE_IDENTITY_KEYS = ('category', 'name', 'set_code', 'number')


@dataclass(frozen=True)
class DrainResult:
    written: int = 0        # Targets whose records were written.
    unchanged: int = 0      # Targets already current in the store.
    pending: int = 0        # Undelivered outbox rows left behind.
    busy: bool = False      # Another drainer holds the lock.

    @property
    def state(self):
        return 'pending' if self.pending or self.busy else 'delivered'


@dataclass(frozen=True)
class Built:
    revision: int
    values: dict            # record key -> public value


def public_image_url(image_url):
    """The same derived image the frozen Published Deck rows use."""
    return f'{image_url}/low.webp' if image_url else None


def printing_value(row):
    identity = row['live_identity'] if row['live_state'] == 'eligible' and isinstance(row['live_identity'], dict) else None
    return {'printing_ref': row['printing_ref'], 'name': row['display_name'], 'set_id': row['set_id'],
            'set_name': row['set_name'], 'collector_number': row['collector_number'],
            'image_url': public_image_url(row['image_url']), 'revision': row['public_revision'],
            'live': {'state': row['live_state'], 'reason': row['live_reason'], 'rule_version': row['rule_version'],
                     'identity': None if identity is None else {key: identity.get(key) for key in LIVE_IDENTITY_KEYS}}}


def edition_value(row):
    verified = row['mapping_state'] == 'verified'
    lookup = ({'source': 'tcgdex', 'card': row['source_id'], 'variant': row['quote_variant']}
              if verified and row['quote_variant'] and row['source'] == 'tcgdex' and row['source_id'] else None)
    return {'edition_ref': row['edition_ref'], 'printing_ref': row['printing_ref'], 'descriptor': row['descriptor'],
            'revision': row['public_revision'],
            'marketplace': {'state': row['mapping_state'], 'reason': None if verified else row['mapping_reason'],
                            'mapping_revision': row['mapping_revision'],
                            'product_id': row['product_id'] if verified else None, 'quote_lookup': lookup}}


def quarantine_value(row):
    return {'edition_ref': row['edition_ref'], 'revision': row['public_revision'],
            'mapping_revision': row['mapping_revision'],
            'state': 'quarantined' if row['mapping_state'] == 'quarantined' else 'clear'}


def build_values(conn, targets):
    """Current committed public values for ``[(kind, id)]``: ``{(kind, id): Built}``.

    One statement per kind, so each target's revision and content come from one snapshot.
    Targets that no longer exist are absent from the result.
    """
    ids = {'printing': [], 'edition': []}
    for kind, target in targets:
        ids[kind].append(target)
    built = {}
    if ids['printing']:
        for row in conn.execute("""SELECT p.id,p.public_ref AS printing_ref,ci.display_name,
          coalesce(pd.set_id,'') AS set_id,coalesce(pd.set_name,'') AS set_name,
          coalesce(pd.collector_number,'') AS collector_number,pd.image_url,
          m.public_revision,m.live_state,m.live_reason,m.live_identity,a.version AS rule_version
          FROM catalog_printing p JOIN catalog_identity ci ON ci.id=p.identity_id
          JOIN catalog_printing_metadata m ON m.printing_id=p.id
          LEFT JOIN catalog_printing_display pd ON pd.printing_id=p.id
          LEFT JOIN catalog_rule_activation a ON a.id=m.live_activation_id
          WHERE p.id=ANY(%s::uuid[])""", (ids['printing'],)):
            built[('printing', row['id'])] = Built(row['public_revision'],
                                                   {catalog_printing_key(row['printing_ref']): printing_value(row)})
    if ids['edition']:
        for row in conn.execute("""SELECT e.id,e.public_ref AS edition_ref,p.public_ref AS printing_ref,e.descriptor,
          p.source,p.source_id,m.public_revision,m.mapping_state,m.mapping_reason,m.mapping_revision,m.product_id,m.quote_variant
          FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
          JOIN catalog_edition_metadata m ON m.edition_id=e.id
          WHERE e.id=ANY(%s::uuid[])""", (ids['edition'],)):
            built[('edition', row['id'])] = Built(row['public_revision'], {
                catalog_edition_key(row['edition_ref']): edition_value(row),
                quarantine_key(row['edition_ref']): quarantine_value(row)})
    return built


def stored_revision(value):
    """Missing counts as -1; a ticket-04 value without a revision counts as 0."""
    if value is None:
        return -1
    revision = value.get('revision') if isinstance(value, dict) else None
    return revision if type(revision) is int and revision >= 0 else 0


def classify(built, records):
    """Compare one target with the store: 'write', 'current', 'ahead' (store newer) or 'mismatch' (same revision, other value)."""
    stored = [stored_revision(records[key].value) for key in built.values]
    if any(revision > built.revision for revision in stored):
        return 'ahead'
    if all(revision == built.revision for revision in stored):
        return 'current' if all(records[key].value == value for key, value in built.values.items()) else 'mismatch'
    return 'write'


def _bounded(deadline):
    limit = time.monotonic() + CHUNK_SECONDS
    return limit if deadline is None else min(limit, deadline)


def _expired(deadline):
    return deadline is not None and time.monotonic() >= deadline


def _record_failure(conn, sequences, error):
    if sequences:
        conn.execute("UPDATE catalog_public_outbox SET attempts=attempts+1,last_error=%s WHERE sequence=ANY(%s)",
                     (error, list(sequences)))
    conn.commit()


def _mark_delivered(conn, delivered, error=None):
    """Mark rows delivered only up to the revision actually in the store, and only if still undelivered."""
    if delivered:
        kinds, ids, revisions = zip(*[(kind, target, revision) for (kind, target), revision in delivered.items()])
        conn.execute("""UPDATE catalog_public_outbox o SET delivered_at=now(),last_error=%s
          FROM unnest(%s::text[],%s::uuid[],%s::bigint[]) AS d(kind,id,revision)
          WHERE o.target_kind=d.kind AND o.target_id=d.id AND o.revision<=d.revision AND o.delivered_at IS NULL""",
                     (error, list(kinds), list(ids), list(revisions)))
    conn.commit()


def pending_status(conn):
    row = conn.execute("""SELECT count(*) AS pending,extract(epoch FROM clock_timestamp()-min(created_at)) AS oldest
      FROM catalog_public_outbox WHERE delivered_at IS NULL""").fetchone()
    conn.commit()
    return row['pending'], (None if row['oldest'] is None else float(row['oldest']))


def _deliver(conn, store, chunk, deadline):
    """Deliver one chunk of distinct targets. Returns (written, unchanged, stuck target -> error).

    Each round builds from committed PostgreSQL, reads the store and writes only newer
    state. A lost CAS or a store that looks ahead of a possibly stale build repeats the
    round with a fresh build, so a stalled drainer can never clear a newer invalidation.
    """
    written = unchanged = 0
    stuck = {}
    remaining = list(chunk)
    for _ in range(ATTEMPTS):
        if not remaining or _expired(deadline):
            break
        built = build_values(conn, remaining)
        conn.commit()
        gone = [target for target in remaining if target not in built]
        _mark_delivered(conn, {target: 2 ** 62 for target in gone}, 'TargetMissing')
        keys = [key for target in built for key in built[target].values]
        records = store.read_all(keys, deadline=_bounded(deadline)).records if keys else {}
        retry, current, delivered = [], [], {}
        verdicts = {target: classify(built[target], records) for target in built}
        for target, verdict in verdicts.items():
            if verdict == 'current':
                delivered[target] = built[target].revision
                current.append(target)
            elif verdict == 'mismatch':
                stuck[target] = 'RevisionValueMismatch'
            elif verdict == 'ahead':
                retry.append(target)
                stuck[target] = 'StoreAhead'
        retry_set = set(retry)
        for kind, size in (('edition', EDITION_CAS), ('printing', PRINTING_CAS)):
            writes = [target for target, verdict in verdicts.items() if verdict == 'write' and target[0] == kind]
            for start in range(0, len(writes), size):
                batch = writes[start:start + size]
                keys = [key for target in batch for key in built[target].values]
                changes = {key: built[target].values[key] for target in batch for key in built[target].values}
                if store.compare_and_swap({key: records[key].version for key in keys}, changes, deadline=_bounded(deadline)):
                    written += len(batch)
                    delivered.update({target: built[target].revision for target in batch})
                else:
                    retry_set.update(batch)  # Lost a race: rebuild from PostgreSQL rather than trust this read.
        unchanged += len(current)
        _mark_delivered(conn, delivered)
        for target in delivered:
            stuck.pop(target, None)
        remaining = [target for target in remaining if target in retry_set]
        if not remaining:
            break
    for target in remaining:
        stuck.setdefault(target, 'CatalogRaced')
    return written, unchanged, stuck


def _drain_locked(conn, store, deadline):
    """Deliver pending targets in (priority, sequence) order. Holds no PostgreSQL lock during store I/O."""
    written = unchanged = 0
    skip, retried = [], set()
    while not _expired(deadline):
        rows = conn.execute("""SELECT sequence,target_kind,target_id FROM catalog_public_outbox
          WHERE delivered_at IS NULL AND sequence<>ALL(%s::bigint[]) ORDER BY priority,sequence LIMIT %s""",
                            (skip, CHUNK_TARGETS * 4)).fetchall()
        conn.commit()
        if not rows:
            break
        chunk = list(dict.fromkeys((row['target_kind'], row['target_id']) for row in rows))[:CHUNK_TARGETS]
        sequences = [row['sequence'] for row in rows if (row['target_kind'], row['target_id']) in chunk]
        try:
            wrote, same, stuck = _deliver(conn, store, chunk, deadline)
        except ProjectionUnavailable:
            conn.rollback()
            _record_failure(conn, sequences, 'ProjectionUnavailable')
            break
        written += wrote
        unchanged += same
        left = conn.execute("SELECT sequence,target_kind,target_id FROM catalog_public_outbox WHERE sequence=ANY(%s) AND delivered_at IS NULL",
                            (sequences,)).fetchall()
        conn.commit()
        for row in left:
            target = (row['target_kind'], row['target_id'])
            if target in stuck:
                _record_failure(conn, [row['sequence']], stuck[target])
                skip.append(row['sequence'])
            elif row['sequence'] in retried:  # Still undelivered after a clean round: never spin on it.
                _record_failure(conn, [row['sequence']], 'RevisionBehind')
                skip.append(row['sequence'])
            else:
                retried.add(row['sequence'])  # Normally a newer revision enqueued while delivering.
    return written, unchanged, len(skip)


def drain(conn, store=None, *, budget=None):
    """Deliver the outbox to the records store. Never raises ProjectionUnavailable; failures leave rows pending.

    ``budget`` is seconds for request paths (None for scripts and background imports). Only one
    drainer runs at a time; a busy lock reports ``pending``. The holder re-checks once after
    unlocking so work enqueued meanwhile is not stranded until the next trigger.
    """
    store = store or public_record_store()
    deadline = None if budget is None else time.monotonic() + budget
    conn.rollback()
    written = unchanged = 0
    stuck = 0
    for _ in range(2):
        if not conn.execute('SELECT pg_try_advisory_lock(%s) AS ok', (LOCK,)).fetchone()['ok']:
            conn.commit()
            pending, _ = pending_status(conn)
            return DrainResult(written, unchanged, pending, busy=True)
        conn.commit()
        try:
            wrote, same, stuck = _drain_locked(conn, store, deadline)
            written += wrote
            unchanged += same
        finally:
            conn.rollback()
            conn.execute('SELECT pg_advisory_unlock(%s)', (LOCK,))
            conn.commit()
        waiting = conn.execute("SELECT count(*) AS n FROM catalog_public_outbox WHERE delivered_at IS NULL AND attempts=0").fetchone()['n']
        conn.commit()
        if not waiting or _expired(deadline):
            break
    pending, _ = pending_status(conn)
    return DrainResult(written, unchanged, pending)


def mark_all_dirty(conn):
    """Re-enqueue every target at its current revision (rebuild), including already delivered rows."""
    conn.execute("""INSERT INTO catalog_public_outbox(target_kind,target_id,revision,priority)
      SELECT 'printing',printing_id,greatest(public_revision,1),CASE WHEN live_state='suspended' THEN 0 ELSE 1 END
        FROM catalog_printing_metadata
      UNION ALL
      SELECT 'edition',edition_id,greatest(public_revision,1),CASE WHEN mapping_state='quarantined' THEN 0 ELSE 1 END
        FROM catalog_edition_metadata
      ON CONFLICT(target_kind,target_id,revision) DO UPDATE
        SET delivered_at=NULL,attempts=0,last_error=NULL,priority=least(catalog_public_outbox.priority,EXCLUDED.priority)""")
    conn.commit()


@dataclass(frozen=True)
class RebuildResult:
    written: int
    unchanged: int
    store_max: int
    conflicts: int
    pending: int = 0


SCAN_PAGE = 500


def _scan(conn, store):
    """Read every PostgreSQL-known key from the store. Returns (store_max, printing ids, edition ids in conflict)."""
    store_max = 0
    conflicts = {'printing': [], 'edition': []}
    last = {'printing': None, 'edition': None}
    for kind, table, column in (('printing', 'catalog_printing_metadata', 'printing_id'),
                                ('edition', 'catalog_edition_metadata', 'edition_id')):
        while True:
            rows = conn.execute(f"""SELECT {column} AS id FROM {table} WHERE (%s::uuid IS NULL OR {column}>%s::uuid)
              ORDER BY {column} LIMIT %s""", (last[kind], last[kind], SCAN_PAGE)).fetchall()
            conn.commit()
            if not rows:
                break
            last[kind] = rows[-1]['id']
            targets = [(kind, row['id']) for row in rows]
            built = build_values(conn, targets)
            conn.commit()
            keys = [key for target in built for key in built[target].values]
            records = store.read_all(keys, deadline=time.monotonic() + CHUNK_SECONDS).records
            for target, value in built.items():
                store_max = max([store_max, *(stored_revision(records[key].value) for key in value.values)])
                if classify(value, records) in ('ahead', 'mismatch'):
                    conflicts[kind].append(target[1])
    return store_max, conflicts['printing'], conflicts['edition']


def _reconcile(conn, store_max, printings, editions):
    """One correction transaction: advance the clock past the store, then stamp conflicts above it.

    The clock moves first. ``catalog_begin_correction`` caches its revision for the whole
    transaction, so taking it earlier would stamp every conflict at or below ``store_max``.
    """
    clock = conn.execute('SELECT revision FROM catalog_public_clock').fetchone()['revision']
    conn.commit()
    if store_max <= clock and not (printings or editions):
        return 0  # Nothing to reconcile: do not queue behind an import that holds the clock.
    with conn.transaction():
        conn.execute("UPDATE catalog_public_clock SET revision=greatest(revision,%s) WHERE singleton", (store_max,))
        if not (printings or editions):
            return 0
        revision = conn.execute('SELECT catalog_begin_correction() AS revision').fetchone()['revision']
        if editions:
            conn.execute("""UPDATE catalog_edition_metadata SET mapping_state='quarantined',mapping_reason='recovery_conflict',
              auto_closed=true,public_revision=%s,
              mapping_revision=mapping_revision+(CASE WHEN mapping_state='quarantined' THEN 0 ELSE 1 END)
              WHERE edition_id=ANY(%s::uuid[])""", (revision, editions))
        if printings:
            conn.execute("""UPDATE catalog_printing_metadata SET live_state='suspended',live_reason='recovery_conflict',
              live_identity=NULL,live_auto_closed=true,public_revision=%s WHERE printing_id=ANY(%s::uuid[])""",
                         (revision, printings))
        return len(printings) + len(editions)


def rebuild(conn, store=None):
    """Republish every public record from PostgreSQL, after reconciling the revision clock with the store.

    R1 (store re-initialized empty) and R2 (store restored from an older copy) need only the
    republish: every stored revision is lower. R3 (PostgreSQL restored older than the store):
    any record whose stored revision is higher than PostgreSQL's, or equal with different
    content, is a recovery conflict. The clock is advanced to the highest stored revision and
    each conflicting target is marked quarantined / suspended with reason ``recovery_conflict``
    at a revision above it, so those fail-closed values replace the foreign ones.
    Raises ProjectionUnavailable when the store is unreachable or delivery cannot finish.
    """
    store = store or public_record_store()
    store_max, printings, editions = _scan(conn, store)
    conflicts = _reconcile(conn, store_max, printings, editions)
    mark_all_dirty(conn)
    for _ in range(LOCK_WAITS):  # A concurrent request-path drainer is brief; recovery waits for it.
        result = drain(conn, store)
        if not result.busy:
            break
        time.sleep(LOCK_WAIT_SECONDS)
    if result.pending or result.busy:
        raise ProjectionUnavailable()
    return RebuildResult(result.written, result.unchanged, store_max, conflicts)


def publish_catalog_best_effort(conn=None, *, printing_ids=None, budget=None):
    """Post-commit hook (shim over ``drain``): never raises, never affects committed PostgreSQL work.

    ``printing_ids`` is accepted for old callers and ignored: the outbox, not the caller, knows what is dirty.
    A caller without its own connection is a request path and gets the short request budget.
    """
    try:
        if conn is None:
            from .main import connect
            with connect() as own:
                result = drain(own, budget=REQUEST_BUDGET if budget is None else budget)
        else:
            result = drain(conn, budget=budget)
        return result.state == 'delivered'
    except Exception as exc:  # Records are rebuildable; report only the class, never details.
        log.warning('Public catalog records not published (%s); run scripts/backfill_public_catalog.py', type(exc).__name__)
        return False


def backfill():
    """Idempotent full rebuild from PostgreSQL; raises when the store is unavailable."""
    from .main import connect
    with connect() as conn:
        return rebuild(conn)


# --- Fail-closed public readers ------------------------------------------------------------
@dataclass(frozen=True)
class MarketplaceState:
    state: str                      # 'unknown' | 'unverified' | 'verified' | 'quarantined'
    reason: str | None = None
    mapping_revision: int | None = None
    product_id: int | None = None
    quote_lookup: dict | None = None
    quote: object = None            # QuoteState when a price lookup is allowed, else None
    generation: str | None = None

    @property
    def product_eligible(self):
        return self.state == 'verified' and self.product_id is not None

    @property
    def price_eligible(self):
        return self.product_eligible and self.quote_lookup is not None


@dataclass(frozen=True)
class LiveState:
    state: str                      # 'unknown' | 'unsupported' | 'eligible' | 'suspended'
    reason: str | None = None
    rule_version: int | None = None
    identity: dict | None = None
    generation: str | None = None

    @property
    def eligible(self):
        return self.state == 'eligible' and self.identity is not None


def _int(value):
    return type(value) is int and value >= 0


def _marketplace(ref, edition, quarantine):
    """Validated (state, reason, mapping_revision, product_id, quote_lookup), or None to fail closed."""
    try:
        if not isinstance(edition, dict) or not isinstance(quarantine, dict) or set(edition) != EDITION_KEYS \
                or set(quarantine) != QUARANTINE_KEYS or edition['edition_ref'] != ref or quarantine['edition_ref'] != ref:
            return None
        market = edition['marketplace']
        if not isinstance(market, dict) or set(market) != MARKETPLACE_KEYS or not _int(edition['revision']) \
                or edition['revision'] != quarantine['revision'] or not _int(market['mapping_revision']) \
                or market['mapping_revision'] != quarantine['mapping_revision'] \
                or market['state'] not in ('verified', 'unverified', 'quarantined') or quarantine['state'] not in ('clear', 'quarantined'):
            return None
        lookup = market['quote_lookup']
        if lookup is not None and (not isinstance(lookup, dict) or set(lookup) != {'source', 'card', 'variant'}
                                   or not all(isinstance(lookup[key], str) and lookup[key] for key in lookup)):
            return None
        product = market['product_id']
        if product is not None and (type(product) is not int or product <= 0):
            return None
    except (KeyError, TypeError):
        return None
    if quarantine['state'] == 'quarantined' or market['state'] == 'quarantined':
        return 'quarantined', market['reason'], market['mapping_revision'], None, None
    if market['state'] != 'verified':
        return market['state'], market['reason'], market['mapping_revision'], None, None
    if product is None:
        return None
    return 'verified', None, market['mapping_revision'], product, lookup


def marketplace_states(store, edition_refs, deadline, *, generation=None):
    """Marketplace eligibility per Edition reference, read at one pinned generation.

    An Edition is ineligible (``unknown``) when either its catalog or quarantine record is
    missing, malformed or disagrees on revision or mapping revision, and when it is
    quarantined or not verified. A verified Edition is product-eligible when a product ID
    is published and price-eligible when a quote lookup is. Quote state, when allowed, is
    read at the same generation. ProjectionUnavailable propagates when the store is down.
    """
    refs = list(dict.fromkeys(edition_refs))
    if not refs:
        return {}
    keys = [key for ref in refs for key in (catalog_edition_key(ref), quarantine_key(ref))]
    snapshot = store.read_all(keys, deadline=deadline, generation=generation)
    states, pairs = {}, []
    for ref in refs:
        checked = _marketplace(ref, snapshot.records[catalog_edition_key(ref)].value, snapshot.records[quarantine_key(ref)].value)
        if checked is None:
            states[ref] = MarketplaceState('unknown', generation=snapshot.generation)
            continue
        state, reason, mapping_revision, product, lookup = checked
        states[ref] = MarketplaceState(state, reason, mapping_revision, product, lookup, None, snapshot.generation)
        if state == 'verified' and lookup is not None and mapping_revision >= 1:
            pairs.append((ref, mapping_revision))
    if pairs:
        for (ref, revision), quote in quote_states(store, pairs, deadline=deadline, generation=snapshot.generation).items():
            states[ref] = MarketplaceState(**{**states[ref].__dict__, 'quote': quote})
    return states


def live_states(store, printing_refs, deadline, *, generation=None):
    """Live eligibility per Printing reference, fail closed: anything malformed or missing is ``unknown``."""
    refs = list(dict.fromkeys(printing_refs))
    if not refs:
        return {}
    snapshot = store.read_all([catalog_printing_key(ref) for ref in refs], deadline=deadline, generation=generation)
    states = {}
    for ref in refs:
        value = snapshot.records[catalog_printing_key(ref)].value
        states[ref] = _live(ref, value, snapshot.generation)
    return states


def _live(ref, value, generation):
    unknown = LiveState('unknown', generation=generation)
    try:
        if not isinstance(value, dict) or set(value) != PRINTING_KEYS or value['printing_ref'] != ref or not _int(value['revision']):
            return unknown
        live = value['live']
        if not isinstance(live, dict) or set(live) != {'state', 'reason', 'rule_version', 'identity'} \
                or live['state'] not in ('unsupported', 'eligible', 'suspended'):
            return unknown
        identity = live['identity']
        if live['state'] == 'eligible':
            if not isinstance(identity, dict) or set(identity) != set(LIVE_IDENTITY_KEYS) \
                    or not all(isinstance(identity[key], str) and identity[key] for key in identity):
                return unknown
        elif identity is not None:
            return unknown
        return LiveState(live['state'], live['reason'], live['rule_version'], identity, generation)
    except (KeyError, TypeError):
        return unknown


PRINTING_KEYS = {'printing_ref', 'name', 'set_id', 'set_name', 'collector_number', 'image_url', 'revision', 'live'}
EDITION_KEYS = {'edition_ref', 'printing_ref', 'descriptor', 'revision', 'marketplace'}
MARKETPLACE_KEYS = {'state', 'reason', 'mapping_revision', 'product_id', 'quote_lookup'}
QUARANTINE_KEYS = {'edition_ref', 'revision', 'mapping_revision', 'state'}
