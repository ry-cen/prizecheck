"""Bind each verified Edition to one TCGplayer product subtype (ADR 0019, design section 4.3).

The product is the reviewed mapping (`catalog_edition_metadata.product_id` while verified); the subtype is derived here by
the pure `sub_type_for` and stored in `edition_price_binding`. `rebind` is always a full pass over the catalog, because the
shared-price guard needs every Edition that holds a product. Readers require the binding's product and mapping revision to
match the mapping, so a stale binding leaves an Edition unpriced and never prices it from the wrong product.
"""
import logging
import threading

from .catalog_targets import MatchingRulesV3, is_unspecified

log = logging.getLogger(__name__)

PRICE_LOCK = 914713  # "price publication"; public_prices.publish holds the same lock
FIRST_EDITION = "1st-edition"
NAMES = {("holo", True): ("1st Edition Holofoil",), ("holo", False): ("Holofoil", "Unlimited Holofoil"),
         ("normal", True): ("1st Edition",), ("normal", False): ("Normal", "Unlimited"),
         ("reverse", False): ("Reverse Holofoil",)}
FINISH = {"holo": "holo", "normal": "normal", "reverse": "reverse"}  # legacy {"finish": ...} descriptors use the same words
KNOWN = {"type", "finish", "size", "subtype", "stamp"}  # thirdParty is already dropped by plain()
REASONS = ("no_product_rows", "uncovered_variant", "ambiguous", "shared_price", "unspecified_variant")
CHUNK = 5000


def stamps_of(plain):
    stamp = plain.get("stamp")
    if stamp is None:
        return []
    return stamp if isinstance(stamp, list) else [stamp]


def special(plain) -> bool:
    """True for any facet beyond a finish, the standard size, unlimited/shadowless and the 1st Edition stamp."""
    return (bool(set(plain) - KNOWN) or plain.get("subtype") not in (None, "unlimited", "shadowless")
            or any(s != FIRST_EDITION for s in stamps_of(plain)))


def sub_type_for(descriptor, offered: frozenset[str]) -> tuple[str | None, str | None]:
    """(sub_type_name, None) or (None, reason). Pure."""
    return _sub_type(descriptor, offered)[:2]


def _sub_type(descriptor, offered: frozenset[str]):
    """(sub_type_name, reason, fallback): fallback is True when the only offered Normal/Holofoil row was taken for a
    mislabelled finish rather than named by the descriptor."""
    plain = MatchingRulesV3.plain(descriptor)
    if not isinstance(plain, dict) or is_unspecified(plain):
        return None, "unspecified_variant", False
    if plain.get("size", "standard") != "standard":
        return None, "uncovered_variant", False
    kind = plain.get("type", plain.get("finish"))
    finish = FINISH.get(kind) if isinstance(kind, str) else None
    first = FIRST_EDITION in [s for s in stamps_of(plain) if isinstance(s, str)]
    extra = special(plain)
    names = NAMES.get((finish, first))
    if names is None:
        return None, "uncovered_variant", False
    if not offered:
        return None, "no_product_rows", False
    hits = [name for name in names if name in offered]
    if len(hits) == 1:
        return hits[0], None, False
    if hits:
        return None, "ambiguous", False
    # TCGdex sometimes labels a promo's finish wrongly: an ordinary normal/holo Edition takes the product's only price.
    if not first and not extra and finish in ("normal", "holo") and len(offered) == 1 \
            and next(iter(offered)) in ("Normal", "Holofoil"):
        return next(iter(offered)), None, True
    return None, "uncovered_variant", False


def resolve(rows):
    """[(edition_id, product_id, revision, sub_type_name, reason, has_price)] for the verified Edition rows.

    Pure over rows shaped {id, descriptor, product_id, mapping_revision, offered: {sub_type_name: has_positive_price}}."""
    resolved = []
    for row in rows:
        offered = row["offered"] or {}
        sub, reason, fallback = _sub_type(row["descriptor"], frozenset(offered))
        resolved.append([row["id"], row["product_id"], row["mapping_revision"], sub, reason, bool(sub and offered.get(sub)),
                         row["descriptor"], fallback])
    # Shared-price guard: one product row cannot price two physical Editions.
    holders = {}
    for item in resolved:
        if item[3]:
            holders.setdefault((item[1], item[3]), []).append(item)
    for group in holders.values():
        if len(group) > 1:
            exact = [item for item in group if not item[7]]
            # One exact hit keeps the row; Editions that only fell back to it are unbound. Any other collision unbinds all.
            for item in (group if len(exact) != 1 else [item for item in group if item[7]]):
                item[3], item[4], item[5] = None, "shared_price", False
    # Special Editions are priced only from a product no other verified Edition holds.
    on_product = {}
    for item in resolved:
        on_product[item[1]] = on_product.get(item[1], 0) + 1
    for item in resolved:
        plain = MatchingRulesV3.plain(item[6])
        if item[3] and isinstance(plain, dict) and special(plain) and on_product[item[1]] > 1:
            item[3], item[4], item[5] = None, "shared_price", False
    return [tuple(item[:6]) for item in resolved]


