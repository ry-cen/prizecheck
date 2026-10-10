"""Revision-guarded outbox delivery of public catalog records: ordering, races, outages and recovery."""
import os
import shutil
import threading
import time
from pathlib import Path
from uuid import uuid4

import pytest

from app import public_catalog
from app.catalog_targets import LIVE, MATCHING
from app.main import connect
from app.public_catalog import LOCK, drain, mark_all_dirty, rebuild, stored_revision
from app.public_projection import FilePublicProjection, ProjectionUnavailable, public_record_store
from app.public_records import FilePublicRecords, _clear_cache, catalog_edition_key, catalog_printing_key, quarantine_key
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_targets import activate, card, isolated_rules, metadata, run  # noqa: F401  (isolated_rules is autouse)


@pytest.fixture(autouse=True)
def stores(tmp_path, monkeypatch):
    monkeypatch.setenv('PUBLIC_PROJECTION_DIR', str(tmp_path / 'projection'))
    with FilePublicProjection().writer(initialize=True):
        pass
    public_record_store().initialize(deadline=time.monotonic() + 5)
    reset_catalog()
    with connect() as conn:
        conn.execute('DELETE FROM catalog_public_outbox')


def read(*keys):
    return public_record_store().read_records(list(keys), deadline=time.monotonic() + 5).records


def changed_product(number=1):
    record = card(number)
    record['variants_detailed'][0]['pricing']['tcgplayer']['normal']['productId'] = 999
    return record


def stage():
    """A verified, Live-eligible Printing, fully delivered. Returns (printing row, normal edition row, refs)."""
    activate(MATCHING, 1)
    activate(LIVE, 99)
    run(Records(card(1)))
    printing, editions = metadata()
    with connect() as conn:
        drain(conn)
        printing_ref = conn.execute('SELECT public_ref FROM catalog_printing WHERE id=%s', (printing['printing_id'],)).fetchone()['public_ref']
        edition_ref = conn.execute('SELECT public_ref FROM catalog_edition WHERE id=%s', (editions['normal']['id'],)).fetchone()['public_ref']
    return printing, editions['normal'], printing_ref, edition_ref


def pending(conn=None):
    with connect() as own:
        return own.execute('SELECT * FROM catalog_public_outbox WHERE delivered_at IS NULL ORDER BY sequence').fetchall()


class Writes:
    """Records every CAS the store receives, so ordering can be asserted on what was actually written."""

    def __init__(self, monkeypatch):
        self.log = []
        original = FilePublicRecords.compare_and_swap

        def recording(store, expected, changes, **kwargs):
            committed = original(store, expected, changes, **kwargs)
            if committed:
                self.log.append({key: (value['revision'] if isinstance(value, dict) else None,
                                       value.get('state') if isinstance(value, dict) else None) for key, value in changes.items()})
            return committed

        monkeypatch.setattr(FilePublicRecords, 'compare_and_swap', recording)

    def revisions(self, key):
        return [entry[key][0] for entry in self.log if key in entry]


class Stall:
    """Pause one thread right after an operation returns, until the test releases it."""

    def __init__(self, monkeypatch, owner, name):
        self.reached, self.release, self.thread, self.armed, self.skip = threading.Event(), threading.Event(), None, False, 0
        original = getattr(owner, name)

        def wrapper(*args, **kwargs):
            result = original(*args, **kwargs)
            if self.armed and threading.current_thread() is self.thread:
                if self.skip:
                    self.skip -= 1
                    return result
                self.armed = False
                self.reached.set()
                assert self.release.wait(20)
            return result

        monkeypatch.setattr(owner, name, wrapper)

    def run(self, work):
        failures = []

        def target():
            try:
                work()
            except BaseException as exc:  # Surface the error in the asserting thread.
                failures.append(exc)

        self.thread = threading.Thread(target=target)
        self.armed = True
        self.thread.start()
        assert self.reached.wait(20)
        return failures

    def finish(self, failures):
        self.release.set()
        self.thread.join(20)
        assert not self.thread.is_alive() and not failures, failures


# ------------------------------------------------------------------ delivery basics


def test_contradiction_commits_then_delivers_quarantine_as_one_atomic_pair_at_priority_zero(monkeypatch):
    printing, normal, printing_ref, edition_ref = stage()
    before = read(catalog_edition_key(edition_ref), quarantine_key(edition_ref))
    assert before[quarantine_key(edition_ref)].value['state'] == 'clear'
    writes = Writes(monkeypatch)
    run(Records(changed_product()))
    after = read(catalog_edition_key(edition_ref), quarantine_key(edition_ref))
    edition, held = after[catalog_edition_key(edition_ref)].value, after[quarantine_key(edition_ref)].value
    assert edition['marketplace'] == {'state': 'quarantined', 'reason': 'candidate_changed',
                                      'mapping_revision': held['mapping_revision'], 'product_id': None, 'quote_lookup': None}
    assert held['state'] == 'quarantined' and held['revision'] == edition['revision'] > before[quarantine_key(edition_ref)].value['revision']
    # The pair always travels in one CAS: no write ever touched one key of the pair without the other.
    assert all((catalog_edition_key(edition_ref) in entry) == (quarantine_key(edition_ref) in entry) for entry in writes.log)
    with connect() as conn:
        urgent = conn.execute("SELECT priority FROM catalog_public_outbox WHERE revision=%s AND target_kind='edition'",
                              (edition['revision'],)).fetchall()
    assert [row['priority'] for row in urgent] == [0] and not pending()


