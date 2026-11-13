"""Rule-only metadata acceptance and owner backlog releases."""
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from psycopg.errors import DeadlockDetected, LockNotAvailable

from app.main import connect
from app.games.pokemon.prices import catalog_targets as targets
from app.games.pokemon.prices.metadata_settlement import plan_metadata_backlog, apply_metadata_backlog
from app.games.pokemon.catalog.review_settlement import settle_backlog
from test_catalog import reset_catalog
from test_catalog_metadata import Records, furret, renamed, owner, editions, by_type, printing_rows
from test_catalog_reconciliation import run
from test_catalog_targets import decide_mapping
from test_holdings import call


@pytest.fixture(autouse=True)
def rules():
    with connect() as conn:
        conn.execute('UPDATE catalog_rule_state SET activation_id=NULL')
    yield
    with connect() as conn:
        conn.execute('UPDATE catalog_rule_state SET activation_id=NULL')


def setup():
    reset_catalog()
    run(Records(furret()))
    user = owner()
    with connect() as conn:
        targets.activate_rule(conn, targets.MATCHING, 1, user, 'https://example.org/rule', 'Reviewed')
    return user


def changed():
    return furret(variants_detailed__0__pricing__tcgplayer__normal__productId=999)


def row():
    eid = by_type(editions())['normal']['id']
    with connect() as conn:
        return conn.execute('SELECT * FROM catalog_edition_metadata WHERE edition_id=%s', (eid,)).fetchone()


def audit():
    with connect() as conn:
        return conn.execute('SELECT * FROM catalog_auto_settlement ORDER BY created_at,id').fetchall()


def report(eid, user, status='pending'):
    with connect() as conn:
        conn.execute("""INSERT INTO catalog_metadata_report(reporter_id,target,issue,printing_id,edition_id,status)
          SELECT %s,'marketplace','incorrect',printing_id,id,%s FROM catalog_edition WHERE id=%s""", (user, status, eid))


def test_changed_product_on_rule_verified_edition_is_accepted():
    user = setup()
    run(Records(changed()))
    after = row()
    assert (after['mapping_state'], after['product_id'], after['mapping_basis']) == ('verified', 999, 'matching_rule')
    assert [a['action'] for a in audit()] == ['default_accepted']
    queue = call('GET', '/api/admin/catalog-metadata/queue', user).json()
    assert queue['items'] == []


@pytest.mark.parametrize('status', ['pending', 'needs_info'])
def test_open_report_keeps_changed_edition_quarantined(status):
    user = setup()
    report(row()['edition_id'], user, status)
    run(Records(changed()))
    assert (row()['mapping_state'], row()['mapping_reason']) == ('quarantined', 'candidate_changed')
    assert audit() == []


def test_report_on_sibling_edition_does_not_block():
    user = setup()
    report(by_type(editions())['reverse']['id'], user)
    run(Records(changed()))
    assert row()['product_id'] == 999 and row()['mapping_state'] == 'verified'


def test_rejected_candidate_is_not_accepted():
    setup()
    before = row()
    decide_mapping(before['edition_id'], before['mapping_candidate'], before['product_id'], before['quote_variant'])
    decision_id = row()['mapping_decision_id']
    # Keep a valid human rejection record, then restore the original rule mapping.
    with connect() as conn:
        conn.execute("UPDATE catalog_edition_metadata SET mapping_basis='matching_rule' WHERE edition_id=%s", (before['edition_id'],))
    run(Records(changed()))
    changed_row = row()
    with connect() as conn:
        conn.execute("""INSERT INTO catalog_metadata_rejection(target,printing_id,edition_id,source_fingerprint,decision_id)
          VALUES ('marketplace',%s,%s,%s,%s)""",
                     (changed_row['printing_id'], changed_row['edition_id'], targets.fingerprint(changed_row['mapping_candidate']),
                      decision_id))
        conn.execute("""UPDATE catalog_edition_metadata SET mapping_state='quarantined',mapping_reason='candidate_changed'
          WHERE edition_id=%s""", (before['edition_id'],))
    user = owner()
    with connect() as conn:
        audit_count = conn.execute('SELECT count(*) AS n FROM catalog_auto_settlement').fetchone()['n']
    assert settle_backlog(user, apply=True, out=lambda _: None)['applied'] == 0
    assert row()['mapping_state'] == 'quarantined'
    assert len(audit()) == audit_count
    current = targets.EditionState(state='verified', basis='matching_rule')
    facts = {'correspondence': 'source_candidate', 'fingerprint': 'rejected'}
    assert targets.default_accept_edition(current, facts, {'rejected'}, object(), lambda *args: False) is None


