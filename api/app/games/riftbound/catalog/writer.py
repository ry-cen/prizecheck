"""Apply explicitly assessed Riftbound pulls to a caller-owned database connection."""
from dataclasses import dataclass
import gzip
import hashlib
import json
from typing import Optional, Sequence
from uuid import UUID, uuid4

from psycopg.errors import UniqueViolation
from psycopg.pq import TransactionStatus
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from . import plan


class RunExpired(RuntimeError):
    """The run was finished before its promotion transaction fenced it."""


class WriterBusy(RuntimeError):
    """Another catalog run holds the writer lease."""


@dataclass(frozen=True)
class RunReport:
    run_id: UUID
    promoted: bool
    generation_id: Optional[UUID]
    revision: int
    plan: plan.RunPlan


def load_previous(conn) -> plan.PreviousState:
    """Read the active catalog inside the caller's transaction."""
    with conn.cursor(row_factory=dict_row) as cur:
        snapshots = {r['group_id']: plan.snapshot_from_json(r['snapshot']) for r in cur.execute(
            'SELECT group_id,snapshot FROM riftbound_group_snapshot')}
        evidence = {r['identity_key']: r['evidence_sha256'] for r in cur.execute('''
            SELECT i.identity_key,e.evidence_sha256 FROM riftbound_identity_evidence e
            JOIN catalog_identity i ON i.id=e.identity_id''')}
        editions = {}
        for r in cur.execute('''SELECT e.printing_id,e.descriptor_key,e.descriptor
            FROM catalog_generation_edition ge JOIN catalog_edition e ON e.id=ge.edition_id
            JOIN catalog_state s ON s.active_generation=ge.generation_id
            WHERE ge.active ORDER BY e.descriptor_key'''):
            editions.setdefault(r['printing_id'], []).append(plan.EditionRow(r['descriptor_key'], r['descriptor']))
        printings = {}
        for r in cur.execute('''SELECT gp.printing_id,gp.source_id,p.source,i.identity_key,
            i.display_name AS identity_display_name,gp.set_id,gp.set_name,gp.collector_number,
            gp.display_name,gp.search_name,gp.source_fingerprint
            FROM catalog_generation_printing gp JOIN catalog_state s ON s.active_generation=gp.generation_id
            JOIN catalog_printing p ON p.id=gp.printing_id JOIN catalog_identity i ON i.id=p.identity_id'''):
            source = r.pop('source')
            r['group_id'] = int(r['set_id']) if source == 'tcgcsv' else None
            r['editions'] = tuple(editions.get(r['printing_id'], ()))
            printings[r['source_id']] = plan.ExistingPrinting(**r)
    return plan.PreviousState(snapshots, printings, evidence)