def rebind(conn) -> dict[str, int]:
    """Recompute every verified Edition's binding. One transaction; the caller commits if it passed an open transaction.

    Returns {"verified", "bound", "priced", <reason>: count for every reason}. `priced` counts bound Editions whose
    product row has a market price above zero."""
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(%s)", (PRICE_LOCK,))
        # One statement, so the Editions and the offered subtypes come from one snapshot even under READ COMMITTED.
        rows = conn.execute("""SELECT e.id, e.descriptor, m.product_id, m.mapping_revision,
          (SELECT jsonb_object_agg(p.sub_type_name, coalesce(p.market_price > 0, false)) FROM tcgplayer_price p
            WHERE p.product_id = m.product_id) AS offered
          FROM catalog_edition_metadata m JOIN catalog_edition e ON e.id = m.edition_id
          WHERE m.mapping_state = 'verified' AND m.product_id IS NOT NULL""").fetchall()
        current = {r["edition_id"]: (r["product_id"], r["mapping_revision"], r["sub_type_name"], r["reason"])
                   for r in conn.execute("SELECT edition_id, product_id, mapping_revision, sub_type_name, reason "
                                         "FROM edition_price_binding")}
        resolved = resolve(rows)
        wanted = {item[0] for item in resolved}
        changed = [item for item in resolved if current.get(item[0]) != item[1:5]]
        gone = [edition for edition in current if edition not in wanted]
        for start in range(0, len(gone), CHUNK):
            conn.execute("DELETE FROM edition_price_binding WHERE edition_id = ANY(%s)", (gone[start:start + CHUNK],))
        for start in range(0, len(changed), CHUNK):
            part = changed[start:start + CHUNK]
            conn.execute("""INSERT INTO edition_price_binding(edition_id, product_id, mapping_revision, sub_type_name, reason)
              SELECT * FROM unnest(%s::uuid[], %s::int[], %s::bigint[], %s::text[], %s::text[])
              ON CONFLICT (edition_id) DO UPDATE SET product_id = EXCLUDED.product_id,
                mapping_revision = EXCLUDED.mapping_revision, sub_type_name = EXCLUDED.sub_type_name,
                reason = EXCLUDED.reason, bound_at = now()""",
                         ([i[0] for i in part], [i[1] for i in part], [i[2] for i in part],
                          [i[3] for i in part], [i[4] for i in part]))
    counts = {reason: 0 for reason in REASONS}
    for item in resolved:
        if item[4]:
            counts[item[4]] += 1
    bound = [item for item in resolved if item[3]]
    return {"verified": len(resolved), "bound": len(bound), "priced": sum(1 for item in bound if item[5]), **counts}


def rebind_best_effort(conn=None):
    """The post-commit step of promotion, owner decisions and rule activations: rebind, then publish the public price
    records (full, differences only). Each is logged and never raised; a failed publish does not hide the rebind counts.
    Uses its own connection unless one is given. Returns the counts or None."""
    try:
        if conn is None:
            from app.db import connect
            with connect() as own:
                counts = rebind(own)
                _publish(own)
                return counts
        counts = rebind(conn)
    except Exception as error:  # a failed rebind leaves Editions unpriced until the next one; it never fails its caller
        log.warning("Price rebind failed (%s)", type(error).__name__)
        return None
    _publish(conn)
    return counts


_worker_lock = threading.Lock()
_worker: threading.Thread | None = None  # the one running rebind thread, if any
_dirty = False  # a request arrived while the worker was running; it owes one more pass
_idle = threading.Event()
_idle.set()


def _worker_loop():
    global _worker, _dirty
    while True:
        try:
            rebind_best_effort()
        except Exception as error:  # rebind_best_effort logs its own failures; this keeps the worker serving requests
            log.warning("Price rebind worker pass failed (%s)", type(error).__name__)
        with _worker_lock:
            if not _dirty:
                _worker = None  # decided under the lock: a request after this starts a new worker
                _idle.set()
                return
            _dirty = False


def spawn_rebind():
    """Ask for a rebind and publish after the caller's commit, for callers inside an HTTP request: they wait on the
    price lock and must not hold the owner's response. One coalescing daemon worker runs at a time (one connection);
    a request while it runs only marks it dirty, so a burst costs the running pass plus one more. Returns at once."""
    global _worker, _dirty
    with _worker_lock:
        if _worker is not None:
            _dirty = True
            return
        _idle.clear()
        _worker = threading.Thread(target=_worker_loop, daemon=True, name="price-rebind")
        _worker.start()


def join_spawned_rebinds(timeout=60.0):
    """Test seam: wait until the rebind worker is idle, including a queued pass."""
    _idle.wait(timeout)


def _publish(conn):
    from . import public_prices
    try:
        public_prices.publish(conn)
    except Exception as error:  # the records catch up on the next publish
        log.warning("Price publish failed (%s)", type(error).__name__)