def test_priority_zero_invalidations_are_delivered_before_ordinary_work(monkeypatch):
    printing, normal, printing_ref, edition_ref = stage()
    _, editions = metadata()
    ordinary = editions['reverse']
    with connect() as conn:
        refs = {row['id']: row['public_ref'] for row in conn.execute('SELECT id,public_ref FROM catalog_edition')}
        conn.execute('DELETE FROM catalog_public_outbox')
        # The ordinary row is older (lower sequence); the invalidation arrives later but must still go first.
        conn.execute("INSERT INTO catalog_public_outbox(target_kind,target_id,revision,priority) VALUES ('edition',%s,%s,1)",
                     (ordinary['id'], ordinary['public_revision']))
        conn.execute("INSERT INTO catalog_public_outbox(target_kind,target_id,revision,priority) VALUES ('edition',%s,%s,0)",
                     (normal['id'], normal['public_revision']))
    keys = [key for ref in refs.values() for key in (catalog_edition_key(ref), quarantine_key(ref))]
    records = read(*keys)
    assert public_record_store().compare_and_swap({key: records[key].version for key in keys}, {key: None for key in keys},
                                                  deadline=time.monotonic() + 5)
    monkeypatch.setattr(public_catalog, 'CHUNK_TARGETS', 1)
    order = []
    original = FilePublicRecords.compare_and_swap

    def spy(store, expected, changes, **kwargs):
        order.append(sorted(changes))
        return original(store, expected, changes, **kwargs)

    monkeypatch.setattr(FilePublicRecords, 'compare_and_swap', spy)
    with connect() as conn:
        assert drain(conn).state == 'delivered'
    assert [catalog_edition_key(edition_ref) in keys_ for keys_ in order] == [True, False]
    assert catalog_edition_key(refs[ordinary['id']]) in order[1]


def test_a_priority_zero_printing_suspension_is_not_delayed_behind_ordinary_editions_in_the_same_chunk(monkeypatch):
    printing, normal, printing_ref, edition_ref = stage()
    _, editions = metadata()
    with connect() as conn:
        conn.execute('DELETE FROM catalog_public_outbox')
        conn.execute("INSERT INTO catalog_public_outbox(target_kind,target_id,revision,priority) VALUES ('edition',%s,%s,1)",
                     (editions['reverse']['id'], editions['reverse']['public_revision']))
        conn.execute("INSERT INTO catalog_public_outbox(target_kind,target_id,revision,priority) VALUES ('printing',%s,%s,0)",
                     (printing['printing_id'], printing['public_revision']))
        refs = [row['public_ref'] for row in conn.execute('SELECT public_ref FROM catalog_edition')]
    keys = [catalog_printing_key(printing_ref)] + [key for ref in refs for key in (catalog_edition_key(ref), quarantine_key(ref))]
    records = read(*keys)
    assert public_record_store().compare_and_swap({key: records[key].version for key in keys}, {key: None for key in keys},
                                                  deadline=time.monotonic() + 5)
    order = []
    original = FilePublicRecords.compare_and_swap

    def spy(store, expected, changes, **kwargs):
        order.append(sorted(changes))
        return original(store, expected, changes, **kwargs)

    monkeypatch.setattr(FilePublicRecords, 'compare_and_swap', spy)
    with connect() as conn:
        assert drain(conn).state == 'delivered'
    assert catalog_printing_key(printing_ref) in order[0] and len(order) == 2


def test_a_lost_cas_is_retried_from_a_fresh_build(monkeypatch):
    stage()
    run(Records(changed_product()))
    with connect() as conn:
        conn.execute('UPDATE catalog_public_outbox SET delivered_at=NULL')
    refused = []
    original = FilePublicRecords.compare_and_swap

    def lose_once(store, expected, changes, **kwargs):
        if not refused:
            refused.append(changes)
            return False
        return original(store, expected, changes, **kwargs)

    with connect() as conn:  # Make the store stale so a write is needed.
        refs = [row['public_ref'] for row in conn.execute('SELECT public_ref FROM catalog_edition').fetchall()]
    stale = [key for ref in refs for key in (catalog_edition_key(ref), quarantine_key(ref))]
    records = read(*stale)
    assert public_record_store().compare_and_swap({key: records[key].version for key in stale}, {key: None for key in stale},
                                                  deadline=time.monotonic() + 5)
    monkeypatch.setattr(FilePublicRecords, 'compare_and_swap', lose_once)
    with connect() as conn:
        assert drain(conn).state == 'delivered'
    assert len(refused) == 1 and not pending()


def test_an_outbox_row_newer_than_postgres_is_never_marked_delivered_or_spun_on():
    printing, normal, printing_ref, edition_ref = stage()
    with connect() as conn:
        conn.execute("INSERT INTO catalog_public_outbox(target_kind,target_id,revision) VALUES ('edition',%s,%s)",
                     (normal['id'], normal['public_revision'] + 10))
        conn.commit()
        drain(conn)
    [left] = pending()
    assert left['revision'] == normal['public_revision'] + 10 and left['last_error'] == 'RevisionBehind'


def test_replay_writes_nothing_and_only_remarks_rows_delivered(monkeypatch):
    stage()
    with connect() as conn:
        conn.execute('UPDATE catalog_public_outbox SET delivered_at=NULL')
    writes = Writes(monkeypatch)
    with connect() as conn:
        result = drain(conn)
    assert writes.log == [] and result.written == 0 and result.unchanged > 0 and result.state == 'delivered'
    assert not pending()


