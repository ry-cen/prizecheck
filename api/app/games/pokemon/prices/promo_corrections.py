"""Explicit, reviewed SVP repairs. Imported by operator commands, never by a job.

Preflight is read-only. Decisions retain the owner's audit trail and optimistic
evidence checks; each commits separately. A retry skips already-effective values.
"""
from app.db import connect
from app.identity import require_owner
from .catalog_targets import MatchingRulesV3, number_key, rule_projection
from .metadata_reviews import MetadataDecisionInput, decide, load_target, plan_marketplace
from .price_binding import join_spawned_rebinds, rebind
from .price_import import ADVISORY_LOCK as PRICE_IMPORT_LOCK
from . import public_prices

PROMO_CORRECTION_LOCK = 914714  # Explicit promo commands only; separate from the price publication lock.


def repair_promo(owner, *, source_id, card_name, number, corrections, source_products, evidence_url, reason, apply=False):
    arguments = dict(source_id=source_id, card_name=card_name, number=number, corrections=corrections,
                     source_products=source_products, evidence_url=evidence_url, reason=reason)
    if not apply:
        return _repair_promo(owner, **arguments)
    # Session lock survives each separately committed owner decision. Closing the
    # connection releases it on success, interruption or failure. Never wait/retry blindly.
    with connect(autocommit=True) as lock_conn:
        if not lock_conn.execute('SELECT pg_try_advisory_lock(%s) AS acquired',
                                 (PROMO_CORRECTION_LOCK,)).fetchone()['acquired']:
            raise RuntimeError('Another reviewed promo correction is already running; inspect state before retrying')
        # The daily importer holds this same session lock across product writes and
        # its post-import steps. Never take the catalog clock on this connection:
        # decide() owns it on its own connection, after these nonblocking locks.
        if not lock_conn.execute('SELECT pg_try_advisory_lock(%s) AS acquired',
                                 (PRICE_IMPORT_LOCK,)).fetchone()['acquired']:
            raise RuntimeError('A price import is already running; inspect state before retrying')
        return _repair_promo(owner, **arguments, apply=True)


def _reviewed_source(loaded, original, desired):
    """Pin matching inputs, while ignoring enrichment the matching rule ignores.

    The reviewed defect and an already-correct upstream product are the only
    accepted projections. New quote-product inputs, card fallbacks, missing
    variants and unresolved correspondence require renewed review.
    """
    projection = rule_projection(loaded['source_candidate'])
    if type(projection.get('third_party_tcgplayer')) is not int or projection not in [
            {'correspondence': 'source_candidate', 'products': {}, 'third_party_tcgplayer': product}
            for product in {original, desired}]:
        raise ValueError('Marketplace source evidence changed; renewed review required')
    return projection['third_party_tcgplayer']


def _reviewed_state(conn, loaded, source_product, desired):
    """Allow original rule states or effective approvals, never supersede an owner."""
    latest = conn.execute("""SELECT decision,reviewed_value FROM catalog_metadata_decision
      WHERE target='marketplace' AND edition_id=%s ORDER BY clock_revision DESC,id DESC LIMIT 1""",
                          (loaded['edition_id'],)).fetchone()
    current = loaded['reviewed_value']
    source_quote = MatchingRulesV3.finish_key(MatchingRulesV3.plain(loaded['descriptor']))
    unchanged = (loaded['state'] == 'verified' and current['product_id'] == desired
                 and current['quote_variant'] in (None, source_quote))
    if latest:
        if (not unchanged or latest['decision'] not in ('correct', 'verify_source')
                or latest['reviewed_value'] != current):
            raise ValueError('Owner decision or quarantine requires renewed review; correction stopped')
    elif loaded['state'] == 'verified':
        if current['product_id'] != source_product or current['quote_variant'] not in (None, source_quote):
            raise ValueError('Unexpected current mapping; renewed review required')
    elif (loaded['state'] != 'unverified' or loaded['reason'] not in
          ('no_matching_rule', 'rule_failed', 'duplicate_mapping')
          or loaded['row']['auto_closed'] or loaded['rejected_fingerprints']
          or loaded['row']['product_id'] is not None or loaded['row']['quote_variant'] is not None):
        raise ValueError('Owner decision or quarantine requires renewed review; correction stopped')
    return unchanged