def test_maintainer_verified_edition_still_quarantines_on_change():
    setup()
    before = row()
    decide_mapping(before['edition_id'], before['mapping_candidate'], before['product_id'], before['quote_variant'])
    run(Records(changed()))
    assert row()['mapping_state'] == 'quarantined' and audit() == []


def test_conflicting_candidate_still_quarantines():
    setup()
    record = changed()
    record['variants_detailed'][0]['pricing']['tcgplayer']['holofoil'] = {'productId': 998}
    run(Records(record))
    assert row()['mapping_reason'] == 'candidate_conflict' and audit() == []


def backlog():
    user = setup()
    eid = row()['edition_id']
    report(eid, user)
    run(Records(changed()))
    with connect() as conn:
        conn.execute("""UPDATE catalog_metadata_report SET status='rejected',reviewer_id=%s,
          reviewed_at=now(),review_reason='Not an issue' WHERE edition_id=%s""", (user, eid))
    return user


def test_backlog_accepts_quarantined_candidate_changed():
    user = backlog()
    before = row()
    assert settle_backlog(user, out=lambda _: None)['actions'] == {'default_accepted': 1}
    assert row() == before
    assert settle_backlog(user, apply=True, out=lambda _: None)['applied'] == 1
    after = row()
    assert after['mapping_state'] == 'verified' and after['product_id'] == 999
    assert after['mapping_revision'] == before['mapping_revision'] + 1
    assert audit()[0]['actor_id'] == user
    assert settle_backlog(user, apply=True, out=lambda _: None)['applied'] == 0


@pytest.mark.parametrize('pending', [False, True])
def test_backlog_releases_physical_conflict_after_review_closes(pending):
    user = setup()
    run(Records(renamed()))
    if not pending:
        run(Records(furret()))
    result = settle_backlog(user, apply=True, out=lambda _: None)
    assert result['applied'] == (0 if pending else 2)
    assert {r['mapping_state'] for r in editions()} == ({'quarantined'} if pending else {'verified'})


def test_backlog_skips_target_whose_evidence_changed():
    user = backlog()
    with connect() as conn:
        items, _ = plan_metadata_backlog(conn)
    report(row()['edition_id'], user)
    with connect(autocommit=True) as conn:
        assert apply_metadata_backlog(conn, items, user) == (0, 1)
    assert row()['mapping_state'] == 'quarantined' and audit() == []


def test_recovery_conflict_stays_manual():
    user = setup()
    with connect() as conn:
        conn.execute("UPDATE catalog_edition_metadata SET mapping_state='quarantined',mapping_reason='recovery_conflict'")
    result = settle_backlog(user, apply=True, out=lambda _: None)
    assert result['manual'] == {'manual:recovery_conflict': 2} and result['applied'] == 0


@pytest.mark.parametrize('collision', ['product', 'variant'])
@pytest.mark.parametrize('derived', [False, True])
def test_default_accept_checks_derived_product_and_sibling_variant(monkeypatch, collision, derived):
    user = setup()
    other = furret(id='meta-2', localId='137')
    for variant in other['variants_detailed']:
        for block in variant['pricing']['tcgplayer'].values():
            if isinstance(block, dict):
                block['productId'] = 777
    run(Records(furret(), other))
    class Rule(targets.MatchingRulesV1):
        @classmethod
        def evaluate(cls, facts, held):
            # Deliberately return a derived result so the settlement gate itself must check collisions.
            return (777, 'normal') if collision == 'product' else (999, 'reverse-holofoil')
    monkeypatch.setitem(targets.MATCHING_RULES, 99, Rule)
    with connect() as conn:
        targets.record_activation(conn, targets.MATCHING, 99, user, 'https://example.org/rule', 'Reviewed')
    record = changed()
    record['variants_detailed'][0]['pricing']['tcgplayer']['normal']['productId'] = 999 if derived else 777
    run(Records(record, other))
    assert row()['mapping_state'] == 'quarantined'
    assert audit() == []


