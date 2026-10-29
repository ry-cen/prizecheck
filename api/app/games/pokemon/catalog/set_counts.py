"""Per-set card counts (migration 150, scanner plumbing D6), read from TCGdex card records.

Each record's ``set.cardCount`` is ``{official, total}``. Per set, the pair most records carry wins, the larger
``official`` breaks a tie, and a set with no integer pair has no row. Shared by import_catalog and
scripts/backfill_set_counts.py so both fill the table the same way.
"""
from collections import Counter


def _integer(value):
    # Within the integer column's range, so an oversized count is no pair rather than a failed promotion.
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 2_147_483_647


def record_pair(record):
    """The record's (set_id, official, total), or None when it has no set id or no integer pair."""
    set_data = record.get("set") if isinstance(record, dict) else None
    if not isinstance(set_data, dict):
        return None
    set_id, pair = set_data.get("id"), set_data.get("cardCount")
    if not isinstance(set_id, str) or not 1 <= len(set_id) <= 80 or not isinstance(pair, dict):
        return None
    official, total = pair.get("official"), pair.get("total")
    return (set_id, official, total) if _integer(official) and _integer(total) else None


def carries_card_count(records):
    """True when any record has a set.cardCount at all, whatever its values."""
    return any(isinstance(record, dict) and isinstance(record.get("set"), dict) and "cardCount" in record["set"]
               for record in records)


def set_counts(records):
    """{set_id: (official, total)} by the majority rule."""
    votes = {}
    for record in records:
        found = record_pair(record)
        if found:
            votes.setdefault(found[0], Counter())[found[1:]] += 1
    # Most records first, then the larger official, then the larger total so the choice never depends on order.
    return {set_id: max(counter, key=lambda pair: (counter[pair], pair[0], pair[1])) for set_id, counter in votes.items()}


def insert_set_counts(conn, generation_id, counts):
    """Insert rows for one generation; existing rows stay as they are. Returns how many rows were added."""
    if not counts:
        return 0
    ids = sorted(counts)
    return conn.execute("""INSERT INTO catalog_generation_set_count(generation_id,set_id,official,total)
      SELECT %s,t.set_id,t.official,t.total FROM unnest(%s::text[],%s::int[],%s::int[]) AS t(set_id,official,total)
      ON CONFLICT DO NOTHING""", (generation_id, ids, [counts[i][0] for i in ids], [counts[i][1] for i in ids])).rowcount