def test_projection_unavailable_leaves_postgres_committed_and_the_row_pending_until_a_later_drain(monkeypatch):
    printing, normal, printing_ref, edition_ref = stage()
    original = FilePublicRecords.compare_and_swap

    def down(*args, **kwargs):
        raise ProjectionUnavailable()

    monkeypatch.setattr(FilePublicRecords, 'compare_and_swap', down)
    run(Records(changed_product()))
    _, rows = metadata()
    assert rows['normal']['mapping_state'] == 'quarantined'  # PostgreSQL committed regardless
    left = pending()
    assert left and {row['last_error'] for row in left} == {'ProjectionUnavailable'} and all(row['attempts'] >= 1 for row in left)
    assert read(quarantine_key(edition_ref))[quarantine_key(edition_ref)].value['state'] == 'clear'  # old value stays visible
    with connect() as conn:
        count, oldest = public_catalog.pending_status(conn)
    assert count == len(left) and oldest is not None and oldest >= 0
    monkeypatch.setattr(FilePublicRecords, 'compare_and_swap', original)
    with connect() as conn:
        assert drain(conn).state == 'delivered'
    assert read(quarantine_key(edition_ref))[quarantine_key(edition_ref)].value['state'] == 'quarantined' and not pending()


def test_unavailable_store_on_read_also_leaves_rows_pending(monkeypatch):
    stage()
    monkeypatch.setattr(FilePublicRecords, 'read_records', lambda *args, **kwargs: (_ for _ in ()).throw(ProjectionUnavailable()))
    run(Records(changed_product()))
    assert pending() and {row['last_error'] for row in pending()} == {'ProjectionUnavailable'}


def test_orphaned_rows_from_a_truncated_catalog_are_cleaned_without_writes(monkeypatch):
    stage()
    with connect() as conn:
        conn.execute('UPDATE catalog_public_outbox SET delivered_at=NULL')
        conn.execute("INSERT INTO catalog_public_outbox(target_kind,target_id,revision) VALUES ('edition',%s,5),('printing',%s,5)",
                     (uuid4(), uuid4()))
    reset_catalog()
    writes = Writes(monkeypatch)
    with connect() as conn:
        result = drain(conn)
    assert writes.log == [] and result.state == 'delivered' and not pending()
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_public_outbox WHERE last_error='TargetMissing'").fetchone()['n'] >= 2


def test_store_ahead_and_same_revision_mismatch_are_reported_not_overwritten(monkeypatch):
    printing, normal, printing_ref, edition_ref = stage()
    key, held = catalog_edition_key(edition_ref), quarantine_key(edition_ref)
    records = read(key, held)
    ahead = {**records[key].value, 'revision': records[key].value['revision'] + 50}
    assert public_record_store().compare_and_swap({key: records[key].version}, {key: ahead}, deadline=time.monotonic() + 5)
    with connect() as conn:
        conn.execute("UPDATE catalog_public_outbox SET delivered_at=NULL WHERE target_kind='edition'")
    writes = Writes(monkeypatch)
    with connect() as conn:
        result = drain(conn)
    assert writes.log == [] and result.state == 'pending'
    assert {row['last_error'] for row in pending() if row['target_id'] == normal['id']} == {'StoreAhead'}
    # Same revision, different content: a restore collision that is never silently overwritten either.
    other = {**records[key].value, 'marketplace': {**records[key].value['marketplace'], 'product_id': 4242}}
    current = read(key)[key]
    assert public_record_store().compare_and_swap({key: current.version}, {key: other}, deadline=time.monotonic() + 5)
    mark = len(writes.log)
    with connect() as conn:
        conn.execute("UPDATE catalog_public_outbox SET delivered_at=NULL,last_error=NULL WHERE target_kind='edition'")
        conn.commit()
        drain(conn)
    assert {row['last_error'] for row in pending() if row['target_id'] == normal['id']} == {'RevisionValueMismatch'}
    assert read(key)[key].value == other and writes.log[mark:] == []


def test_busy_lock_reports_pending_and_budget_exhaustion_stops_without_writes(monkeypatch):
    stage()
    run(Records(changed_product()))
    with connect() as conn:
        conn.execute('UPDATE catalog_public_outbox SET delivered_at=NULL')
    writes = Writes(monkeypatch)
    with connect() as holder:
        holder.execute('SELECT pg_advisory_lock(%s)', (LOCK,))
        with connect() as conn:
            busy = drain(conn)
        holder.execute('SELECT pg_advisory_unlock(%s)', (LOCK,))
    assert busy.busy and busy.state == 'pending' and busy.pending > 0 and writes.log == []
    with connect() as conn:
        assert drain(conn, budget=0).state == 'pending'
        assert drain(conn).state == 'delivered'  # the lock was released, so the next drain proceeds


def test_no_postgres_lock_or_open_transaction_is_held_during_store_io(monkeypatch):
    stage()
    run(Records(changed_product()))
    with connect() as conn:
        conn.execute('UPDATE catalog_public_outbox SET delivered_at=NULL')
        conn.execute("UPDATE catalog_edition_metadata SET product_id=product_id WHERE false")
    observed = []
    original = FilePublicRecords.read_all

    def inspect(store, *args, **kwargs):
        with connect() as other:
            states = other.execute("""SELECT state FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database()
              AND query LIKE '%%catalog_public_outbox%%' AND state LIKE 'idle%%'""").fetchall()
            observed.append([row['state'] for row in states])
            for table in ('catalog_public_clock', 'catalog_public_outbox'):
                other.execute(f'SELECT 1 FROM {table} FOR UPDATE NOWAIT').fetchall()  # would raise if a drainer held the row
            other.rollback()
        return original(store, *args, **kwargs)

    monkeypatch.setattr(FilePublicRecords, 'read_all', inspect)
    with connect() as conn:
        assert drain(conn).state == 'delivered'
    assert observed and all('idle in transaction' not in states for states in observed)


