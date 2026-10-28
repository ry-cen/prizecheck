"""Daily TCGCSV price snapshot import (ADR 0019, design section 4.2): scripts/price_import_job.py calls `main`.

The job reads tcgcsv.com's `last-updated.txt`, the Pokemon group list, and for each group its products and prices. It
upserts per group in one transaction, never deletes, and records one `price_import` row. A group that cannot be read
completely is left exactly as stored; a failed day leaves every stored price as it was. Only this module talks to
tcgcsv.com.

Exit codes: 0 imported, unchanged, or another run holds the lock; 1 the database is unreachable; 2 failed (no group list,
`last-updated.txt` unreadable or older than the stored snapshot); 3 partial (some groups failed, or the source moved).

Environment: DATABASE_URL; PRICE_IMPORT_CONTACT (else SCANNER_INDEX_CONTACT, else OWNER_EMAIL) goes into the User-Agent.
Logs name groups and counts only, never response bodies.
"""
import argparse
import json
import os
import re
import sys
import time
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal

import httpx
import psycopg

BASE_URL = "https://tcgcsv.com"
CATEGORY = 3  # Pokemon
ADVISORY_LOCK = 914712
SPACING_SECONDS = 0.1
TIMEOUT_SECONDS = 30
ATTEMPTS = 3
BACKOFF_SECONDS = (1, 4)
MAX_AMOUNT = Decimal(10) ** 12
MAX_FRACTION_DIGITS = 6
SUBTYPE_VOCABULARY = frozenset({
    "Normal", "Reverse Holofoil", "Holofoil", "1st Edition", "Unlimited", "Unlimited Holofoil", "1st Edition Holofoil"})
PRICE_FIELDS = (("marketPrice", "market_price"), ("lowPrice", "low_price"), ("midPrice", "mid_price"),
                ("highPrice", "high_price"), ("directLowPrice", "direct_low_price"))

OK, UNREACHABLE, FAILED, PARTIAL = 0, 1, 2, 3

sleep = time.sleep  # tests replace this so that spacing and backoff cost nothing


def log(message):
    print(f"price import: {message}", flush=True)


@dataclass
class ImportResult:
    outcome: str  # imported, unchanged, partial, failed, or locked (another run holds the lock; nothing recorded)
    import_id: int | None = None
    source_updated_at: datetime | None = None
    error_code: str | None = None
    groups_total: int = 0
    groups_failed: int = 0
    product_rows: int = 0
    price_rows: int = 0
    rejected_rows: int = 0
    unknown_subtypes: set = field(default_factory=set)

    @property
    def exit_code(self):
        return {"imported": OK, "unchanged": OK, "locked": OK, "partial": PARTIAL, "failed": FAILED}[self.outcome]


