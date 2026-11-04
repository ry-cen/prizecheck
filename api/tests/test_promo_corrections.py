"""Explicit operator repairs against disposable PostgreSQL and public price records."""
import json
import runpy
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event

import pytest
from fastapi import HTTPException

from app.db import connect
from app.games.pokemon.prices import metadata_reviews, price_import, promo_corrections, public_prices
from app.games.pokemon.prices.catalog_targets import MATCHING, TargetContext, refresh_editions, rule_projection
from app.games.pokemon.prices.price_binding import join_spawned_rebinds, rebind_best_effort
from app.public_records import price_key
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_catalog_targets import isolated_rules, listing, promo, stock_prices, tcgplayer_products  # noqa: F401
from test_metadata_reviews import (OWNER, OTHER, activate_as_owner, price_store, published, seed_users,  # noqa: F401
                                   snapshot, spawned)

ROOT = Path(__file__).resolve().parents[2]
HOLO = {'type': 'holo', 'size': 'standard'}


@pytest.fixture(params=['eevee', 'charmander'])
def repair_world(request, tcgplayer_products, price_store):
    seed_users()
    if request.param == 'eevee':
        source_id, correct = 'svp-173', (610758, 610757)
        record = json.loads((ROOT / 'api/tests/fixtures/svp173/card.json').read_text())
        products = json.loads((ROOT / 'api/tests/fixtures/svp173/products.json').read_text())
        script = 'correct_eevee_svp173.py'
    else:
        source_id, correct = 'svp-044', (512035, 512036)
        record = promo(source_id, '044', name='Charmander', variants=[
            {**HOLO, 'thirdParty': {'tcgplayer': 477182}},
            {**HOLO, 'stamp': ['pokemon-center'], 'thirdParty': {'tcgplayer': 512036}}])
        products = json.loads((ROOT / 'api/tests/fixtures/svp044/products.json').read_text())
        script = 'correct_charmander_svp044.py'
    for product in products:
        number = next(e['value'] for e in product['extendedData'] if e['name'] == 'Number')
        listing(product['productId'], product['name'], number, product['groupId'])
    run(Records(record))
    activate_as_owner(MATCHING, 5)
    stock_prices(*[(p['productId'], 'Holofoil') for p in products])
    command = runpy.run_path(str(ROOT / 'scripts' / script))
    return {'source': source_id, 'record': record, 'correct': correct,
            'repair': command['repair'], 'evidence': command['EVIDENCE'], 'store': price_store}


def rows(world):
    with connect() as conn:
        return conn.execute("""SELECT e.id,e.public_ref,e.descriptor,m.*,b.sub_type_name,b.reason AS bind_reason
          FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
          JOIN catalog_edition_metadata m ON m.edition_id=e.id
          LEFT JOIN edition_price_binding b ON b.edition_id=e.id WHERE p.source_id=%s
          ORDER BY e.descriptor ? 'stamp'""", (world['source'],)).fetchall()


def decisions():
    with connect() as conn:
        return conn.execute('SELECT * FROM catalog_metadata_decision ORDER BY clock_revision').fetchall()


def test_dry_run_is_read_only_and_apply_rerun_preserves_audit_and_refresh(repair_world):
    w = repair_world
    before = snapshot()
    w['repair'](OWNER)
    assert snapshot() == before and decisions() == []
    identity = [(r['id'], r['descriptor']) for r in rows(w)]
    w['repair'](OWNER, apply=True)
    first = decisions()
    assert len(first) == (2 if w['source'] == 'svp-173' else 1)
    assert all(r['reviewer_id'] == OWNER and r['decision'] == 'correct' and
               r['evidence_url'] == w['evidence'] and r['source_fingerprint'] for r in first)
    with connect() as conn:
        rejected = conn.execute('SELECT decision_id FROM catalog_metadata_rejection WHERE decision_id=ANY(%s)',
                                ([r['id'] for r in first],)).fetchall()
    assert {r['decision_id'] for r in rejected} == {r['id'] for r in first}
    initial = rows(w)
    w['repair'](OWNER, apply=True)
    assert decisions() == first
    assert [r['mapping_revision'] for r in rows(w)] == [r['mapping_revision'] for r in initial]
    run(Records(w['record']))
    with connect() as conn:
        refresh_editions(conn, TargetContext(conn), [r['id'] for r in initial])
    rebind_best_effort()
    current = rows(w)
    assert [(r['id'], r['descriptor']) for r in current] == identity
    assert [r['product_id'] for r in current] == list(w['correct'])
    assert all(r['mapping_state'] == 'verified' and r['sub_type_name'] == 'Holofoil' and r['bind_reason'] is None for r in current)
    assert all(r['quote_variant'] is None for r in current if r['mapping_basis'] == 'maintainer')
    keys = [price_key(r['public_ref']) for r in current]
    records = w['store'].read_all(keys, deadline=time.monotonic() + 10).records
    for r, key in zip(current, keys):
        assert records[key].value == {'product_id': r['product_id'], 'mapping_revision': r['mapping_revision'], 'amount': '1'}


