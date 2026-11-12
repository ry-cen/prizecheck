"""Automatic review transitions preserve owner decisions and current conflicts."""
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from psycopg.errors import LockNotAvailable
from fastapi import HTTPException

from app.main import connect
from app.games.pokemon.catalog import review_settlement
from app.games.pokemon.catalog.catalog import RunnerBusy
from app.games.pokemon.catalog.review_settlement import settle_backlog, plan_review_backlog, apply_review_backlog
from test_catalog import reset_catalog
from test_catalog_metadata import Records, furret, renamed, owner, reviews, correspondences, decide_pending
from test_catalog_reconciliation import run, seed_manual
from test_holdings import call
from test_metadata_settlement import wait_for_block


def audit():
    with connect() as conn:
        return conn.execute('SELECT * FROM catalog_auto_settlement ORDER BY created_at,id').fetchall()


def drift():
    reset_catalog()
    run(Records(furret()))
    run(Records(renamed()))


def test_reverted_name_closes_pending_review_as_stale():
    drift()
    run(Records(furret()))
    [review] = reviews()
    assert review['status'] == 'stale' and review['reviewer_id'] is None
    assert review['reviewed_at'] is not None and review['evidence_url'] is None
    assert [(a['action'], a['trigger']) for a in audit()] == [('stale', 'automatic')]
    assert set(correspondences().values()) == {'source_candidate'}
    assert call('GET', '/api/admin/catalog-reviews', owner()).json() == []


def test_second_rename_supersedes_older_pending_review():
    drift()
    run(Records(furret(name='Furret Omega')))
    assert [(r['candidate']['name'], r['status']) for r in reviews()] == [
        ('Furret Delta', 'superseded'), ('Furret Omega', 'pending')]


def test_stale_review_reopens_when_its_evidence_returns():
    drift()
    original = reviews()[0]['id']
    run(Records(furret()))
    run(Records(renamed()))
    [review] = reviews()
    assert review['id'] == original and review['status'] == 'pending'
    assert review['reason'] is None and review['reviewed_at'] is None
    assert [a['action'] for a in audit()] == ['stale', 'reopened']
    assert set(correspondences().values()) == {'unresolved'}


def test_still_raised_review_is_untouched():
    drift()
    before = reviews()
    run(Records(renamed()))
    assert reviews() == before and audit() == []


@pytest.mark.parametrize('status', ['retained', 'confirmed', 'corrected'])
def test_decided_review_is_never_settled(status):
    drift()
    decide_pending(status)
    run(Records(furret()))
    assert reviews()[0]['status'] == status and audit() == []


def test_third_party_drift_stays_pending():
    reset_catalog()
    first = furret()
    first['variants_detailed'][0]['thirdParty'] = {'tcgplayer': 219333}
    run(Records(first))
    changed = furret()
    changed['variants_detailed'][0]['thirdParty'] = {'tcgplayer': 999}
    run(Records(changed))
    run(Records(changed))
    assert reviews()[0]['status'] == 'pending' and audit() == []


def test_linked_source_closes_pending_source_match():
    reset_catalog()
    run(Records(furret()))
    manual, _ = seed_manual('swsh3', '136')
    run(Records(furret()))
    assert reviews()[0]['kind'] == 'source_match'
    with connect() as conn:
        conn.execute('INSERT INTO catalog_source_reference(source_id,printing_id,review_id,evidence_url) VALUES (%s,%s,%s,%s)', ('meta-1', manual, reviews()[0]['id'], 'https://example.org/card'))
    run(Records(furret()))
    assert reviews()[0]['status'] == 'stale'


def test_owner_decision_on_auto_closed_review_is_409():
    drift()
    run(Records(furret()))
    review = reviews()[0]
    response = call('POST', f"/api/admin/catalog-reviews/{review['id']}/decision", owner(),
                    {'decision': 'keep_existing', 'reason': 'Already resolved', 'evidence_url': 'https://example.org/card', 'evidence_digest': '0' * 64})
    assert response.status_code == 409


def foreign_review():
    drift()
    user = owner()
    with connect() as conn:
        conn.execute("UPDATE catalog_review SET source_fingerprint='foreign'")
    return user


def snapshot():
    with connect() as conn:
        return reviews(), conn.execute('SELECT revision FROM catalog_state').fetchone(), audit()


def test_backlog_dry_run_writes_nothing():
    user = foreign_review()
    before = snapshot()
    result = settle_backlog(user, out=lambda _: None)
    assert result['actions'] == {'stale': 1} and result['applied'] == 0
    assert snapshot() == before


def test_backlog_apply_closes_once_and_is_idempotent():
    user = foreign_review()
    assert settle_backlog(user, apply=True, out=lambda _: None)['applied'] == 1
    assert settle_backlog(user, apply=True, out=lambda _: None)['applied'] == 0
    assert [(a['trigger'], a['actor_id']) for a in audit()] == [('command', user)]


def test_backlog_refuses_non_owner():
    reset_catalog()
    with pytest.raises(HTTPException) as error:
        settle_backlog('not-owner', out=lambda _: None)
    assert error.value.status_code == 403


