"""Record the reviewed #471 marketplace corrections using the owner decision service.

Run in the API environment: python scripts/correct_eevee_svp173.py --owner USER_ID [--apply].
The default only displays the proposed corrections. No catalog source or matching rule is changed.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))

from app.db import connect  # noqa: E402
from app.catalog_targets import MatchingRulesV3  # noqa: E402
from app.metadata_reviews import MetadataDecisionInput, decide, load_target  # noqa: E402
from app.price_binding import join_spawned_rebinds, rebind_best_effort  # noqa: E402

EVIDENCE = 'https://tcgcsv.com/tcgplayer/3/22872/products'
CORRECTIONS = (({'type': 'holo', 'size': 'standard'}, 610758, 'Eevee - 173'),
               ({'type': 'holo', 'size': 'standard', 'stamp': ['pokemon-center']},
                610757, 'Eevee - 173 (Pokemon Center Exclusive)'))


def repair(owner, *, apply=False):
    with connect() as conn:
        rows = conn.execute("""SELECT e.id,e.descriptor FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
          WHERE p.source='tcgdex' AND p.source_id='svp-173'""").fetchall()
        targets = []
        for descriptor, product, name in CORRECTIONS:
            hits = [r for r in rows if MatchingRulesV3.plain(r['descriptor']) == descriptor]
            if len(hits) != 1:
                raise ValueError('Expected exactly one Edition for each reviewed descriptor')
            actual = conn.execute('SELECT name,group_id FROM tcgplayer_product WHERE product_id=%s', (product,)).fetchone()
            if not actual or actual['name'] != name or actual['group_id'] != 22872:
                raise ValueError('Import current TCGCSV products and review changed evidence before correcting')
            targets.append((hits[0]['id'], product))
    for edition, product in targets:
        with connect() as conn:
            loaded = load_target(conn, 'edition', edition)
        print(f'{edition}: {loaded["reviewed_value"]} -> {product}')
        if apply:
            decide(MetadataDecisionInput(target='marketplace', printing_id=loaded['printing_id'], edition_id=edition,
                   decision='correct', reviewed_value={'product_id': product, 'quote_variant': None},
                   basis_revision=loaded['basis_revision'], evidence_digest=loaded['evidence_digest'], evidence_url=EVIDENCE,
                   reason='Reviewed #471: TCGdex swaps regular and Pokemon Center Eevee SVP 173 product IDs; TCGCSV names identify the editions.'),
                   user_id=owner)
    if apply:
        join_spawned_rebinds()
        if rebind_best_effort() is None:
            raise RuntimeError('Decisions saved; price rebind failed, rerun --rebind-only')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owner', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    repair(args.owner, apply=args.apply)
