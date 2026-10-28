"""Daily TCGCSV price import (ticket P1, design sections 4.1 and 4.2): api/app/price_import.py.

TCGCSV is an httpx.MockTransport serving two groups; no test reaches the network, and the job's spacing and backoff sleeps
are replaced so that nothing waits.
"""
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import httpx
import pytest

from app import price_import
from app.db import connect

ROOT = Path(__file__).resolve().parents[2]
make_client = price_import.make_client
T1 = "2026-10-27T20:05:13+0000"
T2 = "2026-10-28T20:05:13+0000"
T0 = "2026-10-26T20:05:13+0000"


def at(text):
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%S%z")


def product(pid, name, number, group=1, images=1):
    extended = [{"name": "Number", "displayName": "Card Number", "value": number}] if number is not None else []
    return {"productId": pid, "name": name, "cleanName": name, "imageCount": images, "groupId": group,
            "extendedData": extended, "modifiedOn": "2026-10-01T00:00:00"}


def price(pid, sub, market, low=None, mid=None, high=None, direct=None):
    return {"productId": pid, "subTypeName": sub, "marketPrice": market, "lowPrice": low, "midPrice": mid,
            "highPrice": high, "directLowPrice": direct}


class Tcgcsv:
    """Serves last-updated.txt, the group list and each group's products and prices. Raw JSON text may be injected."""

    def __init__(self):
        self.updated = T1
        self.groups = {1: "Base Set", 2: "Jungle"}
        self.products = {
            1: [product(101, "Alakazam", "1/102"), product(102, "Pidgeon", "012/102"), product(103, "Token", None)],
            2: [product(201, "Clefable", "1/64")]}
        self.prices = {
            1: [price(101, "Holofoil", 954.65, 500, 700, 1200, 800), price(102, "Normal", 0.5), price(103, "Normal", None)],
            2: [price(201, "Unlimited Holofoil", 12.25, 1, 2, 3)]}
        self.raw = {}  # path -> (status, text) override
        self.failures = {}  # path -> number of leading 500 answers
        self.updated_after_groups = None  # last-updated.txt served once every group request has been answered
        self.requests = []

    def paths(self):
        return [r.url.path for r in self.requests]

    def group_requests(self):
        return [p for p in self.paths() if re.search(r"/\d+/(products|prices)$", p)]

    def handler(self, request):
        self.requests.append(request)
        path = request.url.path
        if path in self.failures and self.failures[path] > 0:
            self.failures[path] -= 1
            return httpx.Response(500, text="boom")
        if path in self.raw:
            status, text = self.raw[path]
            return httpx.Response(status, text=text)
        if path == "/last-updated.txt":
            done = self.updated_after_groups and len(self.group_requests()) >= 4
            return httpx.Response(200, text=self.updated_after_groups if done else self.updated)
        if path == "/tcgplayer/3/groups":
            return self.ok([{"groupId": g, "name": n} for g, n in self.groups.items()])
        match = re.fullmatch(r"/tcgplayer/3/(\d+)/(products|prices)", path)
        if match:
            return self.ok(getattr(self, match[2])[int(match[1])])
        return httpx.Response(404)

    @staticmethod
    def ok(results):
        return httpx.Response(200, json={"success": True, "errors": [], "results": results})

    def client(self):
        return make_client("owner@example.test", transport=httpx.MockTransport(self.handler))


@pytest.fixture(autouse=True)
def no_waiting(monkeypatch):
    monkeypatch.setattr(price_import, "sleep", lambda seconds: None)


@pytest.fixture
def conn():
    with connect(autocommit=True) as connection:
        connection.execute("TRUNCATE price_import, tcgplayer_product, tcgplayer_price RESTART IDENTITY")
        yield connection
        connection.execute("TRUNCATE price_import, tcgplayer_product, tcgplayer_price RESTART IDENTITY")


def run(conn, fake, **options):
    return price_import.run(conn, fake.client(), **options)


def last_import(conn):
    return conn.execute("SELECT * FROM price_import ORDER BY id DESC LIMIT 1").fetchone()


