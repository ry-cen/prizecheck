"""Record reviewed Charmander SVP 044 marketplace corrections using the owner service.

Run in the API environment: python scripts/correct_charmander_svp044.py --owner USER_ID [--apply].
The default is read-only. An already-correct Pokemon Center mapping is skipped.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))

from app.games.pokemon.prices.promo_corrections import repair_promo  # noqa: E402

EVIDENCE = 'https://tcgcsv.com/tcgplayer/3/22872/products'
SOURCE_PRODUCTS = (477182, 512036)  # Reviewed regular / Pokemon Center source evidence, 2026-11-04.
CORRECTIONS = (({'type': 'holo', 'size': 'standard'}, 512035, 'Charmander - 044'),
               ({'type': 'holo', 'size': 'standard', 'stamp': ['pokemon-center']},
                512036, 'Charmander - 044 (Pokemon Center Exclusive)'))


def repair(owner, *, apply=False):
    repair_promo(owner, source_id='svp-044', card_name='Charmander', number='044', corrections=CORRECTIONS,
                 source_products=SOURCE_PRODUCTS, evidence_url=EVIDENCE,
                 reason='Reviewed 2026-11-04: TCGdex regular Charmander SVP 044 points to Fuecoco SVP 002 (477182); '
                        'TCGCSV names and numbers identify regular 512035 and Pokemon Center 512036.', apply=apply)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owner', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    repair(args.owner, apply=args.apply)
