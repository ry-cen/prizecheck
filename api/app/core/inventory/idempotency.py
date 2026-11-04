"""Idempotency bookkeeping shared by the commands that record a ``mutation_request``."""


def expire(conn, owner_id):
    """Deletes this owner's expired idempotency records, in the caller's transaction."""
    conn.execute("DELETE FROM mutation_request WHERE owner_id=%s AND expires_at <= now()", (owner_id,))