@pytest.mark.parametrize('apply', [False, True])
def test_backlog_refuses_while_runner_lock_held(apply):
    user = foreign_review()
    with connect(autocommit=True) as lock:
        lock.execute('SELECT pg_advisory_lock(914703)')
        with pytest.raises(RunnerBusy):
            settle_backlog(user, apply=apply, out=lambda _: None)


@pytest.mark.parametrize('change', ['key', 'decision', 'classification'])
def test_review_apply_revalidates_plan(change):
    user = foreign_review()
    with connect() as conn:
        items, _ = plan_review_backlog(conn)
    with connect() as conn:
        if change == 'key':
            conn.execute("UPDATE catalog_generation_printing SET source_fingerprint='new-key' WHERE source_id='meta-1'")
        elif change == 'decision':
            conn.execute("UPDATE catalog_review SET status='retained'")
        else:
            conn.execute("""INSERT INTO catalog_review(source_id,kind,source_fingerprint,detail)
              VALUES ('meta-1','name_change',%s,'Replacement')""", (items[0].current_fingerprint,))
    with connect(autocommit=True) as conn:
        assert apply_review_backlog(conn, items, user) == 0
    assert audit() == []



def test_review_apply_does_not_deadlock_an_owner_add_waiting_for_the_catalog(monkeypatch):
    user = foreign_review()
    with connect() as conn:
        items, _ = plan_review_backlog(conn)
    futures = []
    entered = threading.Event()
    real_record = review_settlement.record_settlement
    with connect() as writer, connect(autocommit=True) as observer, ThreadPoolExecutor(max_workers=1) as executor:
        writer.execute('INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING', (user,))
        writer.execute('SELECT 1 FROM inventory_owner WHERE user_id=%s FOR UPDATE', (user,))
        def finish_add():
            writer.execute("SET LOCAL statement_timeout='10s'")
            return writer.execute('SELECT active_generation FROM catalog_state WHERE singleton FOR SHARE').fetchone()
        def record(conn, **kwargs):
            if not entered.is_set():
                entered.set()
                futures.append(executor.submit(finish_add))
                wait_for_block(observer, writer.info.backend_pid, conn.info.backend_pid)
            return real_record(conn, **kwargs)
        monkeypatch.setattr(review_settlement, 'record_settlement', record)
        with connect(autocommit=True) as conn:
            assert apply_review_backlog(conn, items, user) == 1
        assert futures[0].result(timeout=5)['active_generation'] is not None
        writer.commit()
    assert reviews()[0]['status'] == 'stale'
    assert [a['actor_id'] for a in audit()] == [user]


@pytest.mark.parametrize('busy', ['catalog clock', 'review'])
def test_review_apply_skips_a_batch_whose_clock_or_review_is_busy(monkeypatch, busy):
    user = foreign_review()
    with connect() as conn:
        items, _ = plan_review_backlog(conn)
    observed, messages = [], []
    real_lock = review_settlement._lock_batch
    def observe(conn, ids):
        try:
            return real_lock(conn, ids)
        except review_settlement._Busy as error:
            assert isinstance(error.__cause__, LockNotAvailable)
            observed.append(error.__cause__.diag.message_primary)
            raise
    monkeypatch.setattr(review_settlement, '_lock_batch', observe)
    with connect() as writer, connect(autocommit=True) as conn:
        if busy == 'catalog clock':
            writer.execute('SELECT catalog_begin_correction()')
        else:
            writer.execute('SELECT 1 FROM catalog_review WHERE id=%s FOR UPDATE', (items[0].review_id,))
        assert apply_review_backlog(conn, items, user, out=messages.append) == 0
        relation = 'catalog_public_clock' if busy == 'catalog clock' else 'catalog_review'
        assert observed == [f'could not obtain lock on row in relation "{relation}"']
        assert messages == [f'review batch 1 skipped: {busy} busy']
        assert reviews()[0]['status'] == 'pending' and audit() == []
        writer.rollback()
    assert settle_backlog(user, apply=True, out=lambda _: None)['applied'] == 1


def test_review_apply_is_compatible_with_a_key_share_on_the_review():
    user = foreign_review()
    with connect() as conn:
        items, _ = plan_review_backlog(conn)
    messages = []
    with connect() as writer, connect(autocommit=True) as conn:
        writer.execute('SELECT 1 FROM catalog_review WHERE id=%s FOR KEY SHARE', (items[0].review_id,))
        assert apply_review_backlog(conn, items, user, out=messages.append) == 1
        assert messages == []
        writer.commit()
    assert reviews()[0]['status'] == 'stale'


def test_settlement_audit_has_no_owner_foreign_key():
    with connect() as conn:
        assert conn.execute("""SELECT count(*) AS n FROM pg_constraint
          WHERE conrelid='catalog_auto_settlement'::regclass AND contype='f'
          AND confrelid='inventory_owner'::regclass""").fetchone()['n'] == 0
