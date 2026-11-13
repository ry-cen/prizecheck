"""Settle obsolete review evidence, without making owner decisions."""
from collections import Counter
from typing import NamedTuple

from psycopg.errors import DeadlockDetected, LockNotAvailable

from app.db import connect
from app.identity import require_owner
from .settlement_audit import record_settlement

AUTO_STATUSES = ('stale', 'superseded')
STALE_REASON = 'Settled automatically: the current source record no longer raises this review'
SUPERSEDED_REASON = 'Superseded by a newer source record'


def _action(review, reviews, current_key, raised=None):
    if review['source_fingerprint'] == current_key:
        return 'stale' if raised is not None and review['kind'] not in raised else None
    replacement = (raised is not None and review['kind'] in raised or any(
        r['kind'] == review['kind'] and r['source_fingerprint'] == current_key for r in reviews))
    return 'superseded' if replacement else 'stale'


def _close(conn, review, current_key, action, actor_id=None):
    row = conn.execute("""UPDATE catalog_review SET status=%s,reviewer_id=NULL,reviewed_at=now(),
      evidence_url=NULL,reason=%s WHERE id=%s AND status='pending' RETURNING id""",
                       (action, SUPERSEDED_REASON if action == 'superseded' else STALE_REASON, review['id'])).fetchone()
    if row:
        record_settlement(conn, subject='review', action=action, review_id=review['id'], actor_id=actor_id,
                          before={'status': 'pending', 'source_fingerprint': review['source_fingerprint']},
                          after={'status': action, 'current_fingerprint': current_key})
    return int(row is not None)


def settle_source_reviews(conn, source_reviews, current_key, raised, actor_id=None):
    count = 0
    for review in source_reviews:
        if review['status'] == 'pending':
            action = _action(review, source_reviews, current_key, raised)
            if action:
                count += _close(conn, review, current_key, action, actor_id)
    return count


def reopen_review(conn, review):
    row = conn.execute("""UPDATE catalog_review SET status='pending',reviewed_at=NULL,reason=NULL
      WHERE id=%s AND status=ANY(%s) RETURNING id""", (review['id'], list(AUTO_STATUSES))).fetchone()
    if row:
        record_settlement(conn, subject='review', action='reopened', review_id=review['id'],
                          before={'status': review['status'], 'source_fingerprint': review['source_fingerprint']},
                          after={'status': 'pending', 'current_fingerprint': review['source_fingerprint']})


class ReviewItem(NamedTuple):
    review_id: object
    source_id: str
    kind: str
    action: str
    source_fingerprint: str
    current_fingerprint: str


def _current(conn, source_id):
    return conn.execute("""SELECT gp.source_fingerprint FROM catalog_state s
      JOIN catalog_generation_printing gp ON gp.generation_id=s.active_generation
      JOIN catalog_printing p ON p.id=gp.printing_id WHERE s.singleton AND gp.source_id=%s
      AND NOT gp.tombstoned AND p.source='tcgdex'""", (source_id,)).fetchone()


def plan_review_backlog(conn):
    items, manual = [], Counter()
    rows = conn.execute("SELECT * FROM catalog_review ORDER BY created_at,id").fetchall()
    for review in rows:
        if review['status'] != 'pending':
            continue
        current = _current(conn, review['source_id'])
        if not current or review['source_fingerprint'] == current['source_fingerprint']:
            manual[f"manual:review:{review['kind']}"] += 1
            continue
        key = current['source_fingerprint']
        peers = [r for r in rows if r['source_id'] == review['source_id']]
        items.append(ReviewItem(review['id'], review['source_id'], review['kind'],
                                _action(review, peers, key), review['source_fingerprint'], key))
    return items, manual


class _Busy(Exception):
    def __init__(self, stage):
        super().__init__(stage)
        self.stage = stage