def correct_live(user, pid, number='136'):
    """Use the actual owner endpoint, including its rejection and decision rows."""
    evidence = call('GET', f'/api/admin/catalog-metadata/printings/{pid}', user)
    assert evidence.status_code == 200, evidence.text
    shown = evidence.json()
    response = call('POST', '/api/admin/catalog-metadata/decisions', user, {
        'target': 'live', 'printing_id': str(pid), 'decision': 'correct',
        'reviewed_value': {'category': 'Pokemon', 'name': 'Furret', 'set_code': 'DAA', 'collector_number': number},
        'basis_revision': shown['basis_revision'], 'evidence_digest': shown['evidence_digest'],
        'evidence_url': 'https://example.org/card', 'reason': 'Reviewed physical Printing'})
    assert response.status_code == 200, response.text


def live_backlog(*, rejected=False, extra=()):
    user = setup()
    if extra:
        run(Records(furret(), *extra))
    with connect() as conn:
        targets.activate_rule(conn, targets.LIVE, 1, user, 'https://example.org/rule', 'Reviewed')
    pid = printing_rows()['id']
    corrected_fp = targets.fingerprint(printing_rows()['export_candidate'])
    correct_live(user, pid)
    run(Records(renamed(), *extra))
    # Set-name enrichment changes the fingerprint but not the accepted Live projection.
    restored = furret() if rejected else furret(set={'id': 'swsh3', 'name': 'Darkness Ablaze updated'})
    run(Records(restored, *extra))
    with connect() as conn:
        rejected_fps = [r['source_fingerprint'] for r in conn.execute(
            "SELECT source_fingerprint FROM catalog_metadata_rejection WHERE target='live' AND printing_id=%s", (pid,))]
    assert corrected_fp in rejected_fps
    assert (targets.fingerprint(printing_rows()['export_candidate']) in rejected_fps) == rejected
    assert printing_rows()['live_state'] == 'suspended'
    return user, pid


@pytest.mark.parametrize('changed_projection', [False, True])
def test_backlog_releases_live_identity_review_pending(changed_projection):
    user, pid = live_backlog()
    if changed_projection:
        with connect() as conn:
            conn.execute("UPDATE catalog_printing_metadata SET live_accepted_fingerprint='changed',live_accepted_projection='changed' WHERE printing_id=%s", (pid,))
    result = settle_backlog(user, apply=True, out=lambda _: None)
    assert printing_rows()['live_state'] == ('suspended' if changed_projection else 'eligible')
    assert result['applied'] == (2 if changed_projection else 3)


def test_rejected_live_export_stays_manual():
    user, pid = live_backlog(rejected=True)
    result = settle_backlog(user, apply=True, out=lambda _: None)
    assert result['manual']['manual:rejected_fingerprint'] == 1
    assert printing_rows()['live_state'] == 'suspended'
    assert not [a for a in audit() if a['subject'] == 'printing']


def test_one_backlog_apply_closes_reviews_and_releases_dependents():
    user, pid = live_backlog()
    with connect() as conn:
        conn.execute("UPDATE catalog_review SET status='pending',reviewed_at=NULL,reason=NULL WHERE kind='name_change'")
    before = audit()
    plan = settle_backlog(user, out=lambda _: None)
    assert plan['actions'] == {'stale': 1, 'released': 3} and plan['planned'] == 4
    assert audit() == before and printing_rows()['live_state'] == 'suspended'
    applied = settle_backlog(user, apply=True, out=lambda _: None)
    assert applied['actions'] == plan['actions'] and applied['applied'] == 4 and applied['skipped'] == 0
    assert printing_rows()['live_state'] == 'eligible'
    assert {r['mapping_state'] for r in editions()} == {'verified'}
    assert settle_backlog(user, apply=True, out=lambda _: None)['applied'] == 0