@pytest.mark.parametrize('field,value', [('name', 'Wrong card'), ('number', '002'), ('group_id', 1)])
def test_all_products_are_validated_before_any_decision(repair_world, field, value):
    w = repair_world
    with connect() as conn:
        conn.execute(f'UPDATE tcgplayer_product SET {field}=%s WHERE product_id=%s', (value, w['correct'][1]))
    before = snapshot()
    with pytest.raises(ValueError, match='name/number/group'):
        w['repair'](OWNER, apply=True)
    assert decisions() == [] and snapshot() == before


def test_changed_descriptor_and_wrong_owner_fail_without_writes(repair_world):
    w = repair_world
    with pytest.raises(HTTPException) as error:
        w['repair'](OTHER, apply=True)
    assert error.value.status_code == 403 and decisions() == []
    with connect() as conn:
        conn.execute("UPDATE catalog_edition SET descriptor=descriptor || '{\"stamp\":[\"different\"]}'::jsonb WHERE id=%s",
                     (rows(w)[1]['id'],))
    before = snapshot()
    with pytest.raises(ValueError, match='exactly one Edition'):
        w['repair'](OWNER, apply=True)
    assert snapshot() == before and decisions() == []


@pytest.mark.parametrize('field,value', [('name', 'Different card'), ('localId', '002'),
                                       ('set', {'id': 'other', 'name': 'Other Set'})])
def test_catalog_identity_must_match_reviewed_name_number_and_set(repair_world, field, value):
    w = repair_world
    run(Records({**w['record'], field: value}))
    before = snapshot()
    with pytest.raises(ValueError, match='catalog name/number/set'):
        w['repair'](OWNER, apply=True)
    assert snapshot() == before and decisions() == []


def test_source_change_after_preflight_is_not_silently_accepted(repair_world, monkeypatch):
    w = repair_world
    original = promo_corrections.decide
    changed = json.loads(json.dumps(w['record']))
    changed['variants_detailed'][0]['thirdParty']['tcgplayer'] = 999999

    def raced(command, **kwargs):
        run(Records(changed))
        return original(command, **kwargs)

    monkeypatch.setattr(promo_corrections, 'decide', raced)
    with pytest.raises(HTTPException) as error:
        w['repair'](OWNER, apply=True)
    assert error.value.status_code == 409 and decisions() == []


def test_charmander_duplicate_source_withholds_price_and_repair_leaves_fuecoco_alone(tcgplayer_products, price_store):
    seed_users()
    listing(477182, 'Fuecoco - 002', '002', 22872)
    listing(512035, 'Charmander - 044', '044', 22872)
    listing(512036, 'Charmander - 044 (Pokemon Center Exclusive)', '044', 22872)
    fuecoco = promo('svp-002', '002', name='Fuecoco', variants=[{**HOLO, 'thirdParty': {'tcgplayer': 477182}}])
    run(Records(fuecoco))
    activate_as_owner(MATCHING, 5)
    record = promo('svp-044', '044', name='Charmander', variants=[
        {**HOLO, 'thirdParty': {'tcgplayer': 477182}},
        {**HOLO, 'stamp': ['pokemon-center'], 'thirdParty': {'tcgplayer': 512036}}])
    run(Records(fuecoco, record))
    stock_prices((477182, 'Holofoil'), (512035, 'Holofoil'), (512036, 'Holofoil'))
    w = {'source': 'svp-044'}
    rebind_best_effort()
    assert rows(w)[0]['mapping_state'] != 'verified' and rows(w)[0]['sub_type_name'] is None
    before_fuecoco = rows({'source': 'svp-002'})
    repair = runpy.run_path(str(ROOT / 'scripts/correct_charmander_svp044.py'))['repair']
    repair(OWNER, apply=True)
    assert [r['product_id'] for r in rows(w)] == [512035, 512036]
    assert rows({'source': 'svp-002'}) == before_fuecoco
    assert len(decisions()) == 1


