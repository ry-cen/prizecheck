"""TCGplayer art for Printings without a TCGdex image (ADR 0019, design section 4.8).

`refresh_fallbacks` chooses one TCGplayer product per such Printing and stores it in `catalog_printing_fallback_art`. The
`catalog_printing_art` view (migration 154) is what every image consumer reads: TCGdex's image always wins, and the
fallback applies only when both the active generation and the display carry none. The scanner never reads the view.
"""
import logging

from .catalog_targets import MatchingRulesV3
from .price_binding import PRICE_LOCK, stamps_of

log = logging.getLogger(__name__)
CHUNK = 5000

# Verified Editions of live Printings that have no TCGdex image, with a product that has at least one image.
CANDIDATES = """SELECT a.printing_id, m.product_id, e.descriptor
  FROM catalog_printing_art a
  JOIN catalog_state s ON s.singleton
  JOIN catalog_generation_printing gp ON gp.printing_id = a.printing_id AND gp.generation_id = s.active_generation
  JOIN catalog_edition e ON e.printing_id = a.printing_id
  JOIN catalog_edition_metadata m ON m.edition_id = e.id AND m.mapping_state = 'verified' AND m.product_id IS NOT NULL
  JOIN tcgplayer_product t ON t.product_id = m.product_id AND t.image_count > 0
  WHERE a.tcgdex_url IS NULL AND NOT gp.tombstoned"""


def choose(candidates) -> dict:
    """{printing_id: product_id} from rows of (printing_id, product_id, descriptor). An Edition without a stamp wins, then
    the lowest product id. Pure."""
    best = {}
    for printing_id, product_id, descriptor in candidates:
        plain = MatchingRulesV3.plain(descriptor)
        stamped = bool(isinstance(plain, dict) and stamps_of(plain))
        key = (stamped, product_id)
        if printing_id not in best or key < best[printing_id][0]:
            best[printing_id] = (key, product_id)
    return {printing_id: value[1] for printing_id, value in best.items()}


def refresh_fallbacks(conn) -> int:
    """Bring the fallback table in line with the catalog and the product table; the table's row count afterwards.

    One transaction. Every Printing whose row was added, changed or deleted gets a new public revision, which enqueues it in
    the public catalog outbox so its `catalog:printing` record's image updates."""
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(%s)", (PRICE_LOCK,))
        wanted = choose((r["printing_id"], r["product_id"], r["descriptor"]) for r in conn.execute(CANDIDATES))
        current = {r["printing_id"]: r["product_id"]
                   for r in conn.execute("SELECT printing_id, product_id FROM catalog_printing_fallback_art")}
        gone = [printing for printing in current if printing not in wanted]
        changed = [printing for printing, product in wanted.items() if current.get(printing) != product]
        for start in range(0, len(gone), CHUNK):
            conn.execute("DELETE FROM catalog_printing_fallback_art WHERE printing_id = ANY(%s)", (gone[start:start + CHUNK],))
        for start in range(0, len(changed), CHUNK):
            part = changed[start:start + CHUNK]
            conn.execute("""INSERT INTO catalog_printing_fallback_art(printing_id, product_id)
              SELECT * FROM unnest(%s::uuid[], %s::int[])
              ON CONFLICT (printing_id) DO UPDATE SET product_id = EXCLUDED.product_id, chosen_at = now()""",
                         (part, [wanted[printing] for printing in part]))
        touched = gone + changed
        if touched:
            for start in range(0, len(touched), CHUNK):
                # The enqueue trigger on catalog_printing_metadata fires on the new revision.
                conn.execute("UPDATE catalog_printing_metadata SET public_revision = catalog_begin_correction() "
                             "WHERE printing_id = ANY(%s)", (touched[start:start + CHUNK],))
        total = conn.execute("SELECT count(*) AS n FROM catalog_printing_fallback_art").fetchone()["n"]
    log.info("fallback art: %s Printings, %s changed, %s removed", total, len(changed), len(gone))
    return total