def _repair_promo(owner, *, source_id, card_name, number, corrections, source_products, evidence_url, reason, apply=False):
    targets = []
    with connect() as conn:
        conn.execute('SET TRANSACTION READ ONLY')
        require_owner(conn, owner)
        rows = conn.execute("""SELECT e.id,e.descriptor,pm.source_record FROM catalog_edition e
          JOIN catalog_printing p ON p.id=e.printing_id
          JOIN catalog_printing_metadata pm ON pm.printing_id=p.id
          WHERE p.source='tcgdex' AND p.source_id=%s""", (source_id,)).fetchall()
        for (descriptor, product, name), original in zip(corrections, source_products, strict=True):
            hits = [r for r in rows if MatchingRulesV3.plain(r['descriptor']) == descriptor]
            if len(hits) != 1:
                raise ValueError('Expected exactly one Edition for each reviewed descriptor')
            record = hits[0]['source_record'] or {}
            if (record.get('id') != source_id or record.get('name') != card_name
                    or (record.get('set') or {}).get('id') != 'svp'
                    or number_key(record.get('localId')) != number_key(number)):
                raise ValueError('Review changed catalog name/number/set source evidence before correcting')
            actual = conn.execute('SELECT name,group_id,number FROM tcgplayer_product WHERE product_id=%s',
                                  (product,)).fetchone()
            if (not actual or actual['name'] != name or actual['group_id'] != 22872
                    or number_key(actual['number']) != number_key(number)):
                raise ValueError('Import TCGCSV products and review changed name/number/group evidence before correcting')
            loaded = load_target(conn, 'edition', hits[0]['id'])
            if (not loaded or loaded['name'] != card_name or loaded['set_id'] != 'svp'
                    or number_key(loaded['collector_number']) != number_key(number)):
                raise ValueError('Review changed catalog name/number/set evidence before correcting')
            source_product = _reviewed_source(loaded, original, product)
            unchanged = _reviewed_state(conn, loaded, source_product, product)
            desired = {'product_id': product, 'quote_variant': None}
            command = MetadataDecisionInput(
                target='marketplace', printing_id=loaded['printing_id'], edition_id=loaded['edition_id'],
                decision='correct', reviewed_value=desired, basis_revision=loaded['basis_revision'],
                evidence_digest=loaded['evidence_digest'], evidence_url=evidence_url, reason=reason)
            # Check every target, including duplicate-product conflicts, before saving any decision.
            plan_marketplace(conn, command, loaded)
            targets.append((loaded, command, unchanged))
    for loaded, command, unchanged in targets:
        action = 'already correct; skip' if unchanged else ('apply' if apply else 'would correct')
        print(f'{loaded["edition_id"]} {loaded["descriptor"]}: {loaded["reviewed_value"]} -> '
              f'{command.reviewed_value}; {action}; revision={loaded["basis_revision"]}; '
              f'evidence={loaded["evidence_digest"]}')
        if apply and not unchanged:
            result = decide(command, user_id=owner)
            print(f'decision={result.decision_id}; state={result.state}; '
                  f'mapping_revision={result.mapping_revision}; catalog_delivery={result.public_delivery}')
    if apply:
        # Even a no-op retry repairs a failed post-commit price rebind/publication.
        join_spawned_rebinds()
        try:
            with connect() as conn:
                counts = rebind(conn)
                print(f'rebind={counts}', flush=True)
                published = public_prices.publish(conn)
            print(f'price_publication={published}')
        except Exception as error:
            raise RuntimeError('Decisions may be saved; inspect state, rerun --rebind-only and verify publication') from error