def prices(conn):
    return {(r["product_id"], r["sub_type_name"]): r for r in conn.execute("SELECT * FROM tcgplayer_price")}


# --- number_key --------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("given,key", [
    ("DP05", "DP5"), ("SWSH001", "SWSH1"), ("001", "1"), ("XY01", "XY1"), ("1/102", "1"), ("012/102", "12"),
    (" sm10 ", "SM10"), ("000", "0"), ("TG05/TG30", "TG5"), ("", None), ("  ", None), (None, None)])
def test_number_key(given, key):
    assert price_import.number_key(given) == key


# --- A normal import ---------------------------------------------------------------------------------------------------


def test_import_stores_every_product_and_price_and_records_the_run(conn):
    result = run(conn, Tcgcsv())
    assert (result.outcome, result.exit_code) == ("imported", 0)
    row = last_import(conn)
    assert (row["outcome"], row["groups_total"], row["groups_failed"], row["product_rows"], row["price_rows"],
            row["rejected_rows"], row["error_code"]) == ("imported", 2, 0, 4, 4, 0, None)
    assert row["source_updated_at"] == at(T1) and row["finished_at"] is not None
    assert conn.execute("SELECT count(*) AS n FROM tcgplayer_product").fetchone()["n"] == 4
    stored = prices(conn)
    assert len(stored) == 4
    assert stored[(101, "Holofoil")]["low_price"] == Decimal("500") and stored[(101, "Holofoil")]["direct_low_price"] == 800
    assert stored[(201, "Unlimited Holofoil")]["source_updated_at"] == at(T1)


def test_number_key_is_stored_and_a_missing_number_is_null(conn):
    run(conn, Tcgcsv())
    keys = {r["product_id"]: (r["number"], r["number_key"], r["group_id"])
            for r in conn.execute("SELECT product_id, number, number_key, group_id FROM tcgplayer_product")}
    assert keys[101] == ("1/102", "1", 1)
    assert keys[102] == ("012/102", "12", 1)
    assert keys[103] == (None, None, 1)
    assert keys[201] == ("1/64", "1", 2)


def test_amounts_are_exact_decimals(conn):
    run(conn, Tcgcsv())
    value = prices(conn)[(101, "Holofoil")]["market_price"]
    assert value == Decimal("954.650000") and str(value) == "954.650000"


def test_invalid_amounts_keep_the_stored_value_and_are_counted(conn):
    fake = Tcgcsv()
    run(conn, fake)
    fake.updated = T2
    fake.prices[1] = [
        price(101, "Holofoil", -1, low=1e12, mid=0.1234567, high=float("nan"), direct=9),
        price(102, "Normal", 0.75),
        price(103, "Normal", None)]
    # Python's json writes NaN as the bare token NaN, which TCGCSV's parser must treat as non-finite
    fake.raw["/tcgplayer/3/1/prices"] = (200, json.dumps({"success": True, "results": fake.prices[1]}))
    result = run(conn, fake)
    assert (result.outcome, result.rejected_rows) == ("imported", 1)
    stored = prices(conn)[(101, "Holofoil")]
    assert (stored["market_price"], stored["low_price"], stored["mid_price"], stored["high_price"]) == (
        Decimal("954.65"), Decimal(500), Decimal(700), Decimal(1200))
    assert stored["direct_low_price"] == 9  # the valid field of the same row is stored
    assert prices(conn)[(102, "Normal")]["market_price"] == Decimal("0.75")
    assert last_import(conn)["rejected_rows"] == 1


def test_invalid_amount_on_a_new_row_is_stored_as_null(conn):
    fake = Tcgcsv()
    fake.prices[2] = [price(201, "Unlimited Holofoil", -5, low=2)]
    run(conn, fake)
    stored = prices(conn)[(201, "Unlimited Holofoil")]
    assert stored["market_price"] is None and stored["low_price"] == 2


