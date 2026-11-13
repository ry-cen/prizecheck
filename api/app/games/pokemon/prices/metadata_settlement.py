"""Owner-run release of targets whose original safety condition has cleared."""
from collections import Counter
from dataclasses import asdict, replace
from typing import NamedTuple

from psycopg.errors import DeadlockDetected, LockNotAvailable, UniqueViolation

from . import catalog_targets as targets
from .metadata_reviews import load_target
from ..catalog.settlement_audit import record_settlement


class MetadataItem(NamedTuple):
    kind: str
    target_id: object
    printing_id: object
    action: str
    evidence_digest: str
    before_state: dict


def _contested(conn, printing_id, ignored_reviews=()):
    return conn.execute("""SELECT 1 FROM catalog_review WHERE printing_id=%s AND status='pending'
      AND kind=ANY(%s) AND id<>ALL(%s::uuid[]) LIMIT 1""",
                        (printing_id, list(targets.IDENTITY_REVIEW_KINDS), list(ignored_reviews))).fetchone() is not None


def _edition(conn, context, loaded):
    row = conn.execute("""SELECT m.*,e.id,e.printing_id,e.descriptor,p.source,p.source_id,pm.source_record,
      d.set_id,d.collector_number,d.display_name FROM catalog_edition_metadata m
      JOIN catalog_edition e ON e.id=m.edition_id JOIN catalog_printing p ON p.id=e.printing_id
      LEFT JOIN catalog_printing_metadata pm ON pm.printing_id=p.id
      LEFT JOIN catalog_printing_display d ON d.printing_id=p.id WHERE e.id=%s""", (loaded['edition_id'],)).fetchone()
    current = targets.edition_state(row)
    facts = targets.edition_facts(conn, context, row)
    return current, facts, targets.verified_elsewhere(conn, row['printing_id'], row['id'])


def _edition_next(conn, context, loaded, ignored_reviews=()):
    current, facts, elsewhere = _edition(conn, context, loaded)
    if (current.state != 'quarantined' or current.reason not in ('candidate_changed', 'physical_conflict')
            or facts['correspondence'] != 'source_candidate' or context.matching is None
            or facts['fingerprint'] in loaded['rejected_fingerprints']):
        return None
    if current.reason == 'physical_conflict' and _contested(conn, loaded['printing_id'], ignored_reviews):
        return None
    if current.basis == 'matching_rule':
        return targets.default_accept_edition(current, facts, loaded['rejected_fingerprints'], context.matching, elsewhere)
    if (current.reason == 'physical_conflict' and current.basis == 'maintainer'
            and (facts['fingerprint'] == current.accepted_fingerprint
                 or targets._projection_fp(facts) == current.accepted_projection)
            and not elsewhere(current.product_id, current.quote_variant)):
        return replace(current, state='verified', reason=None)
    return None


def classify(conn, context, loaded, ignored_reviews=()):
    """Read-only policy classification; release probes happen only within apply savepoints."""
    if loaded['report_ids']:
        return None, 'manual:open_report'
    if loaded['source_fingerprint'] in loaded['rejected_fingerprints']:
        return None, 'manual:rejected_fingerprint'
    if loaded['kind'] == 'edition':
        new = _edition_next(conn, context, loaded, ignored_reviews)
        if new is not None:
            return ('default_accepted' if loaded['reason'] == 'candidate_changed' else 'released'), None
    elif loaded['state'] == 'suspended' and loaded['reason'] == 'identity_review_pending':
        row = conn.execute(targets.PRINTING_SELECT, (loaded['printing_id'],)).fetchone()
        current = targets.printing_state(row)
        export = row['export_candidate'] or {}
        if (context.live is not None and current.inputs is not None and current.decision_id is not None
                and not _contested(conn, loaded['printing_id'], ignored_reviews)
                and (targets.fingerprint(export) == current.accepted_fingerprint
                     or targets.fingerprint(context.live.rule.projection(export)) == current.accepted_projection)):
            return 'released', None
    return None, f"manual:{loaded['reason'] or loaded['state']}"


def plan_metadata_backlog(conn, ignored_reviews=()):
    items, manual = [], Counter()
    context = targets.TargetContext(conn)
    rows = conn.execute("""SELECT 'edition' AS kind,edition_id AS id FROM catalog_edition_metadata
      WHERE mapping_state='quarantined' OR mapping_reason='recovery_conflict'
      UNION ALL SELECT 'printing',printing_id FROM catalog_printing_metadata
      WHERE live_state='suspended' OR live_reason='recovery_conflict' ORDER BY kind,id""").fetchall()
    for row in rows:
        loaded = load_target(conn, row['kind'], row['id'])
        action, reason = classify(conn, context, loaded, ignored_reviews)
        if action:
            items.append(MetadataItem(row['kind'], row['id'], loaded['printing_id'], action,
                                      loaded['evidence_digest'], {'state': loaded['state'], 'reason': loaded['reason']}))
        else:
            manual[reason] += 1
    return items, manual


class _NotEligible(Exception):
    pass


def apply_metadata_backlog(conn, items, actor_id, *, out=print):
    applied, skipped, touched = 0, 0, set()
    for item in items:
        lock_stage = 'catalog clock'
        try:
            with conn.transaction():
                conn.execute("SET LOCAL lock_timeout='5s'")
                conn.execute('SELECT catalog_begin_correction()')
                lock_stage = 'target'
                targets.lock_report_target(conn, item.kind, item.target_id)
                # A fresh statement catches reports committed before the successful NOWAIT lock.
                reported = (targets.open_marketplace_report(conn, item.target_id) if item.kind == 'edition'
                            else targets.open_live_report(conn, item.target_id))
                if reported:
                    skipped += 1
                    continue
                lock_stage = 'metadata'
                loaded = load_target(conn, item.kind, item.target_id, lock=True)
                if loaded is None or loaded['evidence_digest'] != item.evidence_digest:
                    skipped += 1
                    continue
                context = targets.TargetContext(conn)
                action, _ = classify(conn, context, loaded)
                if action != item.action:
                    skipped += 1
                    continue
                try:
                    with conn.transaction():
                        if item.kind == 'edition':
                            current, _, _ = _edition(conn, context, loaded)
                            new = _edition_next(conn, context, loaded)
                            if new is None:
                                raise _NotEligible()
                            targets.write_edition_state(conn, item.target_id, current, new)
                            before, after = asdict(current), asdict(new)
                        else:
                            before = asdict(targets.printing_state(conn.execute(targets.PRINTING_SELECT, (item.target_id,)).fetchone()))
                            targets.refresh_printing(conn, context, item.target_id, reviewed=True)
                            new = targets.printing_state(conn.execute(targets.PRINTING_SELECT, (item.target_id,)).fetchone())
                            if new.state != 'eligible':
                                raise _NotEligible()
                            after = asdict(new)
                        record_settlement(conn, subject=item.kind, action=action, actor_id=actor_id,
                                          edition_id=item.target_id if item.kind == 'edition' else None,
                                          printing_id=item.printing_id, before=before, after=after)
                except (UniqueViolation, _NotEligible):
                    skipped += 1
                    continue
            applied += 1
            touched.add(item.printing_id)
        except (LockNotAvailable, DeadlockDetected):
            skipped += 1
            out(f'{item.kind} {item.target_id} {item.printing_id} skipped: {lock_stage} busy')
    if touched:
        from ..catalog.public_catalog import publish_catalog_best_effort
        from .price_binding import rebind_best_effort
        publish_catalog_best_effort(printing_ids=list(touched))
        rebind_best_effort()
    return applied, skipped
