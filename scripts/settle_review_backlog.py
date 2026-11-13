"""Plan obsolete Pokémon review settlements; --apply writes the owner-authorized plan."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))

from app.games.pokemon.catalog.review_settlement import settle_backlog  # noqa: E402


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owner', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    settle_backlog(args.owner, apply=args.apply)