# ------------------------------------------------------------------ races (AC6)


@pytest.mark.parametrize('point', [('build', public_catalog, 'build_values'), ('read', FilePublicRecords, 'read_all')])
def test_stalled_drainer_cannot_overwrite_a_newer_invalidation(monkeypatch, point):
    _, owner, name = point
    printing, normal, printing_ref, edition_ref = stage()
    key, held = catalog_edition_key(edition_ref), quarantine_key(edition_ref)
    # Revision N: a still-verified correction that the stalled drainer will try to deliver.
    with connect() as conn:
        conn.execute('UPDATE catalog_edition_metadata SET product_id=2000 WHERE edition_id=%s', (normal['id'],))
        n = conn.execute('SELECT public_revision FROM catalog_edition_metadata WHERE edition_id=%s', (normal['id'],)).fetchone()['public_revision']
    writes = Writes(monkeypatch)
    stall = Stall(monkeypatch, owner, name)
    outcome = []

    def stalled_drainer():
        with connect() as conn:
            outcome.append(drain(conn))

    failures = stall.run(stalled_drainer)
    # While it is stalled: N+1 (quarantine) commits and a second, lock-free drainer delivers it.
    run(Records(changed_product()))
    with connect() as other:
        public_catalog._drain_locked(other, public_record_store(), None)
    delivered = read(key, held)
    assert delivered[held].value['state'] == 'quarantined' and delivered[key].value['revision'] > n
    stall.finish(failures)
    final = read(key, held)
    assert final[held].value['state'] == 'quarantined' and final[key].value['marketplace']['state'] == 'quarantined'
    # No lower revision was ever written after a higher one.
    for written in (writes.revisions(key), writes.revisions(held)):
        assert written == sorted(written) and len(written) == len(set(written))
    assert not pending()


@pytest.mark.parametrize('point', [('build', public_catalog, 'build_values'), ('read', FilePublicRecords, 'read_all')])
def test_backfill_cannot_write_stale_verified_state_over_a_delivered_contradiction(monkeypatch, point):
    """The ticket-04 interleaving: backfill reads verified, a contradiction commits and is delivered, backfill writes."""
    _, owner, name = point
    printing, normal, printing_ref, edition_ref = stage()
    key, held = catalog_edition_key(edition_ref), quarantine_key(edition_ref)
    writes = Writes(monkeypatch)
    stall = Stall(monkeypatch, owner, name)
    original = public_catalog.mark_all_dirty

    def after_dirty(conn):
        original(conn)
        stall.armed = threading.current_thread() is stall.thread  # only the delivery phase may stall

    monkeypatch.setattr(public_catalog, 'mark_all_dirty', after_dirty)
    stall.armed = False
    failures = []

    def backfill():
        with connect() as conn:
            rebuild(conn)

    stall.thread = threading.Thread(target=lambda: failures.extend(_guard(backfill)))
    stall.thread.start()
    assert stall.reached.wait(20)
    run(Records(changed_product()))
    with connect() as other:
        public_catalog._drain_locked(other, public_record_store(), None)
    assert read(held)[held].value['state'] == 'quarantined'
    stall.finish(failures)
    assert read(held)[held].value['state'] == 'quarantined' and read(key)[key].value['marketplace']['state'] == 'quarantined'
    states = [entry[held][1] for entry in writes.log if held in entry]
    assert states and states[-1] == 'quarantined' and 'clear' not in states[states.index('quarantined'):]


def _guard(work):
    try:
        work()
    except BaseException as exc:
        return [exc]
    return []


def test_commit_order_not_allocation_order_decides_delivery(monkeypatch):
    stage()
    run(Records(card(1), card(2)))
    with connect() as conn:
        conn.execute('UPDATE catalog_public_outbox SET delivered_at=now()')
        ids = [row['id'] for row in conn.execute("""SELECT e.id FROM catalog_edition e JOIN catalog_edition_metadata m ON m.edition_id=e.id
          WHERE m.mapping_state='verified' ORDER BY e.id""").fetchall()]
        conn.commit()
    first, second = ids[0], ids[-1]
    writes = Writes(monkeypatch)
    with connect() as holder:
        holder.execute("UPDATE catalog_edition_metadata SET product_id=product_id+1000 WHERE edition_id=%s", (first,))
        done = threading.Event()
        errors = []

        def other():
            errors.extend(_guard(lambda: _bump(second)))
            done.set()

        thread = threading.Thread(target=other)
        thread.start()
        assert not done.wait(0.5)  # blocked behind the uncommitted clock holder
        with connect() as conn:  # an uncommitted correction is invisible to delivery
            assert drain(conn).state == 'delivered' and writes.log == []
        holder.commit()
        thread.join(20)
        assert done.is_set() and not errors
    with connect() as conn:
        revisions = {row['edition_id']: row['public_revision'] for row in conn.execute(
            'SELECT edition_id,public_revision FROM catalog_edition_metadata WHERE edition_id=ANY(%s)', ([first, second],))}
        assert revisions[first] < revisions[second]
        conn.commit()
        assert drain(conn).state == 'delivered'
    assert writes.log and all(revision for entry in writes.log for revision, _ in entry.values())