def apply_run(conn, pulls: Sequence[plan.GroupPull], *, run_id: Optional[UUID] = None) -> RunReport:
    """Plan under the catalog lock, then atomically persist and promote its content."""
    if conn.info.transaction_status != TransactionStatus.IDLE:
        raise ValueError('apply_run requires an idle connection')
    run_id = run_id or uuid4()
    try:
        with conn.transaction(), conn.cursor(row_factory=dict_row) as cur:
            cur.execute("""UPDATE catalog_run SET phase='failed',outcome='failed',
                error='Riftbound catalog run lease expired',finished_at=now()
                WHERE outcome IS NULL AND lease_until < now()""")
            cur.execute("""INSERT INTO catalog_run(id,phase,lease_until)
                VALUES (%s,'promoting',now()+interval '30 minutes')""", (run_id,))
    except UniqueViolation as exc:
        if exc.diag.constraint_name == 'catalog_one_active_run':
            raise WriterBusy('Another Riftbound catalog run is active') from exc
        raise
    try:
        with conn.transaction(), conn.cursor(row_factory=dict_row) as cur:
            state = cur.execute('SELECT active_generation,revision FROM catalog_state WHERE singleton FOR UPDATE').fetchone()
            run = cur.execute('SELECT outcome FROM catalog_run WHERE id=%s FOR UPDATE', (run_id,)).fetchone()
            if run is None or run['outcome'] is not None:
                raise RunExpired('Riftbound catalog run expired before promotion')
            previous = load_previous(conn)
            result = plan.plan_run(previous, pulls)
            if result.compared == 0:
                for review in result.reviews:
                    found = cur.execute('SELECT id FROM catalog_printing WHERE source_id=%s', (review.source_id,)).fetchone()
                    cur.execute('''INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail,candidate)
                        VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (source_id,kind,source_fingerprint) DO NOTHING''',
                                (found['id'] if found else None, review.source_id, review.kind,
                                 review.source_fingerprint, review.detail, Jsonb(review.candidate)))
                cur.execute("""UPDATE catalog_run SET phase='failed',outcome='failed',finished_at=now(),
                    error='No group pull was accepted; the previous catalog is kept' WHERE id=%s""", (run_id,))
                return RunReport(run_id, False, state['active_generation'], state['revision'], result)
            identities, printings, editions = {}, {}, {}
            for row in result.printings:
                cur.execute('''INSERT INTO catalog_identity(identity_key,display_name) VALUES (%s,%s)
                    ON CONFLICT (identity_key) DO NOTHING''', (row.identity_key, row.identity_display_name))
                identities[row.identity_key] = cur.execute('SELECT id FROM catalog_identity WHERE identity_key=%s',
                                                           (row.identity_key,)).fetchone()['id']
            for key, sha in result.evidence.items():
                cur.execute('''INSERT INTO riftbound_identity_evidence(identity_id,evidence_sha256)
                    VALUES (%s,%s) ON CONFLICT DO NOTHING''', (identities[key], sha))
            for row in result.printings:
                printing = row.printing_id
                if printing is None:
                    cur.execute("""INSERT INTO catalog_printing(source,source_id,identity_id)
                        VALUES ('tcgcsv',%s,%s) ON CONFLICT (source_id) DO NOTHING""",
                                (row.source_id, identities[row.identity_key]))
                    printing = cur.execute('SELECT id FROM catalog_printing WHERE source_id=%s', (row.source_id,)).fetchone()['id']
                printings[row.source_id] = printing
                for edition in row.editions:
                    if not isinstance(edition.descriptor, dict):
                        raise ValueError('Edition descriptor must be a JSON object')
                    if not row.carried:
                        cur.execute('''INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
                            VALUES (%s,%s,%s) ON CONFLICT (printing_id,descriptor_key) DO NOTHING''',
                                    (printing, edition.descriptor_key, Jsonb(edition.descriptor)))
                    editions[printing, edition.descriptor_key] = cur.execute('''SELECT id FROM catalog_edition
                        WHERE printing_id=%s AND descriptor_key=%s''', (printing, edition.descriptor_key)).fetchone()['id']
            promoted = state['active_generation'] is None or plan.content_digest(previous.printings.values()) != result.content_sha256
            if promoted:
                raw = gzip.compress(plan.raw_bytes({str(p.info.group_id): p.raw for p in pulls}))
                cur.execute('INSERT INTO catalog_generation(id,source_count,raw_gzip,raw_sha256) VALUES (%s,%s,%s,%s)',
                            (run_id, len(result.printings), raw, hashlib.sha256(raw).hexdigest()))
                for row in result.printings:
                    printing = printings[row.source_id]
                    cur.execute('''INSERT INTO catalog_generation_printing(generation_id,printing_id,source_id,
                        set_id,set_name,collector_number,display_name,search_name,source_fingerprint,tombstoned)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,false)''', (run_id, printing, row.source_id,
                        row.set_id, row.set_name, row.collector_number, row.display_name, row.search_name, row.source_fingerprint))
                    for edition in row.editions:
                        cur.execute('''INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id,active)
                            SELECT %s,id,printing_id,true FROM catalog_edition WHERE id=%s''',
                                    (run_id, editions[printing, edition.descriptor_key]))
                cur.execute('UPDATE catalog_state SET active_generation=%s,revision=revision+1,last_success=now() WHERE singleton', (run_id,))
                cur.execute('''DELETE FROM catalog_generation WHERE id NOT IN
                    (SELECT id FROM catalog_generation ORDER BY imported_at DESC LIMIT 2)''')
            else:
                cur.execute('UPDATE catalog_state SET last_success=now() WHERE singleton')
            for review in result.reviews:
                printing = printings.get(review.source_id)
                if printing is None:
                    found = cur.execute('SELECT id FROM catalog_printing WHERE source_id=%s', (review.source_id,)).fetchone()
                    printing = found['id'] if found else None
                cur.execute('''INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail,candidate)
                    VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (source_id,kind,source_fingerprint) DO NOTHING''',
                            (printing, review.source_id, review.kind, review.source_fingerprint, review.detail, Jsonb(review.candidate)))
            for gid, snapshot in result.snapshots.items():
                data = plan.snapshot_to_json(snapshot)
                sha = hashlib.sha256(json.dumps(data, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()
                cur.execute('''INSERT INTO riftbound_group_snapshot(group_id,snapshot,snapshot_sha256,accepted_run)
                    VALUES (%s,%s,%s,%s) ON CONFLICT (group_id) DO UPDATE SET snapshot=excluded.snapshot,
                    snapshot_sha256=excluded.snapshot_sha256,accepted_run=excluded.accepted_run,accepted_at=now()''',
                            (gid, Jsonb(data), sha, run_id))
            cur.execute("""UPDATE catalog_run SET phase='complete',outcome='succeeded',finished_at=now(),
                enumerated_count=%s,fetched_count=%s,validated_count=%s WHERE id=%s AND outcome IS NULL""",
                        (len(pulls), sum(isinstance(p.result, plan.GroupResult) for p in pulls), result.compared, run_id))
            if cur.rowcount != 1:
                raise RunExpired('Riftbound catalog run was finalized during promotion')
            return RunReport(run_id, promoted, run_id if promoted else state['active_generation'],
                             state['revision'] + int(promoted), result)
    except Exception:
        with conn.transaction(), conn.cursor(row_factory=dict_row) as cur:
            cur.execute("""UPDATE catalog_run SET phase='failed',outcome='failed',finished_at=now(),
                error='Riftbound catalog write failed; start a new pull' WHERE id=%s AND outcome IS NULL""", (run_id,))
        raise
