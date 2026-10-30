"""Operate the regenerable art store. Run through prizecheck-deploy.sh tool."""
import argparse
import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import psycopg  # noqa: E402
from app.db import connect  # noqa: E402
from app.core.art.public import write_pointer, delete_pointer  # noqa: E402
from app.art_storage import storage  # noqa: E402
from app.games.pokemon.art.hosts import TCGPLAYER_LARGE  # noqa: E402
from app.games.pokemon.art.route import tcgplayer_source_enabled  # noqa: E402


def purge_tcgplayer():
    if tcgplayer_source_enabled():
        print('Set ART_TCGPLAYER_SOURCE=off before purging TCGplayer art.', file=sys.stderr)
        return 2
    try:
        with connect() as conn, conn.transaction():
            rows = [r for r in conn.execute('SELECT a.*,p.public_ref FROM art_object a JOIN catalog_printing p ON p.id=a.printing_id')
                    if TCGPLAYER_LARGE.fullmatch(r['source_url'])]
            removed = []
            for row in rows:
                deleted = conn.execute('DELETE FROM art_object WHERE printing_id=%s AND size=%s AND source_url=%s AND storage_key=%s RETURNING storage_key',
                                       (row['printing_id'], row['size'], row['source_url'], row['storage_key'])).fetchone()
                if deleted is not None:
                    removed.append(row)
            rows = removed
            comparisons = conn.execute('DELETE FROM art_large_upgrade').rowcount
    except psycopg.Error:
        print('Art could not be purged; check the database.', file=sys.stderr)
        return 1
    deleted = 0
    for row in rows:
        try:
            delete_pointer(row['public_ref'], row['size'])
            storage().delete(row['storage_key'])
            deleted += 1
        except (OSError, ValueError):
            pass
    print(f'Purged {len(rows)} objects, {deleted} files and {comparisons} comparisons.')
    return 0


def pointers():
    written = deleted = skipped = 0
    with connect() as conn:
        rows = conn.execute('SELECT a.*,p.public_ref FROM art_object a JOIN catalog_printing p ON p.id=a.printing_id').fetchall()
        for row in rows:
            while row is not None:
                if row['storage_key'].split('/')[0] == 'tcgplayer' and not tcgplayer_source_enabled():
                    skipped += 1
                    break
                try:
                    data = storage().get(row['storage_key'])
                    if data is None or hashlib.sha256(data).hexdigest() != row['sha256']:
                        delete_pointer(row['public_ref'], row['size'])
                        deleted += 1
                        break
                    write_pointer(row['public_ref'], row['size'], storage_key=row['storage_key'],
                                  sha256=row['sha256'], content_type=row['content_type'])
                    written += 1
                    current = conn.execute('SELECT a.*,p.public_ref FROM art_object a JOIN catalog_printing p ON p.id=a.printing_id WHERE a.printing_id=%s AND a.size=%s',
                                           (row['printing_id'], row['size'])).fetchone()
                    if current is None:
                        delete_pointer(row['public_ref'], row['size'])
                        deleted += 1
                        break
                    if current['sha256'] == row['sha256']:
                        break
                    row = current
                except (OSError, ValueError):
                    delete_pointer(row['public_ref'], row['size'])
                    deleted += 1
                    break
    print(f'Pointers: {written} written, {deleted} deleted, {skipped} skipped.')
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['purge-tcgplayer', 'pointers'])
    args = parser.parse_args()
    return pointers() if args.command == 'pointers' else purge_tcgplayer()


if __name__ == '__main__':
    sys.exit(main())