def _bump(edition_id):
    with connect() as conn:
        conn.execute('UPDATE catalog_edition_metadata SET product_id=product_id+1000 WHERE edition_id=%s', (edition_id,))


# ------------------------------------------------------------------ recovery (R1-R3)


def snapshot_values():
    with connect() as conn:
        refs = [row['public_ref'] for row in conn.execute('SELECT public_ref FROM catalog_edition').fetchall()]
        prefs = [row['public_ref'] for row in conn.execute('SELECT public_ref FROM catalog_printing').fetchall()]
    keys = [catalog_printing_key(ref) for ref in prefs] + [key for ref in refs for key in (catalog_edition_key(ref), quarantine_key(ref))]
    return {key: record.value for key, record in public_record_store().read_all(keys, deadline=time.monotonic() + 5).records.items()}


def test_r1_a_reinitialized_empty_store_is_rebuilt_from_postgres(tmp_path, monkeypatch):
    stage()
    run(Records(changed_product()))
    expected = snapshot_values()
    monkeypatch.setenv('PUBLIC_PROJECTION_DIR', str(tmp_path / 'fresh'))
    with FilePublicProjection().writer(initialize=True):
        pass
    public_record_store().initialize(deadline=time.monotonic() + 5)
    assert all(value is None for value in snapshot_values().values())
    with connect() as conn:
        result = rebuild(conn)
    assert result.written == len(expected) - sum(1 for key in expected if key.startswith('quarantine:'))
    assert snapshot_values() == expected


def test_r2_a_store_restored_from_an_older_copy_is_overwritten_by_newer_revisions(tmp_path):
    stage()
    records_dir = Path(FilePublicProjection().directory) / 'records'
    older = tmp_path / 'older-copy'
    shutil.copytree(records_dir, older)
    older_values = snapshot_values()
    run(Records(changed_product()))
    newest = snapshot_values()
    assert newest != older_values
    shutil.rmtree(records_dir)
    shutil.copytree(older, records_dir)
    _clear_cache()
    assert snapshot_values() == older_values
    with connect() as conn:
        result = rebuild(conn)
    assert result.conflicts == 0 and snapshot_values() == newest


def test_r3_postgres_older_than_the_store_marks_recovery_conflicts_above_the_store_maximum():
    printing, normal, printing_ref, edition_ref = stage()
    key, held, pkey = catalog_edition_key(edition_ref), quarantine_key(edition_ref), catalog_printing_key(printing_ref)
    records = read(key, held, pkey)
    edition_before = records[key].value
    high = edition_before['revision'] + 1000
    foreign_edition = {**edition_before, 'revision': high, 'marketplace': {**edition_before['marketplace'], 'state': 'unverified',
                       'mapping_revision': 77, 'product_id': None, 'quote_lookup': None, 'reason': 'rule_failed'}}
    foreign_hold = {**records[held].value, 'revision': high, 'mapping_revision': 77}
    foreign_printing = {**records[pkey].value, 'revision': high + 5}
    assert public_record_store().compare_and_swap(
        {key: records[key].version, held: records[held].version, pkey: records[pkey].version},
        {key: foreign_edition, held: foreign_hold, pkey: foreign_printing}, deadline=time.monotonic() + 5)
    with connect() as conn:
        clock_before = conn.execute('SELECT revision FROM catalog_public_clock').fetchone()['revision']
        assert clock_before < high
        result = rebuild(conn)
        clock = conn.execute('SELECT revision FROM catalog_public_clock').fetchone()['revision']
        market = conn.execute('SELECT * FROM catalog_edition_metadata WHERE edition_id=%s', (normal['id'],)).fetchone()
        live = conn.execute('SELECT * FROM catalog_printing_metadata WHERE printing_id=%s', (printing['printing_id'],)).fetchone()
    assert result.store_max == high + 5 and result.conflicts >= 2 and clock > result.store_max
    assert (market['mapping_state'], market['mapping_reason'], market['auto_closed']) == ('quarantined', 'recovery_conflict', True)
    assert (live['live_state'], live['live_reason'], live['live_identity']) == ('suspended', 'recovery_conflict', None)
    assert market['public_revision'] > result.store_max and live['public_revision'] > result.store_max
    records = read(key, held, pkey)
    assert records[held].value == {'edition_ref': edition_ref, 'revision': market['public_revision'],
                                   'mapping_revision': market['mapping_revision'], 'state': 'quarantined'}
    assert records[key].value['marketplace']['reason'] == 'recovery_conflict' and records[key].value['revision'] == market['public_revision']
    assert records[pkey].value['live'] == {'state': 'suspended', 'reason': 'recovery_conflict', 'rule_version': 99, 'identity': None}
    # The clock is past the store, so later corrections are delivered rather than parked as StoreAhead.
    run(Records(changed_product(), card(2)))
    assert not pending() and read(held)[held].value['revision'] >= market['public_revision']
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_public_outbox WHERE last_error='StoreAhead'").fetchone()['n'] == 0