def test_live_release_savepoint_rolls_back_peer_suspension(monkeypatch):
    other = furret(id='meta-2', localId='137')
    user, pid = live_backlog(extra=(other,))
    with connect() as conn:
        items, _ = plan_metadata_backlog(conn)
        peer_id = conn.execute("SELECT id FROM catalog_printing WHERE source_id='meta-2'").fetchone()['id']
    correct_live(user, peer_id, '137')
    # Simulate an independently eligible peer acquiring the target's claim after planning.
    with connect() as conn:
        conn.execute("UPDATE catalog_printing_metadata SET live_claim='daa|136' WHERE printing_id=%s", (peer_id,))
        before = conn.execute('SELECT * FROM catalog_printing_metadata WHERE printing_id=ANY(%s) ORDER BY printing_id', ([pid, peer_id],)).fetchall()
    seen = []
    refresh = targets.refresh_printing
    def observe(conn, context, target_id, reviewed=False):
        result = refresh(conn, context, target_id, reviewed=reviewed)
        states = conn.execute('SELECT live_state,live_reason FROM catalog_printing_metadata WHERE printing_id=ANY(%s)', ([pid, peer_id],)).fetchall()
        seen.append(states)
        assert {(r['live_state'], r['live_reason']) for r in states} == {('suspended', 'conflicting_input')}
        return result
    monkeypatch.setattr(targets, 'refresh_printing', observe)
    with connect(autocommit=True) as conn:
        assert apply_metadata_backlog(conn, [i for i in items if i.kind == 'printing'], user) == (0, 1)
    assert len(seen) == 1
    with connect() as conn:
        assert conn.execute('SELECT * FROM catalog_printing_metadata WHERE printing_id=ANY(%s) ORDER BY printing_id', ([pid, peer_id],)).fetchall() == before
    assert not [a for a in audit() if a['subject'] == 'printing']


def test_import_rechecks_a_report_committed_after_the_first_check(monkeypatch):
    user = setup()
    eid = row()['edition_id']
    check = targets.open_marketplace_report
    checks = []
    def concurrent_report(conn, edition_id):
        result = check(conn, edition_id)
        if edition_id == eid:
            checks.append(result)
            if len(checks) == 1:
                assert not result
                report(eid, user)  # a separate connection commits between checks
        return result
    monkeypatch.setattr(targets, 'open_marketplace_report', concurrent_report)
    run(Records(changed()))
    assert checks == [False, True]
    assert (row()['mapping_state'], row()['mapping_reason']) == ('quarantined', 'candidate_changed')
    assert audit() == []


def wait_for_block(conn, pid, blocker):
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        if blocker in conn.execute('SELECT pg_blocking_pids(%s) AS blockers', (pid,)).fetchone()['blockers']:
            return
        threading.Event().wait(0.01)
    pytest.fail('automation did not wait for the concurrent report transaction')


@pytest.mark.parametrize('kind', ['edition', 'printing'])
@pytest.mark.parametrize('owner_report', [False, True])
def test_command_skips_uncommitted_reports_without_locking_the_owner(monkeypatch, kind, owner_report):
    if kind == 'edition':
        user = backlog()
        target_id, pid = row()['edition_id'], row()['printing_id']
    else:
        user, pid = live_backlog()
        target_id = pid
    with connect() as conn:
        items, _ = plan_metadata_backlog(conn)
    selected = [i for i in items if i.kind == kind and i.target_id == target_id]
    assert len(selected) == 1
    attempted = []
    real_lock = targets.lock_report_target
    def observe(conn, target_kind, target):
        attempted.append(target)
        real_lock(conn, target_kind, target)
    monkeypatch.setattr(targets, 'lock_report_target', observe)
    messages = []
    with connect() as reporter, connect(autocommit=True) as conn:
        reporter_id = user if owner_report else 'settlement-concurrent-reporter'
        reporter.execute('INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING', (reporter_id,))
        reporter.execute('SELECT 1 FROM inventory_owner WHERE user_id=%s FOR UPDATE', (reporter_id,))
        reporter.execute("""INSERT INTO catalog_metadata_report(reporter_id,target,issue,printing_id,edition_id)
          VALUES (%s,%s,'incorrect',%s,%s)""", (reporter_id, 'marketplace' if kind == 'edition' else 'live', pid,
                                               target_id if kind == 'edition' else None))
        assert apply_metadata_backlog(conn, selected, user, out=messages.append) == (0, 1)
        assert attempted == [target_id]
        assert messages[0].endswith('skipped: target busy')
        reporter.execute("SET LOCAL lock_timeout='2s'")
        reporter.execute('SELECT catalog_begin_correction()')  # the skip released the command's clock
    assert (row()['mapping_state'] if kind == 'edition' else printing_rows()['live_state']) == ('quarantined' if kind == 'edition' else 'suspended')
    assert not [a for a in audit() if a['subject'] == kind]