class SourceError(Exception):
    """A request could not be completed or its answer is unusable; `code` is recorded as error_code."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


# --- Shared helpers ------------------------------------------------------------------------------------------------------


def number_key(number):
    """The comparison key of a card number: trimmed, uppercase, any "/total" dropped and the leading zeros of the first
    digit run removed (DP05 -> DP5, SWSH001 -> SWSH1, 001 -> 1, XY01 -> XY1; 000 -> 0). None for a missing number.
    tcgplayer_product.number_key is filled with it, and matching rule v4 (design section 4.4) must use the same function."""
    if number is None:
        return None
    text = unicodedata.normalize("NFC", str(number)).strip().split("/", 1)[0].strip().upper()
    if not text:
        return None
    return re.sub(r"\d+", lambda run: run.group().lstrip("0") or "0", text, count=1)


def contact():
    return (os.environ.get("PRICE_IMPORT_CONTACT") or os.environ.get("SCANNER_INDEX_CONTACT")
            or os.environ.get("OWNER_EMAIL"))


def make_client(contact_address, transport=None):
    return httpx.Client(base_url=BASE_URL, timeout=TIMEOUT_SECONDS, follow_redirects=False, trust_env=False,
                        transport=transport, headers={"User-Agent": f"PrizeCheck-prices/1 (+{contact_address})"})


def parse_json(content):
    """JSON with exact decimals: every number is a Decimal, NaN and the infinities included (checked by the caller)."""
    return json.loads(content, parse_float=Decimal, parse_int=Decimal, parse_constant=Decimal)


def clean_amount(value):
    """(ok, amount): None for a JSON null, a Decimal that fits numeric(18,6) otherwise. ok is False for a negative,
    non-finite, >= 10^12 or 7-decimal value, and for anything that is not a JSON number."""
    if value is None:
        return True, None
    if not isinstance(value, Decimal) or not value.is_finite() or value < 0 or value >= MAX_AMOUNT:
        return False, None
    if value.normalize().as_tuple().exponent < -MAX_FRACTION_DIGITS:
        return False, None
    return True, value


def parse_timestamp(text):
    text = text.strip()
    try:
        parsed = datetime.strptime(text, "%Y-%m-%dT%H:%M:%S%z")
    except ValueError:
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            raise SourceError("last_updated_invalid") from None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


# --- Fetching ------------------------------------------------------------------------------------------------------------


class Fetcher:
    """Sequential GETs, spaced 100 ms apart, at most ATTEMPTS tries each (a timeout, transport fault, 429 or 5xx is
    retried after 1 s and then 4 s)."""

    def __init__(self, client):
        self.client = client
        self.requests = 0

    def get(self, path, code):
        if self.requests:
            sleep(SPACING_SECONDS)
        self.requests += 1
        for attempt in range(ATTEMPTS):
            try:
                response = self.client.get(path)
            except httpx.HTTPError:
                response = None
            if response is not None and response.status_code == 200:
                return response.content
            retryable = response is None or response.status_code == 429 or response.status_code >= 500
            if not retryable or attempt == ATTEMPTS - 1:
                break
            sleep(BACKOFF_SECONDS[attempt])
        raise SourceError(code)

    def last_updated(self):
        return parse_timestamp(self.get("/last-updated.txt", "last_updated_unavailable").decode("ascii", "replace"))

    def results(self, path, code):
        """The `results` list of a TCGCSV answer; success must be true."""
        try:
            body = parse_json(self.get(path, code))
        except ValueError:
            raise SourceError(code) from None
        if not isinstance(body, dict) or body.get("success") is not True or not isinstance(body.get("results"), list):
            raise SourceError(code)
        return body["results"]


# --- Storing one group ---------------------------------------------------------------------------------------------------


def product_rows(items, group_id, result):
    """{product_id: (name, number, number_key, image_count)} from a /products answer; malformed rows are rejected."""
    rows = {}
    for item in items:
        pid = item.get("productId") if isinstance(item, dict) else None
        name = item.get("name") if isinstance(item, dict) else None
        if not (isinstance(pid, Decimal) and pid == pid.to_integral_value() and 0 < pid < 2**31) \
                or not isinstance(name, str) or not name.strip():
            result.rejected_rows += 1
            continue
        number = None
        for entry in item.get("extendedData") or []:
            if isinstance(entry, dict) and entry.get("name") == "Number" and isinstance(entry.get("value"), str):
                number = entry["value"].strip() or None
                break
        count = item.get("imageCount")
        count = int(count) if isinstance(count, Decimal) and count == count.to_integral_value() and 0 <= count < 2**31 else 0
        rows[int(pid)] = (name, number, number_key(number), count)
    return rows


def price_rows(items, result):
    """{(product_id, sub_type_name): {column: (ok, amount)}} from a /prices answer; malformed rows are rejected."""
    rows = {}
    for item in items:
        pid = item.get("productId") if isinstance(item, dict) else None
        sub = item.get("subTypeName") if isinstance(item, dict) else None
        if not (isinstance(pid, Decimal) and pid == pid.to_integral_value() and 0 < pid < 2**31) \
                or not isinstance(sub, str) or not 1 <= len(sub) <= 60:
            result.rejected_rows += 1
            continue
        if sub not in SUBTYPE_VOCABULARY:
            result.unknown_subtypes.add(sub)
        rows[(int(pid), sub)] = {column: clean_amount(item.get(source)) for source, column in PRICE_FIELDS}
    return rows


def write_group(conn, group_id, products, prices, snapshot, result):
    """Upserts one group in one transaction, or raises SourceError('group_unusable') without writing: an empty answer where
    rows are stored, or a null burst (more than half of the stored market prices arriving null)."""
    with conn.transaction():
        if not products and conn.execute("SELECT 1 FROM tcgplayer_product WHERE group_id = %s LIMIT 1",
                                         (group_id,)).fetchone():
            raise SourceError("group_unusable")
        if not prices and conn.execute(
                "SELECT 1 FROM tcgplayer_price pr JOIN tcgplayer_product p USING (product_id) WHERE p.group_id = %s LIMIT 1",
                (group_id,)).fetchone():
            raise SourceError("group_unusable")
        stored = {}
        if prices:
            for row in conn.execute(
                    "SELECT product_id, sub_type_name, market_price, low_price, mid_price, high_price, direct_low_price "
                    "FROM tcgplayer_price WHERE product_id = ANY(%s)", (sorted({pid for pid, _ in prices}),)):
                stored[(row["product_id"], row["sub_type_name"])] = row
        had_market = [key for key in prices if key in stored and stored[key]["market_price"] is not None]
        if had_market and sum(1 for key in had_market if prices[key]["market_price"] == (True, None)) * 2 > len(had_market):
            raise SourceError("group_unusable")
        rejected = 0
        for key, fields in prices.items():
            values, bad = [], False
            for _, column in PRICE_FIELDS:
                ok, amount = fields[column]
                if not ok:
                    bad = True
                    amount = stored[key][column] if key in stored else None
                values.append(amount)
            rejected += bad
            conn.execute(
                "INSERT INTO tcgplayer_price(product_id, sub_type_name, market_price, low_price, mid_price, high_price, "
                "direct_low_price, seen_at, source_updated_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                "ON CONFLICT (product_id, sub_type_name) DO UPDATE SET market_price = EXCLUDED.market_price, "
                "low_price = EXCLUDED.low_price, mid_price = EXCLUDED.mid_price, high_price = EXCLUDED.high_price, "
                "direct_low_price = EXCLUDED.direct_low_price, seen_at = EXCLUDED.seen_at, "
                "source_updated_at = EXCLUDED.source_updated_at", (*key, *values, snapshot["seen_at"], snapshot["source"]))
        for pid, (name, number, key, count) in products.items():
            conn.execute(
                "INSERT INTO tcgplayer_product(product_id, group_id, name, number, number_key, image_count, seen_at, "
                "source_updated_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (product_id) DO UPDATE SET "
                "group_id = EXCLUDED.group_id, name = EXCLUDED.name, number = EXCLUDED.number, "
                "number_key = EXCLUDED.number_key, image_count = EXCLUDED.image_count, seen_at = EXCLUDED.seen_at, "
                "source_updated_at = EXCLUDED.source_updated_at",
                (pid, group_id, name, number, key, count, snapshot["seen_at"], snapshot["source"]))
    result.rejected_rows += rejected
    result.product_rows += len(products)
    result.price_rows += len(prices)


# --- The run -------------------------------------------------------------------------------------------------------------


def post_import_steps(conn, result):
    """Binding, art and publishing run after every import, including `unchanged` and `stale_source` runs (design 4.2 step 5).
    CALL LIST: later tickets add their calls here, in this order, each in its own try block so that one failing step never
    stops the next and never changes the import's outcome:
      P3: price_binding.rebind(conn)
      P7: card_art.refresh_fallbacks(conn)
      P5: public_prices.publish(conn)   (best effort; a failure sets price_import.public_error)
    """


def newest_finished(conn):
    return conn.execute("SELECT outcome, source_updated_at FROM price_import WHERE outcome IS NOT NULL "
                        "ORDER BY id DESC LIMIT 1").fetchone()


def finish(conn, result):
    conn.execute(
        "UPDATE price_import SET finished_at = now(), outcome = %s, source_updated_at = %s, groups_total = %s, "
        "groups_failed = %s, product_rows = %s, price_rows = %s, rejected_rows = %s, error_code = %s WHERE id = %s",
        (result.outcome, result.source_updated_at, result.groups_total, result.groups_failed, result.product_rows,
         result.price_rows, result.rejected_rows, result.error_code, result.import_id))
    log(f"{result.outcome}" + (f" ({result.error_code})" if result.error_code else "")
        + f": {result.groups_total} groups, {result.groups_failed} failed, {result.product_rows} products, "
          f"{result.price_rows} prices, {result.rejected_rows} rejected")


def import_snapshot(conn, fetcher, result, force):
    first = fetcher.last_updated()
    newest_import = conn.execute("SELECT max(source_updated_at) AS at FROM price_import "
                                 "WHERE outcome IN ('imported','unchanged','partial')").fetchone()["at"]
    if newest_import and first < newest_import:
        result.error_code = "stale_source"
        result.outcome = "failed"
        return
    result.source_updated_at = first
    # The shortcut needs the newest finished run to be a complete one at this very snapshot; after a partial or failed
    # run (a moved source, a failed group) the next run downloads again.
    last = newest_finished(conn)
    if (not force and last and last["outcome"] in ("imported", "unchanged") and last["source_updated_at"] == first):
        result.outcome = "unchanged"
        return
    groups = [g for g in fetcher.results(f"/tcgplayer/{CATEGORY}/groups", "groups_unavailable")
              if isinstance(g, dict) and isinstance(g.get("groupId"), Decimal)]
    result.groups_total = len(groups)
    snapshot = {"seen_at": datetime.now(timezone.utc), "source": first}
    for group in groups:
        gid = int(group["groupId"])
        try:
            products = product_rows(fetcher.results(f"/tcgplayer/{CATEGORY}/{gid}/products", "group_unusable"), gid, result)
            prices = price_rows(fetcher.results(f"/tcgplayer/{CATEGORY}/{gid}/prices", "group_unusable"), result)
            write_group(conn, gid, products, prices, snapshot, result)
        except SourceError:
            result.groups_failed += 1
            log(f"group {gid} was left as stored")
    try:
        moved = fetcher.last_updated() != first
    except SourceError:
        moved = False
    result.outcome = "imported"
    if moved:
        result.outcome, result.error_code = "partial", "source_moved"
    elif result.groups_failed:
        result.outcome, result.error_code = "partial", "group_failed"


def run(conn, client=None, *, force=False):
    """One import on a connection opened with autocommit and dict rows (app.db.connect(autocommit=True))."""
    if not conn.execute("SELECT pg_try_advisory_lock(%s) AS acquired", (ADVISORY_LOCK,)).fetchone()["acquired"]:
        log("another run holds the lock; nothing was changed")
        return ImportResult("locked")
    try:
        result = ImportResult("failed")
        result.import_id = conn.execute("INSERT INTO price_import DEFAULT VALUES RETURNING id").fetchone()["id"]
        owned = client is None
        try:
            if owned:
                address = contact()
                if not address:
                    raise SourceError("no_contact")
                client = make_client(address)
            try:
                import_snapshot(conn, Fetcher(client), result, force)
            finally:
                if owned:
                    client.close()
        except SourceError as error:
            result.outcome, result.error_code = "failed", error.code
        post_import_steps(conn, result)
        finish(conn, result)
        if result.unknown_subtypes:
            log("subTypeName outside the known vocabulary was stored: " + ", ".join(sorted(result.unknown_subtypes)))
        return result
    finally:
        conn.execute("SELECT pg_advisory_unlock(%s)", (ADVISORY_LOCK,))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Import the daily TCGCSV Pokemon price snapshot.")
    parser.add_argument("--force", action="store_true", help="download again even when last-updated.txt is unchanged")
    args = parser.parse_args(argv)
    from app.db import connect
    try:
        conn = connect(autocommit=True, connect_timeout=10)
    except (psycopg.Error, KeyError):
        log("the database is unreachable")
        return UNREACHABLE
    try:
        return run(conn, force=args.force).exit_code
    except psycopg.Error as error:
        log(f"the database failed ({type(error).__name__})")
        return UNREACHABLE
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
