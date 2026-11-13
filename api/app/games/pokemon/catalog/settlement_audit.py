"""Append-only evidence for automated catalog settlements."""
import json


def record_settlement(conn, *, subject, action, before: dict, after: dict, review_id=None,
                      edition_id=None, printing_id=None, actor_id=None) -> None:
    conn.execute("""INSERT INTO catalog_auto_settlement
      (subject,action,before,after,review_id,edition_id,printing_id,actor_id,trigger)
      VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                 (subject, action, json.dumps(before, default=str), json.dumps(after, default=str),
                  review_id, edition_id, printing_id, actor_id, 'command' if actor_id else 'automatic'))