def test_a_correction_delivered_while_the_rebuild_scans_is_not_mistaken_for_a_recovery_conflict(monkeypatch):
    """The scan builds from PostgreSQL then reads the store without the drain lock; live delivery in that gap is not R3."""
    printing, normal, printing_ref, edition_ref = stage()
    stall = Stall(monkeypatch, public_catalog, 'build_values')
    stall.skip = 1  # Let the Printing page through; stall after the Edition page is built, before it is compared.
    outcome = []
    failures = stall.run(lambda: outcome.append(rebuild(connect())))
    run(Records(changed_product()))  # commits the contradiction and delivers it, as the API does after a commit
    assert read(quarantine_key(edition_ref))[quarantine_key(edition_ref)].value['state'] == 'quarantined'
    stall.finish(failures)
    assert outcome[0].conflicts == 0
    _, rows = metadata()
    assert (rows['normal']['mapping_state'], rows['normal']['mapping_reason']) == ('quarantined', 'candidate_changed')
    assert read(catalog_edition_key(edition_ref))[catalog_edition_key(edition_ref)].value['marketplace']['reason'] == 'candidate_changed'
    assert not pending()


def test_rebuild_clock_reconciliation_needs_no_stamp_or_clock_lock_when_the_store_is_not_ahead():
    stage()
    with connect() as holder:  # An in-flight correction holds the clock; a rebuild with nothing to reconcile must not wait on it.
        holder.execute('SELECT catalog_begin_correction()')
        with connect() as conn:
            conn.execute("SET lock_timeout='1s'")
            rebuild(conn)
        holder.rollback()
    with connect() as conn:
        before = conn.execute('SELECT revision FROM catalog_public_clock').fetchone()['revision']
        rebuild(conn)
        assert conn.execute('SELECT revision FROM catalog_public_clock').fetchone()['revision'] == before


def test_rebuild_waits_for_a_concurrent_drainer_instead_of_failing(monkeypatch):
    stage()
    monkeypatch.setattr(public_catalog, 'LOCK_WAIT_SECONDS', 0.05)
    holder = connect()
    holder.execute('SELECT pg_advisory_lock(%s)', (LOCK,))
    holder.commit()
    threading.Timer(0.4, lambda: (holder.execute('SELECT pg_advisory_unlock(%s)', (LOCK,)), holder.commit(), holder.close())).start()
    with connect() as conn:
        assert rebuild(conn).unchanged > 0


def test_rebuild_of_an_empty_catalog_still_refuses_an_uninitialized_store(tmp_path, monkeypatch):
    monkeypatch.setenv('PUBLIC_PROJECTION_DIR', str(tmp_path / 'never'))
    with connect() as conn, pytest.raises(ProjectionUnavailable):
        rebuild(conn)
    assert not (tmp_path / 'never').exists()


def test_rebuild_succeeds_despite_unrelated_stuck_rows_and_work_enqueued_after_it_started():
    printing, normal, printing_ref, edition_ref = stage()
    with connect() as conn:
        conn.execute("INSERT INTO catalog_public_outbox(target_kind,target_id,revision) VALUES ('edition',%s,%s)",
                     (normal['id'], normal['public_revision'] + 10))
        conn.commit()
        drain(conn)  # leaves the future row stuck as RevisionBehind
        assert rebuild(conn).conflicts == 0


def test_rebuild_refuses_an_uninitialized_store_and_reports_unavailable(tmp_path, monkeypatch):
    stage()
    monkeypatch.setenv('PUBLIC_PROJECTION_DIR', str(tmp_path / 'never'))
    with connect() as conn, pytest.raises(ProjectionUnavailable):
        rebuild(conn)
    assert not (tmp_path / 'never').exists()


# ------------------------------------------------------------------ shim, display, readers of the enqueue contract


def test_reimport_with_changed_source_display_leaves_public_values_and_the_outbox_untouched():
    """Display belongs to the immutable Printing (016): a source image or set-name change moves no public display field."""
    printing, normal, printing_ref, edition_ref = stage()
    pkey = catalog_printing_key(printing_ref)
    before = read(pkey)[pkey]
    changed = card(1)
    changed.update({'image': 'https://assets.tcgdex.net/en/other/meta-1'})
    changed['set'] = {**changed.get('set', {}), 'name': 'Renamed Set'}
    run(Records(changed))
    after = read(pkey)[pkey]
    with connect() as conn:  # The import really recorded the new source display in its generation row.
        latest = conn.execute("""SELECT gp.image_url,gp.set_name FROM catalog_generation_printing gp
          JOIN catalog_generation g ON g.id=gp.generation_id WHERE gp.printing_id=%s ORDER BY g.imported_at DESC LIMIT 1""",
                              (printing['printing_id'],)).fetchone()
    assert latest['set_name'] == 'Renamed Set' and latest['image_url'] == 'https://assets.tcgdex.net/en/other/meta-1'
    display = ('printing_ref', 'name', 'set_id', 'set_name', 'collector_number', 'image_url')
    assert {k: after.value[k] for k in display} == {k: before.value[k] for k in display}  # display is write-once (016)
    with connect() as conn:
        drain(conn)
    assert not pending()
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_public_outbox WHERE last_error IN ('RevisionValueMismatch','StoreAhead')").fetchone()['n'] == 0
    assert stored_revision(after.value) >= stored_revision(before.value)


# ------------------------------------------------------------------ drain commits, so it refuses an open transaction