def test_null_stores_null_and_zero_stores_zero(conn):
    fake = Tcgcsv()
    run(conn, fake)
    fake.updated = T2
    fake.prices[1] = [price(101, "Holofoil", 0, low=None, mid=0.0), price(102, "Normal", 0.5), price(103, "Normal", None)]
    run(conn, fake)
    stored = prices(conn)[(101, "Holofoil")]
    assert stored["market_price"] == 0 and stored["low_price"] is None and stored["mid_price"] == 0
    assert stored["high_price"] is None  # TCGCSV's null today is the truth, not a reason to keep yesterday's value


def test_a_null_burst_leaves_the_group_untouched(conn):
    fake = Tcgcsv()
    fake.products[1] = [product(100 + n, f"Card {n}", str(n)) for n in range(1, 5)]
    fake.prices[1] = [price(100 + n, "Normal", float(n)) for n in range(1, 5)]
    run(conn, fake)
    fake.updated = T2
    fake.prices[1] = [price(101, "Normal", None), price(102, "Normal", None), price(103, "Normal", None),
                      price(104, "Normal", 40.0)]
    fake.prices[2] = [price(201, "Unlimited Holofoil", 13.0)]
    result = run(conn, fake)
    assert (result.outcome, result.groups_failed, result.exit_code) == ("partial", 1, 3)
    stored = prices(conn)
    assert [stored[(100 + n, "Normal")]["market_price"] for n in range(1, 5)] == [1, 2, 3, 4]
    assert stored[(101, "Normal")]["source_updated_at"] == at(T1)
    assert stored[(201, "Unlimited Holofoil")]["market_price"] == 13  # the other group is written


def test_half_the_prices_going_null_is_not_a_burst(conn):
    fake = Tcgcsv()
    fake.products[1] = [product(100 + n, f"Card {n}", str(n)) for n in range(1, 5)]
    fake.prices[1] = [price(100 + n, "Normal", float(n)) for n in range(1, 5)]
    run(conn, fake)
    fake.updated = T2
    fake.prices[1][0]["marketPrice"] = fake.prices[1][1]["marketPrice"] = None
    assert run(conn, fake).outcome == "imported"
    assert prices(conn)[(101, "Normal")]["market_price"] is None


def test_a_small_group_going_null_is_not_a_burst(conn):
    fake = Tcgcsv()
    fake.products[1] = [product(101, "Card 1", "1")]
    fake.prices[1] = [price(101, "Normal", 1.0)]
    run(conn, fake)
    fake.updated = T2
    fake.prices[1] = [price(101, "Normal", None)]
    assert run(conn, fake).outcome == "imported"
    assert prices(conn)[(101, "Normal")]["market_price"] is None


def test_a_row_missing_from_today_keeps_its_values_and_dates(conn):
    fake = Tcgcsv()
    run(conn, fake)
    before = prices(conn)[(102, "Normal")]
    product_before = conn.execute("SELECT * FROM tcgplayer_product WHERE product_id = 102").fetchone()
    fake.updated = T2
    fake.prices[1] = [price(101, "Holofoil", 1000.0)]
    fake.products[1] = [product(101, "Alakazam", "1/102")]
    assert run(conn, fake).outcome == "imported"
    assert prices(conn)[(102, "Normal")] == before
    assert conn.execute("SELECT * FROM tcgplayer_product WHERE product_id = 102").fetchone() == product_before
    assert prices(conn)[(101, "Holofoil")]["source_updated_at"] == at(T2)
    assert prices(conn)[(101, "Holofoil")]["market_price"] == 1000


# --- last-updated.txt --------------------------------------------------------------------------------------------------


def test_an_unchanged_source_makes_no_group_requests_and_force_fetches_again(conn):
    fake = Tcgcsv()
    run(conn, fake)
    fake.requests.clear()
    result = run(conn, fake)
    assert result.outcome == "unchanged" and fake.paths() == ["/last-updated.txt"]
    assert last_import(conn)["outcome"] == "unchanged" and last_import(conn)["source_updated_at"] == at(T1)
    fake.requests.clear()
    assert run(conn, fake, force=True).outcome == "imported"
    assert len(fake.group_requests()) == 4