@pytest.mark.parametrize('repair_world', ['eevee'], indirect=True)
def test_interrupted_eevee_apply_resumes_only_missing_decision(repair_world, monkeypatch):
    w = repair_world
    original = promo_corrections.decide
    calls = []

    def interrupted(*args, **kwargs):
        calls.append(True)
        if len(calls) == 2:
            raise RuntimeError('operator interruption')
        return original(*args, **kwargs)

    monkeypatch.setattr(promo_corrections, 'decide', interrupted)
    with pytest.raises(RuntimeError, match='interruption'):
        w['repair'](OWNER, apply=True)
    assert len(decisions()) == 1
    monkeypatch.setattr(promo_corrections, 'decide', original)
    w['repair'](OWNER, apply=True)
    assert len(decisions()) == 2


def test_failed_price_publication_is_visible_and_noop_rerun_repairs_it(repair_world, monkeypatch, capsys):
    w = repair_world
    original = public_prices.publish

    def unavailable(*args, **kwargs):
        raise RuntimeError('store unavailable')

    monkeypatch.setattr(public_prices, 'publish', unavailable)
    with pytest.raises(RuntimeError, match='Decisions may be saved'):
        w['repair'](OWNER, apply=True)
    output = capsys.readouterr().out
    assert 'decision=' in output and 'rebind=' in output and 'price_publication=' not in output
    saved = decisions()
    monkeypatch.setattr(public_prices, 'publish', original)
    w['repair'](OWNER, apply=True)
    assert decisions() == saved


def test_concurrent_invocation_stops_before_writing_duplicate_decisions(repair_world, monkeypatch):
    w = repair_world
    entered, release = Event(), Event()
    original = promo_corrections.decide

    def held(*args, **kwargs):
        entered.set()
        assert release.wait(10), 'test did not release the first correction'
        return original(*args, **kwargs)

    monkeypatch.setattr(promo_corrections, 'decide', held)
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(w['repair'], OWNER, apply=True)
        try:
            assert entered.wait(10), 'first correction did not reach its decision'
            with pytest.raises(RuntimeError, match='already running'):
                w['repair'](OWNER, apply=True)
        finally:
            release.set()
        first.result(timeout=20)
    saved = decisions()
    assert len(saved) == (2 if w['source'] == 'svp-173' else 1)
    w['repair'](OWNER, apply=True)
    assert decisions() == saved  # The failed contender can safely retry after lock release.


def owner_decision(row, decision, value=None):
    with connect() as conn:
        loaded = metadata_reviews.load_target(conn, 'edition', row['id'])
    result = metadata_reviews.decide(metadata_reviews.MetadataDecisionInput(
        target='marketplace', printing_id=loaded['printing_id'], edition_id=loaded['edition_id'], decision=decision,
        reviewed_value=value, basis_revision=loaded['basis_revision'], evidence_digest=loaded['evidence_digest'],
        evidence_url='https://example.org/renewed-review', reason='Later owner review'), user_id=OWNER)
    join_spawned_rebinds()
    return result


@pytest.mark.parametrize('decision', ['unmap', 'reject_source', 'correct'])
def test_ordinary_rerun_cannot_reverse_later_owner_decisions(repair_world, decision):
    w = repair_world
    w['repair'](OWNER, apply=True)
    target = rows(w)[0]
    owner_decision(target, decision, {'product_id': 888888, 'quote_variant': None} if decision == 'correct' else None)
    before, history = snapshot(), decisions()
    with pytest.raises(ValueError, match='renewed review'):
        w['repair'](OWNER, apply=True)
    assert snapshot() == before and decisions() == history
    with connect() as conn:
        assert target['public_ref'] not in public_prices.desired_values(conn)  # Never restore a quote.


def test_quarantine_after_correction_requires_renewed_review(repair_world):
    w = repair_world
    w['repair'](OWNER, apply=True)
    changed = json.loads(json.dumps(w['record']))
    changed['variants_detailed'][0]['thirdParty']['tcgplayer'] = 999999
    run(Records(changed))
    assert rows(w)[0]['mapping_state'] == 'quarantined'
    # Restoring the pinned source does not clear the existing quarantine.
    run(Records(w['record']))
    assert rows(w)[0]['mapping_state'] == 'quarantined'
    before, history = snapshot(), decisions()
    with pytest.raises(ValueError, match='renewed review'):
        w['repair'](OWNER, apply=True)
    assert snapshot() == before and decisions() == history
    with connect() as conn:
        assert rows(w)[0]['public_ref'] not in public_prices.desired_values(conn)


def test_protected_sibling_stops_all_proposed_decisions(repair_world):
    w = repair_world
    owner_decision(rows(w)[1], 'unmap')
    before, history = snapshot(), decisions()
    with pytest.raises(ValueError, match='renewed review'):
        w['repair'](OWNER, apply=True)
    assert snapshot() == before and decisions() == history