def test_drain_refuses_a_connection_with_an_open_transaction_and_loses_nothing():
    stage()
    run(Records(changed_product()))
    owner = f'drain-misuse-{uuid4()}'
    with connect() as conn:
        conn.execute('UPDATE catalog_public_outbox SET delivered_at=NULL')
        conn.commit()
        with pytest.raises(public_catalog.DrainMisuse):
            with conn.transaction():
                drain(conn)  # Rolling back here would silently discard the caller's transaction.
    assert pending()  # Nothing was published
    with connect() as conn:
        conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s)', (owner,))  # implicit transaction, uncommitted
        with pytest.raises(public_catalog.DrainMisuse):
            drain(conn)
        with pytest.raises(public_catalog.DrainMisuse):
            public_catalog.publish_catalog_best_effort(conn)  # The shim never hides a programming error
        conn.commit()
    with connect() as conn:
        assert conn.execute('SELECT 1 FROM inventory_owner WHERE user_id=%s', (owner,)).fetchone()  # the caller's write survived
        conn.commit()
        assert drain(conn).state == 'delivered'  # and an idle connection still drains


def plant_foreign_timeline(edition_ref, mapping_revision, *, revision_gap=1000):
    """Make the store hold Edition state from a lost timeline: a higher mapping revision with its quote already written."""
    from app.public_records import quote_key, result_key
    key, held = catalog_edition_key(edition_ref), quarantine_key(edition_ref)
    records = read(key, held)
    value = records[key].value
    high = value['revision'] + revision_gap
    foreign = {**value, 'revision': high, 'marketplace': {**value['marketplace'], 'mapping_revision': mapping_revision}}
    foreign_hold = {**records[held].value, 'revision': high, 'mapping_revision': mapping_revision}
    quote, result = quote_key(edition_ref, mapping_revision), result_key(edition_ref, mapping_revision)
    store = public_record_store()
    versions = {name: record.version for name, record in read(key, held, quote, result).items()}
    assert store.compare_and_swap(versions, {key: foreign, held: foreign_hold, quote: {'attempt': 1, 'amount': '9.99'},
                                             result: {'state': 'quote', 'attempt': 1}}, deadline=time.monotonic() + 5)
    return mapping_revision


def test_r3_never_reuses_a_mapping_revision_the_lost_timeline_already_wrote_quotes_under():
    from app.public_catalog import marketplace_states
    printing, normal, printing_ref, edition_ref = stage()
    with connect() as conn:
        before = conn.execute('SELECT mapping_revision FROM catalog_edition_metadata WHERE edition_id=%s', (normal['id'],)).fetchone()['mapping_revision']
    stored = plant_foreign_timeline(edition_ref, before + 4)
    with connect() as conn:
        assert rebuild(conn).conflicts >= 1
        after = conn.execute('SELECT mapping_revision,mapping_state FROM catalog_edition_metadata WHERE edition_id=%s', (normal['id'],)).fetchone()
    assert after['mapping_state'] == 'quarantined'
    assert after['mapping_revision'] > stored  # not before+1, which a later verify would walk up to the planted quote
    states = marketplace_states(public_record_store(), [edition_ref], time.monotonic() + 5)
    assert states[edition_ref].state == 'quarantined' and states[edition_ref].quote is None
    # The same holds for an Edition that was already quarantined when the recovery conflict was found.
    again = plant_foreign_timeline(edition_ref, after['mapping_revision'] + 6)
    with connect() as conn:
        assert rebuild(conn).conflicts >= 1
        assert conn.execute('SELECT mapping_revision FROM catalog_edition_metadata WHERE edition_id=%s', (normal['id'],)).fetchone()['mapping_revision'] > again


# ------------------------------------------------------------------ a request delivers its own targets first; rebuild reports a busy drainer


def test_a_request_drain_delivers_the_callers_own_targets_before_an_unrelated_backlog(monkeypatch):
    activate(MATCHING, 1)
    activate(LIVE, 99)
    run(Records(card(1), card(2), card(3), card(4)))
    with connect() as conn:
        drain(conn)
    monkeypatch.setattr('app.catalog.publish_catalog_best_effort', lambda *args, **kwargs: True)  # an import with a backlog
    run(Records(card(1), changed_product(2), changed_product(3), changed_product(4)))  # older, unrelated invalidations
    run(Records(changed_product(1), changed_product(2), changed_product(3), changed_product(4)))  # then the caller's own
    mine, rows = metadata('meta-1')
    with connect() as conn:
        ref = conn.execute('SELECT public_ref FROM catalog_edition WHERE id=%s', (rows['normal']['id'],)).fetchone()['public_ref']
    key = quarantine_key(ref)
    assert len(pending()) >= 4 and read(key)[key].value['state'] == 'clear'
    original = FilePublicRecords.compare_and_swap

    def slow(store, *args, **kwargs):
        time.sleep(0.4)
        return original(store, *args, **kwargs)

    monkeypatch.setattr(FilePublicRecords, 'compare_and_swap', slow)
    monkeypatch.setattr(public_catalog, 'CHUNK_TARGETS', 1)
    with connect() as conn:
        result = drain(conn, budget=0.7, printing_ids=[mine['printing_id']])
    assert read(key)[key].value['state'] == 'quarantined'  # delivered inside the short budget
    assert result.state == 'pending' and result.pending >= 1  # the unrelated backlog is left for later drains
    # Without a hint the same budget is spent in (priority, sequence) order and the caller waits behind older rows.
    monkeypatch.setattr(FilePublicRecords, 'compare_and_swap', original)
    with connect() as conn:
        assert drain(conn).state == 'delivered'