def test_an_older_source_fails_as_stale_and_writes_nothing(conn):
    fake = Tcgcsv()
    run(conn, fake)
    snapshot = (prices(conn), conn.execute("SELECT * FROM tcgplayer_product ORDER BY product_id").fetchall())
    fake.updated = T0
    fake.prices[1] = [price(101, "Holofoil", 1.0)]
    fake.requests.clear()
    result = run(conn, fake)
    assert (result.outcome, result.error_code, result.exit_code) == ("failed", "stale_source", 2)
    assert last_import(conn)["error_code"] == "stale_source" and fake.group_requests() == []
    assert (prices(conn), conn.execute("SELECT * FROM tcgplayer_product ORDER BY product_id").fetchall()) == snapshot


def test_a_source_that_moves_during_the_download_is_partial_and_not_skipped_next_time(conn):
    fake = Tcgcsv()
    fake.updated_after_groups = T2
    result = run(conn, fake)
    assert (result.outcome, result.error_code, result.exit_code) == ("partial", "source_moved", 3)
    assert last_import(conn)["source_updated_at"] == at(T1)
    fake.updated, fake.updated_after_groups = T1, None
    fake.requests.clear()
    assert run(conn, fake).outcome == "imported"
    assert len(fake.group_requests()) == 4


# --- Failing groups and endpoints --------------------------------------------------------------------------------------


def test_a_group_that_fails_three_times_is_left_alone_and_the_run_is_partial(conn):
    fake = Tcgcsv()
    run(conn, fake)
    before = prices(conn)
    fake.updated = T2
    fake.prices[1] = [price(101, "Holofoil", 1.0)]
    fake.prices[2] = [price(201, "Unlimited Holofoil", 14.0)]
    fake.failures["/tcgplayer/3/1/prices"] = 3
    fake.requests.clear()
    result = run(conn, fake)
    assert (result.outcome, result.groups_failed, result.exit_code) == ("partial", 1, 3)
    assert fake.paths().count("/tcgplayer/3/1/prices") == 3
    after = prices(conn)
    assert after[(101, "Holofoil")] == before[(101, "Holofoil")]
    assert after[(201, "Unlimited Holofoil")]["market_price"] == 14


def test_a_request_that_succeeds_on_the_third_attempt_is_fine(conn, monkeypatch):
    fake = Tcgcsv()
    fake.failures["/tcgplayer/3/1/prices"] = 2
    waits = []
    monkeypatch.setattr(price_import, "sleep", waits.append)
    assert run(conn, fake).outcome == "imported"
    assert [w for w in waits if w >= 1] == [1, 4]


@pytest.mark.parametrize("raw", [
    (200, json.dumps({"success": False, "results": []})), (200, json.dumps({"success": True, "results": {}})),
    (200, "not json"), (404, "")])
def test_an_unusable_answer_fails_only_that_group(conn, raw):
    fake = Tcgcsv()
    fake.raw["/tcgplayer/3/1/prices"] = raw
    result = run(conn, fake)
    assert (result.outcome, result.groups_failed) == ("partial", 1)
    assert {pid for pid, _ in prices(conn)} == {201}
    assert conn.execute("SELECT count(*) AS n FROM tcgplayer_product").fetchone()["n"] == 1  # a failed group writes nothing


def test_an_empty_list_where_rows_exist_leaves_the_group_alone(conn):
    fake = Tcgcsv()
    run(conn, fake)
    before = prices(conn)
    fake.updated = T2
    fake.prices[1] = []
    result = run(conn, fake)
    assert (result.outcome, result.groups_failed) == ("partial", 1)
    assert {k: v for k, v in prices(conn).items() if k[0] < 200} == {k: v for k, v in before.items() if k[0] < 200}
    fake.updated = "2026-10-29T20:05:13+0000"
    fake.prices[1], fake.products[1] = [price(101, "Holofoil", 5.0)], []
    assert run(conn, fake).groups_failed == 1  # empty products where products exist