@pytest.mark.parametrize('repair_world', ['eevee'], indirect=True)
def test_partial_apply_preserves_owner_action_and_retry_requires_review(repair_world, monkeypatch):
    w = repair_world
    original = promo_corrections.decide
    sibling = rows(w)[1]

    def later_owner(command, **kwargs):
        if command.edition_id == sibling['id']:
            owner_decision(sibling, 'unmap')
        return original(command, **kwargs)

    monkeypatch.setattr(promo_corrections, 'decide', later_owner)
    with pytest.raises(HTTPException) as error:
        w['repair'](OWNER, apply=True)
    assert error.value.status_code == 409
    assert [d['decision'] for d in decisions()] == ['correct', 'unmap']
    monkeypatch.setattr(promo_corrections, 'decide', original)
    before, history = snapshot(), decisions()
    with pytest.raises(ValueError, match='renewed review'):
        w['repair'](OWNER, apply=True)
    assert snapshot() == before and decisions() == history


@pytest.mark.parametrize('apply', [False, True])
def test_unreviewed_source_candidate_before_preflight_is_rejected(repair_world, apply):
    w = repair_world
    changed = json.loads(json.dumps(w['record']))
    changed['variants_detailed'][0]['thirdParty']['tcgplayer'] = 999999
    # Fresh catalog, so this is verified source evidence rather than a quarantine:
    # a newly loaded digest must not turn it into an approval of the old repair.
    seed_users()
    run(Records(changed))
    activate_as_owner(MATCHING, 5)
    before = snapshot()
    with pytest.raises(ValueError, match='source evidence changed'):
        w['repair'](OWNER, apply=apply)
    assert snapshot() == before and decisions() == []


def test_material_change_between_dry_run_and_apply_is_rejected(repair_world):
    w = repair_world
    w['repair'](OWNER)
    changed = json.loads(json.dumps(w['record']))
    changed['variants_detailed'][0]['thirdParty']['tcgplayer'] = 999999
    run(Records(changed))
    before = snapshot()
    with pytest.raises(ValueError, match='source evidence changed'):
        w['repair'](OWNER, apply=True)
    assert snapshot() == before and decisions() == []


@pytest.mark.parametrize('change', ['unresolved', 'removed_variant', 'quote_product'])
def test_material_correspondence_or_quote_input_change_requires_review(repair_world, change):
    w = repair_world
    if change == 'removed_variant':
        record = json.loads(json.dumps(w['record']))
        record['variants_detailed'] = record['variants_detailed'][1:]
        run(Records(record))
    else:
        # Simulate stored candidate changes independently of the source parser, so
        # the script must validate correspondence and every matching input itself.
        with connect() as conn:
            candidate = conn.execute('SELECT mapping_candidate FROM catalog_edition_metadata WHERE edition_id=%s',
                                     (rows(w)[0]['id'],)).fetchone()['mapping_candidate']
            if change == 'unresolved':
                candidate['correspondence'] = 'unresolved'
            else:
                candidate['candidate']['pricing'] = {'tcgplayer': {'holofoil': {'productId': 999999}}}
            conn.execute('UPDATE catalog_edition_metadata SET mapping_candidate=%s::jsonb WHERE edition_id=%s',
                         (json.dumps(candidate), rows(w)[0]['id']))
    before = snapshot()
    with pytest.raises(ValueError, match='source evidence changed'):
        w['repair'](OWNER, apply=True)
    assert snapshot() == before and decisions() == []


def test_harmless_enrichment_keeps_reviewed_inputs_and_refresh_durability(repair_world):
    w = repair_world
    original = rows(w)
    record = json.loads(json.dumps(w['record']))
    for variant in record['variants_detailed']:
        variant['variantId'] = 'enriched-' + ('pc' if variant.get('stamp') else 'regular')
        # Both fields are excluded from source_descriptor. In contrast,
        # thirdParty is retained in legacy descriptors and must not drift here.
        variant.setdefault('pricing', {})['cardmarket'] = {'productId': 123456, 'avg': 1.25}
    run(Records(record))
    enriched = rows(w)
    assert [(r['id'], r['descriptor']) for r in enriched] == [(r['id'], r['descriptor']) for r in original]
    for before, after in zip(original, enriched, strict=True):
        assert after['mapping_candidate']['correspondence'] == 'source_candidate'
        assert after['mapping_candidate'] != before['mapping_candidate']  # The ignored enrichment reached storage.
        assert rule_projection(after['mapping_candidate']) == rule_projection(before['mapping_candidate'])
        for field in ('mapping_state', 'mapping_reason', 'product_id', 'quote_variant', 'mapping_revision', 'public_revision'):
            assert after[field] == before[field], field
    w['repair'](OWNER, apply=True)
    first, corrected = decisions(), snapshot()
    run(Records(record))
    refreshed = snapshot()
    assert refreshed['state'] == corrected['state'] + 1  # Every successful catalog import advances its revision.
    assert refreshed['editions'] == corrected['editions']
    assert decisions() == first
    w['repair'](OWNER, apply=True)
    assert snapshot() == refreshed and decisions() == first  # The no-op repair changes no snapshot field.