def test_best_effort_shim_resolves_printing_ids_never_hides_delivery_failure_and_reports_delivery(monkeypatch):
    printing, normal, printing_ref, edition_ref = stage()
    assert public_catalog.publish_catalog_best_effort(printing_ids=[uuid4()]) is True  # an unknown hint costs nothing
    monkeypatch.setattr(FilePublicRecords, 'read_all', lambda *args, **kwargs: (_ for _ in ()).throw(ProjectionUnavailable()))
    run(Records(changed_product()))
    assert public_catalog.publish_catalog_best_effort(printing_ids=[printing['printing_id']]) is False
    assert not hasattr(public_catalog, 'publish_catalog') and not hasattr(public_catalog, '_sync')


def test_rebuild_reports_a_busy_drainer_distinctly_and_the_script_exits_with_its_own_code(monkeypatch, capsys):
    import importlib.util
    stage()
    monkeypatch.setattr(public_catalog, 'LOCK_WAITS', 2)
    monkeypatch.setattr(public_catalog, 'LOCK_WAIT_SECONDS', 0.01)
    holder = connect()
    holder.execute('SELECT pg_advisory_lock(%s)', (LOCK,))
    holder.commit()
    try:
        with connect() as conn, pytest.raises(public_catalog.RebuildBusy) as busy:
            rebuild(conn)
        assert isinstance(busy.value, ProjectionUnavailable)  # existing callers keep treating it as unavailable
        path = Path(__file__).resolve().parents[2] / 'scripts/backfill_public_catalog.py'
        spec = importlib.util.spec_from_file_location('backfill_script', path)
        script = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(script)
        assert script.main() == 3
        message = capsys.readouterr().err
        assert 'another drain is running' in message.lower() and 'retry' in message.lower()
    finally:
        holder.execute('SELECT pg_advisory_unlock(%s)', (LOCK,))
        holder.commit()
        holder.close()


# ------------------------------------------------------------------ the outbox is per database; a swapped store is noticed by the next drain


def test_a_drain_notices_a_store_restored_older_than_the_outbox_and_republishes_without_a_rebuild(tmp_path):
    stage()
    records_dir = Path(FilePublicProjection().directory) / 'records'
    older = tmp_path / 'older-copy'
    shutil.copytree(records_dir, older)
    older_values = snapshot_values()
    run(Records(changed_product()))
    newest = snapshot_values()
    assert newest != older_values and not pending()  # everything is delivered as far as PostgreSQL knows
    shutil.rmtree(records_dir)
    shutil.copytree(older, records_dir)
    _clear_cache()
    assert snapshot_values() == older_values  # stale clears are visible again
    with connect() as conn:
        result = drain(conn)
    assert result.state == 'delivered' and result.written > 0
    assert snapshot_values() == newest


def test_a_drain_republishes_into_a_wiped_store_and_leaves_a_current_store_alone(tmp_path, monkeypatch):
    stage()
    expected = snapshot_values()
    writes = Writes(monkeypatch)
    with connect() as conn:
        assert drain(conn).written == 0  # nothing to do for a store that is current
    assert writes.log == []
    monkeypatch.setenv('PUBLIC_PROJECTION_DIR', str(tmp_path / 'fresh'))
    with FilePublicProjection().writer(initialize=True):
        pass
    public_record_store().initialize(deadline=time.monotonic() + 5)
    assert all(value is None for value in snapshot_values().values())
    with connect() as conn:
        assert drain(conn).state == 'delivered'
    assert snapshot_values() == expected


# ------------------------------------------------------------------ rule activation delivers its backlog from a detached drain


def test_spawn_background_drain_starts_a_detached_unbounded_drain_and_never_raises(monkeypatch):
    started = []

    class Child:
        pass

    monkeypatch.setattr(public_catalog.subprocess, 'Popen', lambda *args, **kwargs: started.append((args, kwargs)) or Child())
    assert public_catalog.spawn_background_drain() is True
    [(args, kwargs)] = started
    assert args[0][1:] == ['-m', 'app.catalog_import', '--drain']
    assert kwargs['start_new_session'] is True and kwargs['close_fds'] is True
    assert kwargs['stdin'] == kwargs['stdout'] == kwargs['stderr'] == public_catalog.subprocess.DEVNULL
    monkeypatch.setattr(public_catalog.subprocess, 'Popen', lambda *args, **kwargs: (_ for _ in ()).throw(OSError('no fork')))
    assert public_catalog.spawn_background_drain() is False


@pytest.mark.slow(reason='process: runs the detached drain entry point')
def test_the_detached_drain_entry_delivers_everything_pending_and_reports_the_result(tmp_path):
    import subprocess
    import sys
    stage()
    run(Records(changed_product()))
    with connect() as conn:
        conn.execute('UPDATE catalog_public_outbox SET delivered_at=NULL')
        conn.commit()
    assert pending()
    api = Path(__file__).resolve().parents[1]
    done = subprocess.run([sys.executable, '-m', 'app.catalog_import', '--drain'], cwd=api, env=os.environ.copy(),
                          capture_output=True, text=True, timeout=60)
    assert done.returncode == 0 and done.stdout == '' and 'Traceback' not in done.stderr
    assert not pending()
    refused = subprocess.run([sys.executable, '-m', 'app.catalog_import'], cwd=api, env=os.environ.copy(), capture_output=True, timeout=60)
    assert refused.returncode == 2  # neither --run-id nor --drain is a usage error, never a silent no-op
    from app import catalog_import
    assert catalog_import.main(['--drain']) == 0