def test_an_empty_list_with_nothing_stored_is_not_a_failure(conn):
    fake = Tcgcsv()
    fake.products[2], fake.prices[2] = [], []
    assert run(conn, fake).outcome == "imported"


@pytest.mark.parametrize("path,code", [("/tcgplayer/3/groups", "groups_unavailable"),
                                       ("/last-updated.txt", "last_updated_unavailable")])
def test_the_group_list_or_last_updated_failing_is_a_failed_run(conn, path, code):
    fake = Tcgcsv()
    run(conn, fake)
    before = (prices(conn), conn.execute("SELECT * FROM tcgplayer_product ORDER BY product_id").fetchall())
    fake.updated = T2
    fake.raw[path] = (503, "")
    result = run(conn, fake, force=True)
    assert (result.outcome, result.error_code, result.exit_code) == ("failed", code, 2)
    row = last_import(conn)
    assert (row["outcome"], row["error_code"]) == ("failed", code)
    assert (prices(conn), conn.execute("SELECT * FROM tcgplayer_product ORDER BY product_id").fetchall()) == before


def test_an_unreadable_last_updated_is_a_failed_run(conn):
    fake = Tcgcsv()
    fake.raw["/last-updated.txt"] = (200, "yesterday")
    assert run(conn, fake).error_code == "last_updated_invalid"


def test_an_unknown_subtype_is_stored(conn, capsys):
    fake = Tcgcsv()
    fake.prices[2] = [price(201, "Cosmos Holofoil", 3.0)]
    run(conn, fake)
    assert (201, "Cosmos Holofoil") in prices(conn)
    assert "Cosmos Holofoil" in capsys.readouterr().out


# --- Lock, request identity, logs ---------------------------------------------------------------------------------------


def test_a_second_job_exits_zero_without_work_while_one_runs(conn):
    fake = Tcgcsv()
    with connect(autocommit=True) as holder:
        assert holder.execute("SELECT pg_try_advisory_lock(%s) AS got", (price_import.ADVISORY_LOCK,)).fetchone()["got"]
        result = run(conn, fake)
        holder.execute("SELECT pg_advisory_unlock(%s)", (price_import.ADVISORY_LOCK,))
    assert (result.outcome, result.exit_code) == ("locked", 0)
    assert fake.requests == [] and conn.execute("SELECT count(*) AS n FROM price_import").fetchone()["n"] == 0
    assert run(conn, fake).outcome == "imported"  # the lock is free again, also after a finished run
    assert run(conn, fake, force=True).outcome == "imported"


def test_requests_carry_the_user_agent_and_logs_hold_no_payload(conn, capsys):
    fake = Tcgcsv()
    fake.prices[1][0] = price(101, "Holofoil", 954.65)
    run(conn, fake)
    assert {r.headers["user-agent"] for r in fake.requests} == {"PrizeCheck-prices/1 (+owner@example.test)"}
    output = capsys.readouterr().out
    assert output and "954" not in output and "Alakazam" not in output and "owner@example.test" not in output


def test_main_exits_one_when_the_database_is_unreachable(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://nobody@127.0.0.1:1/none")
    assert price_import.main([]) == 1


def test_main_exits_with_the_runs_code(monkeypatch, conn):
    fake = Tcgcsv()
    fake.raw["/tcgplayer/3/groups"] = (500, "")
    monkeypatch.setattr(price_import, "make_client", lambda address, transport=None: fake.client())
    monkeypatch.setenv("PRICE_IMPORT_CONTACT", "owner@example.test")
    assert price_import.main([]) == 2
    assert price_import.main(["--force"]) == 2


def test_the_job_script_exposes_main():
    code = subprocess.run([sys.executable, "-I", str(ROOT / "scripts" / "price_import_job.py"), "--help"],
                          capture_output=True, text=True)
    assert code.returncode == 0 and "--force" in code.stdout


def test_only_price_import_talks_to_tcgcsv():
    offenders = [path.name for path in (ROOT / "api" / "app").glob("*.py")
                 if path.name != "price_import.py" and "tcgcsv.com" in path.read_text().lower()]
    assert offenders == []
