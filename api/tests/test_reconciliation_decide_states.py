"""Catalog review decisions resolve once and roll back together on failure.

CatalogDecision has no idempotency key; an identical HTTP replay is another decision.
"""
from uuid import uuid4

import pytest

from app.games.pokemon.catalog import catalog_reconciliation as reconciliation
from app.main import connect
from test_catalog import Source, reset_catalog
from test_catalog_reconciliation import run, shown
from test_holdings import call


@pytest.fixture
def pending_review():
    reset_catalog()
    run(Source())
    owner = str(uuid4())
    with connect() as conn:
        conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s)', (owner,))
        conn.execute('INSERT INTO owner_binding(user_id) VALUES (%s)', (owner,))
        printing = conn.execute("SELECT id FROM catalog_printing WHERE source_id='test-2'").fetchone()['id']
        editions = {row['finish']: row['id'] for row in conn.execute(
            "SELECT id,descriptor->>'finish' AS finish FROM catalog_edition WHERE printing_id=%s",
            (printing,)).fetchall()}
        review = conn.execute("""INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail)
          VALUES (%s,'test-2','variant_ambiguity','decide-states','Finish correction') RETURNING id""",
          (printing,)).fetchone()['id']
    return {
        'owner': owner, 'review': review,
        'path': f'/api/admin/catalog-reviews/{review}/decision',
        'body': {
            'decision': 'deprecate_edition', 'reason': 'Physical finish corrected',
            'evidence_url': 'https://example.org/foil', 'evidence_digest': shown(owner, review),
            'edition_id': str(editions['normal']), 'replacement_edition_id': str(editions['reverse']),
        },
    }


def decision_state(review):
    """Persisted review, revision and catalog side effects, including audit fields."""
    with connect() as conn:
        return {
            'review': conn.execute('SELECT * FROM catalog_review WHERE id=%s', (review,)).fetchone(),
            'state': conn.execute('SELECT * FROM catalog_state WHERE singleton').fetchone(),
            'clock': conn.execute('SELECT * FROM catalog_public_clock WHERE singleton').fetchone(),
            'edition_replacements': conn.execute('SELECT * FROM catalog_edition_replacement ORDER BY edition_id').fetchall(),
            'printing_replacements': conn.execute('SELECT * FROM catalog_printing_replacement ORDER BY printing_id').fetchall(),
            'references': conn.execute('SELECT * FROM catalog_source_reference ORDER BY source_id').fetchall(),
            'editions': conn.execute('SELECT * FROM catalog_generation_edition ORDER BY generation_id,edition_id').fetchall(),
            'metadata': conn.execute('SELECT * FROM catalog_edition_metadata ORDER BY edition_id').fetchall(),
            'outbox': conn.execute('SELECT * FROM catalog_public_outbox ORDER BY sequence').fetchall(),
        }


@pytest.mark.parametrize('decision,status', [('keep_existing', 'retained'), ('deprecate_edition', 'corrected')])
@pytest.mark.parametrize('replay', ['identical', 'different_decision'])
def test_second_decision_is_refused_without_changing_the_resolved_review(pending_review, decision, status, replay):
    world = pending_review
    before = decision_state(world['review'])
    assert before['review']['status'] == 'pending'
    body = {**world['body'], 'decision': decision}
    first = call('POST', world['path'], world['owner'], body)
    assert first.status_code == 200, first.text
    assert first.json()['status'] == status
    resolved = decision_state(world['review'])
    assert resolved['review']['status'] == status
    assert resolved['review']['reviewer_id'] == world['owner']
    assert resolved['review']['reason'] == body['reason']
    assert resolved['review']['evidence_url'] == body['evidence_url']
    assert resolved['review']['reviewed_at'] is not None
    assert resolved['state']['revision'] == before['state']['revision'] + 1
    if decision == 'deprecate_edition':
        assert len(resolved['edition_replacements']) == 1
        assert str(resolved['edition_replacements'][0]['edition_id']) == body['edition_id']
        assert str(resolved['edition_replacements'][0]['replacement_edition_id']) == body['replacement_edition_id']
        assert not next(row['active'] for row in resolved['editions'] if str(row['edition_id']) == body['edition_id'])
    if replay == 'different_decision':
        body = {**body, 'decision': 'keep_existing' if decision == 'deprecate_edition' else 'deprecate_edition',
                'reason': 'A later decision', 'evidence_url': 'https://example.org/later'}
    second = call('POST', world['path'], world['owner'], body)
    assert second.status_code == 409, second.text
    assert second.json()['detail'] == {'code': 'REVIEW_ALREADY_RESOLVED'}
    assert decision_state(world['review']) == resolved


def test_failure_before_decide_returns_rolls_back_all_writes_and_allows_retry(pending_review, monkeypatch):
    world = pending_review
    before = decision_state(world['review'])
    built_responses = []
    original_view = reconciliation.view

    def fail_response(row):
        # Response construction is inside the transaction, after the replacement,
        # Edition deactivation, resolved review and catalog revision were written.
        built_responses.append(original_view(row))
        raise RuntimeError('injected decision response failure')

    with monkeypatch.context() as patch:
        patch.setattr(reconciliation, 'view', fail_response)
        with pytest.raises(RuntimeError, match='injected decision response failure'):
            reconciliation.decide(world['review'], reconciliation.CatalogDecision(**world['body']), world['owner'])
    assert len(built_responses) == 1
    assert built_responses[0].status == 'corrected'
    assert decision_state(world['review']) == before
    retried = call('POST', world['path'], world['owner'], world['body'])
    assert retried.status_code == 200, retried.text
    assert retried.json()['status'] == 'corrected'
    after = decision_state(world['review'])
    assert after['state']['revision'] == before['state']['revision'] + 1
    assert len(after['edition_replacements']) == 1