@pytest.mark.parametrize('apply', [False, True])
def test_cardmarket_descriptor_drift_requires_renewed_correspondence_review(repair_world, apply):
    w = repair_world
    original = rows(w)
    record = json.loads(json.dumps(w['record']))
    for variant in record['variants_detailed']:
        variant['thirdParty']['cardmarket'] = 123456
    run(Records(record))
    unresolved = rows(w)
    assert [(r['id'], r['descriptor']) for r in unresolved] == [(r['id'], r['descriptor']) for r in original]
    assert all(r['mapping_candidate']['correspondence'] == 'unresolved' for r in unresolved)
    assert all(r['mapping_state'] == 'quarantined' for r in unresolved)
    before, history = snapshot(), decisions()
    with pytest.raises(ValueError, match='source evidence changed'):
        w['repair'](OWNER, apply=apply)
    assert snapshot() == before and decisions() == history


def test_already_correct_upstream_inputs_are_noop_without_owner_decisions(repair_world):
    w = repair_world
    record = json.loads(json.dumps(w['record']))
    for variant, product in zip(record['variants_detailed'], w['correct'], strict=True):
        variant['thirdParty']['tcgplayer'] = product
    seed_users()
    run(Records(record))
    activate_as_owner(MATCHING, 5)
    before = snapshot()
    w['repair'](OWNER, apply=True)
    assert snapshot() == before and decisions() == []


def test_in_progress_price_import_stops_correction_before_decisions(repair_world):
    w = repair_world
    before = snapshot()
    with connect(autocommit=True) as conn:
        conn.execute('SELECT pg_advisory_lock(%s)', (price_import.ADVISORY_LOCK,))
        with pytest.raises(RuntimeError, match='price import is already running'):
            w['repair'](OWNER, apply=True)
    assert snapshot() == before and decisions() == []


def test_product_import_is_excluded_between_preflight_and_decision(repair_world, monkeypatch):
    w = repair_world
    original = promo_corrections.decide
    outcomes = []

    def during_apply(command, **kwargs):
        with connect(autocommit=True) as conn:
            # The real import entry point must stop before using its client or
            # writing products while the correction relies on their identity.
            outcomes.append(price_import.run(conn, client=object()).outcome)
        return original(command, **kwargs)

    monkeypatch.setattr(promo_corrections, 'decide', during_apply)
    w['repair'](OWNER, apply=True)
    saved = decisions()
    assert outcomes and set(outcomes) == {'locked'}
    with connect() as conn:
        conn.execute('UPDATE tcgplayer_product SET name=%s WHERE product_id=%s', ('Later imported name', w['correct'][0]))
    before = snapshot()
    with pytest.raises(ValueError, match='name/number/group'):
        w['repair'](OWNER, apply=True)
    assert snapshot() == before and decisions() == saved


def test_failed_final_rebind_is_visible_and_retry_preserves_decisions(repair_world, monkeypatch):
    w = repair_world
    original = promo_corrections.rebind

    def unavailable(conn):
        raise RuntimeError('binding unavailable')

    monkeypatch.setattr(promo_corrections, 'rebind', unavailable)
    with pytest.raises(RuntimeError, match='Decisions may be saved'):
        w['repair'](OWNER, apply=True)
    saved, before = decisions(), snapshot()
    monkeypatch.setattr(promo_corrections, 'rebind', original)
    w['repair'](OWNER, apply=True)
    assert decisions() == saved and snapshot() == before


def test_noop_apply_repairs_stale_binding_without_new_decisions(repair_world):
    w = repair_world
    w['repair'](OWNER, apply=True)
    target = rows(w)[0]
    with connect() as conn:
        conn.execute('UPDATE edition_price_binding SET mapping_revision=mapping_revision-1 WHERE edition_id=%s',
                     (target['id'],))
        assert target['public_ref'] not in public_prices.desired_values(conn)
    saved = decisions()
    w['repair'](OWNER, apply=True)
    assert decisions() == saved
    with connect() as conn:
        assert public_prices.desired_values(conn)[target['public_ref']]['mapping_revision'] == target['mapping_revision']
