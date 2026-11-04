"""Record the reviewed #471 marketplace corrections using the owner decision service.

Run in the API environment: python scripts/correct_eevee_svp173.py --owner USER_ID [--apply].
The default only displays the proposed corrections. No catalog source or matching rule is changed.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))

from app.games.pokemon.prices.promo_corrections import repair_promo  # noqa: E402

EVIDENCE = 'https://tcgcsv.com/tcgplayer/3/22872/products'
SOURCE_PRODUCTS = (610757, 610758)  # Reviewed regular / Pokemon Center source defect, 2026-11-04.
CORRECTIONS = (({'type': 'holo', 'size': 'standard'}, 610758, 'Eevee - 173'),
               ({'type': 'holo', 'size': 'standard', 'stamp': ['pokemon-center']},
                610757, 'Eevee - 173 (Pokemon Center Exclusive)'))


def repair(owner, *, apply=False):
    repair_promo(owner, source_id='svp-173', card_name='Eevee', number='173', corrections=CORRECTIONS,
                 source_products=SOURCE_PRODUCTS, evidence_url=EVIDENCE,
                 reason='Reviewed #471: TCGdex swaps regular and Pokemon Center Eevee SVP 173 product IDs; '
                        'TCGCSV names and numbers identify the editions.', apply=apply)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owner', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    repair(args.owner, apply=args.apply)