def test_command_target_conflict_uses_nowait_not_lock_timeout(monkeypatch):
    user = backlog()
    eid, pid = row()['edition_id'], row()['printing_id']
    with connect() as conn:
        items, _ = plan_metadata_backlog(conn)
    observed = []
    real_lock = targets.lock_report_target
    def observe(conn, kind, target_id):
        try:
            real_lock(conn, kind, target_id)
        except LockNotAvailable as error:
            observed.append(error.diag.message_primary)
            raise
    monkeypatch.setattr(targets, 'lock_report_target', observe)
    messages = []
    with connect() as reporter, connect(autocommit=True) as conn:
        reporter.execute("INSERT INTO catalog_metadata_report(target,issue,printing_id,edition_id) VALUES ('marketplace','incorrect',%s,%s)", (pid, eid))
        assert apply_metadata_backlog(conn, items, user, out=messages.append) == (0, 1)
    assert observed == ['could not obtain lock on row in relation "catalog_edition"']
    assert messages[0].endswith('skipped: target busy')
    assert row()['mapping_state'] == 'quarantined' and audit() == []


def test_import_busy_edition_quarantines_without_failing_promotion(monkeypatch):
    user = setup()
    eid, pid = row()['edition_id'], row()['printing_id']
    observed = []
    real_lock = targets.lock_report_target
    def observe(conn, kind, target_id):
        try:
            real_lock(conn, kind, target_id)
        except LockNotAvailable as error:
            observed.append(error.diag.message_primary)
            raise
    monkeypatch.setattr(targets, 'lock_report_target', observe)
    with connect() as reporter:
        reporter.execute("""INSERT INTO catalog_metadata_report(reporter_id,target,issue,printing_id,edition_id)
          VALUES (%s,'marketplace','incorrect',%s,%s)""", (user, pid, eid))
        run_id = run(Records(changed()))
        with connect() as conn:
            assert conn.execute('SELECT outcome FROM catalog_run WHERE id=%s', (run_id,)).fetchone()['outcome'] == 'succeeded'
        assert (row()['mapping_state'], row()['mapping_reason']) == ('quarantined', 'candidate_changed')
        assert audit() == []
    assert observed == ['could not obtain lock on row in relation "catalog_edition"']


