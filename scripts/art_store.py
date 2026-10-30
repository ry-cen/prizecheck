"""Operate the regenerable art store. Run through prizecheck-deploy.sh tool."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import psycopg  # noqa: E402
from app.db import connect  # noqa: E402
from app.core.art.public import delete_pointer  # noqa: E402
from app.core.art.store import lock_pointer, sync_pointer  # noqa: E402
from app.art_storage import storage  # noqa: E402
from app.games.pokemon.art.hosts import TCGPLAYER_LARGE  # noqa: E402
from app.games.pokemon.art.route import tcgplayer_source_enabled  # noqa: E402


def excluded(row):
    return row['storage_key'].split('/')[0] == 'tcgplayer' and not tcgplayer_source_enabled()


def purge_tcgplayer():
    if tcgplayer_source_enabled():
        print('Set ART_TCGPLAYER_SOURCE=off and restart the API before purging TCGplayer art.', file=sys.stderr)
        return 2
    removed = files = 0
    try:
        with connect() as conn:
            identities = [(r['printing_id'], r['size']) for r in conn.execute(
                'SELECT printing_id,size,source_url FROM art_object') if TCGPLAYER_LARGE.fullmatch(r['source_url'])]
        for pid, size in identities:
            with connect() as conn, conn.transaction():
                lock_pointer(conn, pid, size)
                row = conn.execute('SELECT a.*,p.public_ref FROM art_object a JOIN catalog_printing p ON p.id=a.printing_id '
                                   'WHERE a.printing_id=%s AND a.size=%s FOR UPDATE OF a', (pid, size)).fetchone()
                if row is None or not TCGPLAYER_LARGE.fullmatch(row['source_url']):
                    sync_pointer(conn, pid, size, verify_file=False)
                    continue
                deleted = conn.execute('DELETE FROM art_object WHERE printing_id=%s AND size=%s RETURNING storage_key',
                                       (pid, size)).fetchone()
                delete_pointer(row['public_ref'], size)
            removed += 1
            storage().delete(deleted['storage_key'])
            files += 1
        with connect() as conn, conn.transaction():
            comparisons = conn.execute('DELETE FROM art_large_upgrade').rowcount
    except (psycopg.Error, OSError, ValueError):
        print('Art could not be purged; check the database and storage.', file=sys.stderr)
        return 1
    print(f'Purged {removed} objects, {files} files and {comparisons} comparisons.')
    return 0


def pointers():
    counts = dict(written=0, kept=0, deleted=0, skipped=0, failed=0)
    with connect() as conn:
        identities = conn.execute('SELECT printing_id,size FROM art_object').fetchall()
    for row in identities:
        try:
            with connect() as conn, conn.transaction():
                lock_pointer(conn, row['printing_id'], row['size'])
                result = sync_pointer(conn, row['printing_id'], row['size'], verify_file=True, skip=excluded)
            counts[result] += 1
        except (psycopg.Error, OSError, ValueError):
            counts['failed'] += 1
    print('Pointers: ' + ', '.join(f'{count} {name}' for name, count in counts.items()) + '.')
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog="Before purge-tcgplayer, restart the API with ART_TCGPLAYER_SOURCE=off.")
    parser.add_argument('command', choices=['purge-tcgplayer', 'pointers'])
    args = parser.parse_args()
    return pointers() if args.command == 'pointers' else purge_tcgplayer()


if __name__ == '__main__':
    sys.exit(main())
