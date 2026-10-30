"""Operate the regenerable art store. Run through prizecheck-deploy.sh tool."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import psycopg  # noqa: E402
from app.db import connect  # noqa: E402
from app.art_storage import storage  # noqa: E402
from app.games.pokemon.art.hosts import TCGPLAYER_LARGE  # noqa: E402
from app.games.pokemon.art.route import tcgplayer_source_enabled  # noqa: E402


def purge_tcgplayer():
    if tcgplayer_source_enabled():
        print('Set ART_TCGPLAYER_SOURCE=off before purging TCGplayer art.', file=sys.stderr)
        return 2
    try:
        with connect() as conn, conn.transaction():
            rows = [r for r in conn.execute('SELECT printing_id,size,source_url,storage_key FROM art_object')
                    if TCGPLAYER_LARGE.fullmatch(r['source_url'])]
            for row in rows:
                conn.execute('DELETE FROM art_object WHERE printing_id=%s AND size=%s', (row['printing_id'], row['size']))
            comparisons = conn.execute('DELETE FROM art_large_upgrade').rowcount
    except psycopg.Error:
        print('Art could not be purged; check the database.', file=sys.stderr)
        return 1
    deleted = 0
    for row in rows:
        try:
            storage().delete(row['storage_key'])
            deleted += 1
        except (OSError, ValueError):
            pass
    print(f'Purged {len(rows)} objects, {deleted} files and {comparisons} comparisons.')
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['purge-tcgplayer'])
    parser.parse_args()
    return purge_tcgplayer()


if __name__ == '__main__':
    sys.exit(main())
