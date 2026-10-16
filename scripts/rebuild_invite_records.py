"""Rebuild the public Invite Link records (social network #246) in the shared records store from PostgreSQL.

Run it after scripts/init_public_records.py whenever the records store was lost, re-initialized empty or restored
from an older copy, or PostgreSQL was restored to a point older than the store. It queues a write of every collector's
current Invite Link record (their Display Name, keyed by the token's hash) and drains the queue, so a second run writes
the same values again. Records of links replaced before the loss are not recreated. It never touches Published Decks,
discovery or the catalog records.

Exit codes: 0 rebuilt, 1 the store or database is unreachable or the drain could not finish (run it again).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import psycopg  # noqa: E402
from app.main import connect  # noqa: E402
from app.social.profile import drain_invites  # noqa: E402


def main():
    try:
        with connect() as conn, conn.transaction():
            # The drain's own lock: no drain runs while the rebuild queues, so every queued write follows the rows read.
            conn.execute("SELECT pg_advisory_xact_lock(hashtext('prizecheck.invite_projection'))")
            queued = conn.execute("""INSERT INTO invite_projection_outbox(token_hash,display_name)
              SELECT l.token_hash,p.display_name FROM invite_link l JOIN collector_profile p USING (user_id)""").rowcount
    except psycopg.Error:
        print('The database is unreachable; nothing was changed.', file=sys.stderr)
        return 1
    if not drain_invites():
        print('The records store could not be written; run this again.', file=sys.stderr)
        return 1
    print(f'rebuilt {queued} invite records')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