def _lock_batch(conn, ids):
    stage = 'catalog state'
    try:
        conn.execute('SELECT 1 FROM catalog_state WHERE singleton FOR UPDATE')
        stage = 'catalog clock'
        conn.execute('SELECT 1 FROM catalog_public_clock WHERE singleton FOR NO KEY UPDATE NOWAIT')
        conn.execute('SELECT catalog_begin_correction()')
        stage = 'review'
        return {r['id']: r for r in conn.execute("""SELECT * FROM catalog_review WHERE id=ANY(%s)
          ORDER BY id FOR NO KEY UPDATE NOWAIT""", (ids,))}
    except (LockNotAvailable, DeadlockDetected) as error:
        raise _Busy(stage) from error


def apply_review_backlog(conn, items, actor_id, *, out=print):
    applied = 0
    for offset in range(0, len(items), 200):
        batch = items[offset:offset + 200]
        try:
            with conn.transaction():
                conn.execute("SET LOCAL lock_timeout='5s'")
                rows = _lock_batch(conn, [i.review_id for i in batch])
                count = 0
                for item in batch:
                    review = rows.get(item.review_id)
                    current = _current(conn, item.source_id)
                    if (not review or review['status'] != 'pending'
                            or review['source_fingerprint'] != item.source_fingerprint or not current
                            or current['source_fingerprint'] != item.current_fingerprint):
                        continue
                    peers = conn.execute('SELECT * FROM catalog_review WHERE source_id=%s', (item.source_id,)).fetchall()
                    if _action(review, peers, item.current_fingerprint) != item.action:
                        continue
                    count += _close(conn, review, item.current_fingerprint, item.action, actor_id)
                if count:
                    conn.execute('UPDATE catalog_state SET revision=revision+1 WHERE singleton')
            applied += count
        except _Busy as busy:
            out(f'review batch {offset // 200 + 1} skipped: {busy.stage} busy')
        except (LockNotAvailable, DeadlockDetected):
            out(f'review batch {offset // 200 + 1} skipped: review busy')
    return applied


def settle_backlog(owner, *, apply=False, out=print):
    # Imports stay local: the importer uses review settlement without loading owner routes.
    from .catalog import RunnerBusy
    from ..prices.metadata_settlement import plan_metadata_backlog, apply_metadata_backlog

    with connect(autocommit=True) as lock:
        if not lock.execute('SELECT pg_try_advisory_lock(914703) AS acquired').fetchone()['acquired']:
            raise RunnerBusy('Catalog runner is busy')
        held = True
        try:
            with connect() as conn:
                conn.execute('SET TRANSACTION READ ONLY')
                require_owner(conn, owner)
                reviews, manual = plan_review_backlog(conn)
                metadata, metadata_manual = plan_metadata_backlog(conn, ignored_reviews=[i.review_id for i in reviews])
                manual.update(metadata_manual)
            if not apply:
                lock.execute('SELECT pg_advisory_unlock(914703)')
                held = False
            actions = Counter(i.action for i in [*reviews, *metadata])
            for item in reviews:
                out(f'{item.kind} {item.review_id} {item.source_id} {item.action}')
            for item in metadata:
                out(f'{item.kind} {item.target_id} {item.printing_id} {item.action}')
            result = {'actions': dict(actions), 'manual': dict(manual), 'planned': len(reviews) + len(metadata),
                      'applied': 0, 'skipped': 0}
            if apply:
                with connect(autocommit=True) as conn:
                    require_owner(conn, owner)
                    closed = apply_review_backlog(conn, reviews, owner, out=out)
                    # Review closures committed above. Re-plan against their actual outcome,
                    # retaining the evidence binding of the printed plan for every dependent.
                    with conn.transaction():
                        conn.execute('SET TRANSACTION READ ONLY')
                        current_metadata, _ = plan_metadata_backlog(conn)
                    current = {(i.kind, i.target_id): i for i in current_metadata}
                    ready = [i for i in metadata if current.get((i.kind, i.target_id)) == i]
                    accepted, skipped = apply_metadata_backlog(conn, ready, owner, out=out)
                    skipped += len(metadata) - len(ready)
                result.update(applied=closed + accepted, skipped=len(reviews) - closed + skipped)
            out(str(result))
            return result
        finally:
            if held:
                lock.execute('SELECT pg_advisory_unlock(914703)')