@pytest.mark.parametrize('kind', ['edition', 'printing'])
def test_nowait_skip_releases_clock_for_an_fk_first_writer(monkeypatch, kind):
    if kind == 'edition':
        user = backlog()
        target_id = row()['edition_id']
        source_id = by_type(editions())['reverse']['id']
    else:
        user, target_id = live_backlog()
    with connect() as conn:
        items, _ = plan_metadata_backlog(conn)
    selected = [i for i in items if i.kind == kind and i.target_id == target_id]
    assert len(selected) == 1
    observed, futures, messages = [], [], []
    real_lock = targets.lock_report_target
    with connect() as writer, connect(autocommit=True) as observer, ThreadPoolExecutor(max_workers=1) as executor:
        if kind == 'edition':
            # deprecate_edition's replacement is itself the planned target.
            writer.execute('SELECT 1 FROM catalog_state WHERE singleton FOR UPDATE')
            writer.execute("""INSERT INTO catalog_edition_replacement
              (edition_id,replacement_edition_id,reviewer_id,evidence_url,reason)
              VALUES (%s,%s,%s,'https://example.org/card','Reviewed replacement')""", (source_id, target_id, user))
        else:
            # refresh_fallbacks inserts this FK row before requesting the catalog clock.
            writer.execute('INSERT INTO catalog_printing_fallback_art(printing_id,product_id) VALUES (%s,999)', (target_id,))
        def finish_writer():
            writer.execute("SET LOCAL statement_timeout='10s'")
            if kind == 'edition':
                from app.games.pokemon.catalog.catalog_reconciliation import release_price_slots
                assert release_price_slots(writer, [source_id])
            else:
                writer.execute('UPDATE catalog_printing_metadata SET public_revision=catalog_begin_correction() WHERE printing_id=%s', (target_id,))
        def before_target(conn, target_kind, target):
            futures.append(executor.submit(finish_writer))
            # Prove the existing writer is requesting our clock while retaining its target FK lock.
            wait_for_block(observer, writer.info.backend_pid, conn.info.backend_pid)
            try:
                real_lock(conn, target_kind, target)
            except LockNotAvailable as error:
                observed.append(error.diag.message_primary)
                raise
        monkeypatch.setattr(targets, 'lock_report_target', before_target)
        with connect(autocommit=True) as conn:
            assert apply_metadata_backlog(conn, selected, user, out=messages.append) == (0, 1)
        futures[0].result(timeout=5)  # no DeadlockDetected or timeout in the existing writer
        writer.commit()
    assert observed == [f'could not obtain lock on row in relation "catalog_{kind}"']
    assert messages[0].endswith('skipped: target busy')
    assert not [a for a in audit() if a['subject'] == kind]
    monkeypatch.setattr(targets, 'lock_report_target', real_lock)
    assert settle_backlog(user, apply=True, out=lambda _: None)['applied'] >= 1
    assert (row()['mapping_state'] if kind == 'edition' else printing_rows()['live_state']) == ('verified' if kind == 'edition' else 'eligible')


@pytest.mark.parametrize('error', [LockNotAvailable, DeadlockDetected])
def test_command_counts_lock_errors_as_skips(monkeypatch, error):
    user = backlog()
    with connect() as conn:
        items, _ = plan_metadata_backlog(conn)
    def failed_lock(*args):
        raise error('Concurrent report')
    monkeypatch.setattr(targets, 'lock_report_target', failed_lock)
    messages = []
    result = settle_backlog(user, apply=True, out=messages.append)
    assert result['applied'] == 0 and result['skipped'] == 1
    assert any(line.endswith('skipped: target busy') for line in messages)
    assert row()['mapping_state'] == 'quarantined' and audit() == []


@pytest.mark.parametrize('kind', ['edition', 'printing'])
def test_command_releases_while_the_owner_holds_their_inventory_lock(kind):
    if kind == 'edition':
        user = backlog()
        target_id = row()['edition_id']
    else:
        user, target_id = live_backlog()
    with connect() as conn:
        items, _ = plan_metadata_backlog(conn)
    selected = [i for i in items if i.kind == kind and i.target_id == target_id]
    assert len(selected) == 1
    messages = []
    with connect() as writer, connect(autocommit=True) as conn:
        writer.execute('INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING', (user,))
        writer.execute('SELECT 1 FROM inventory_owner WHERE user_id=%s FOR UPDATE', (user,))
        assert apply_metadata_backlog(conn, selected, user, out=messages.append) == (1, 0)
        assert messages == []
        writer.execute("SET LOCAL lock_timeout='2s'")
        writer.execute('SELECT catalog_begin_correction()')
        writer.commit()
    assert (row()['mapping_state'] if kind == 'edition' else printing_rows()['live_state']) == ('verified' if kind == 'edition' else 'eligible')
    assert [a['actor_id'] for a in audit() if a['subject'] == kind] == [user]
