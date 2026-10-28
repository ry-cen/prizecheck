"""Each side's estimated total for a Trade Proposal (Trading #277): ``POST /api/trades/value`` through signed, budgeted
HTTP against a real record store.

It is a price access under ADR 0006: one quote read for the distinct Editions of both sides, each side folded by the
shared Deck cost fold. Cash is not part of it, the answer names no source, check time or refresh state, and the gateway
and the API budget exactly the same routes.
"""
from datetime import timedelta
import json
from pathlib import Path
import re
from uuid import uuid4

import pytest

from app.main import app, connect  # noqa: F401
from app import price_budget, prices
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import store  # noqa: F401  (a fixture)
from test_prices import ago, client, headers_for, seed, world

PATH = "/api/trades/value"


def value(lines, *, user=None, raw=None, **options):
    """POST the lines, given as ``(side, edition, count)``; ``raw`` is the exact body when a test needs one."""
    if raw is None:
        raw = json.dumps({"lines": [{"side": side, "edition_id": str(edition), "quantity": str(count)}
                                    for side, edition, count in lines]}, separators=(",", ":")).encode()
    headers = headers_for(raw, path=PATH, user=user or f"value-{uuid4()}", **options)
    return client.post(PATH, content=raw, headers=headers)


def body_of(response):
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def side(figure):
    return (figure["status"], figure["display_total"], figure["priced_copies"], figure["total_copies"])


def test_each_side_is_folded_in_micro_dollars_and_rounded_once(store):
    found = world()
    normal, reverse = found["normal"], found["reverse-holofoil"]
    seed(store, normal, "0.333333")
    seed(store, reverse, "0.43")
    body = body_of(value([("you_give", normal["id"], 3), ("you_get", reverse["id"], 2)]))
    # 0.999999 rounded once is $1.00; rounding each copy would give $0.99.
    assert side(body["you_give"]) == ("priced", "$1.00", "3", "3")
    assert side(body["you_get"]) == ("priced", "$0.86", "2", "2")


def test_each_side_reads_empty_partial_no_quotes_or_incomplete(store, monkeypatch):
    found = world()
    normal, reverse, plain = found["normal"], found["reverse-holofoil"], found["unspecified"]
    seed(store, normal, "0.25")
    body = body_of(value([("you_give", normal["id"], 1), ("you_give", plain["id"], 2), ("you_get", plain["id"], 1)]))
    assert side(body["you_give"]) == ("priced", "$0.25", "1", "3")
    assert side(body["you_get"]) == ("no_quotes", None, "0", "1")
    body = body_of(value([("you_get", normal["id"], 2)]))
    assert side(body["you_give"]) == ("empty", "$0.00", "0", "0")
    assert side(body["you_get"]) == ("priced", "$0.50", "2", "2")
    real_quotes = prices.private_edition_quotes

    def failing_reverse(ids, *args, **kwargs):
        views = real_quotes(ids, *args, **kwargs)
        views[reverse["id"]] = prices._failed([reverse["id"]], "validation_unavailable")[reverse["id"]]
        return views
    seed(store, reverse, "0.43")
    monkeypatch.setattr(prices, "private_edition_quotes", failing_reverse)
    body = body_of(value([("you_give", reverse["id"], 1), ("you_get", normal["id"], 2)]))
    assert side(body["you_give"]) == ("incomplete", None, None, "1")
    assert side(body["you_get"]) == ("priced", "$0.50", "2", "2")


def test_an_edition_on_both_sides_is_read_once(store, monkeypatch):
    found = world()
    normal, reverse = found["normal"], found["reverse-holofoil"]
    for edition in (normal, reverse):
        seed(store, edition, "0.25", checked=ago(timedelta(hours=2)))
    reads = []
    real_quotes = prices.private_edition_quotes
    monkeypatch.setattr(
        prices, "private_edition_quotes",
        lambda ids, *a, **k: reads.append(sorted(str(item) for item in ids)) or real_quotes(ids, *a, **k))
    body = body_of(value([("you_give", normal["id"], 2), ("you_give", reverse["id"], 1), ("you_get", normal["id"], 1)]))
    assert reads == [sorted([str(normal["id"]), str(reverse["id"])])]
    assert side(body["you_give"]) == ("priced", "$0.75", "3", "3")
    assert side(body["you_get"]) == ("priced", "$0.25", "1", "1")


def test_with_price_reads_off_both_sides_read_no_quotes_and_nothing_is_queried(store, monkeypatch):
    found = world()
    normal = found["normal"]
    seed(store, normal, "0.25")
    monkeypatch.setenv("PRICE_READS", "off")
    monkeypatch.setattr(prices, "_read_rows", lambda *a, **k: pytest.fail("a price query ran"))
    body = body_of(value([("you_give", normal["id"], 2), ("you_get", normal["id"], 1)]))
    assert side(body["you_give"]) == ("no_quotes", None, "0", "2") and side(body["you_get"]) == ("no_quotes", None, "0", "1")


def test_refusals_come_in_order_before_any_price_is_read(store, monkeypatch):
    unknown = lambda count: [str(uuid4()) for _ in range(count)]  # noqa: E731
    e, other = unknown(2)
    real_quotes = prices.private_edition_quotes
    monkeypatch.setattr(prices, "private_edition_quotes", lambda *a, **k: pytest.fail("a price was read"))
    many = unknown(101)
    cases = [
        ([("you_give", e, 0)], 422, "INVALID_QUANTITY"),
        ([("you_get", e, 10000)], 422, "INVALID_QUANTITY"),
        ([("you_give", e, "1.5")], 422, "INVALID_QUANTITY"),
        ([("you_give", e, 1), ("you_give", e, 1), ("you_get", other, "x")], 422, "INVALID_QUANTITY"),
        ([("you_give", e, 1), ("you_give", e, 2)], 422, "DUPLICATE_EDITION"),
        ([("you_get", many[0], 1), ("you_get", many[0], 1)] + [("you_give", edition, 1) for edition in many], 422,
         "DUPLICATE_EDITION"),
        ([("you_give", edition, 1) for edition in many], 422, "TOO_MANY_LINES"),
    ]
    for lines, status, code in cases:
        response = value(lines)
        assert (response.status_code, response.json()["detail"]["code"]) == (status, code), lines
    generic = [b'{"lines":[{"side":"both","edition_id":"%s","quantity":"1"}]}' % e.encode(),
               b'{"lines":[],"cash":{"cents":"500","payer":"you"}}',
               b'{"lines":[{"side":"you_give","edition_id":"%s","quantity":"1","cash":"5"}]}' % e.encode()]
    for raw in generic:
        response = value([], raw=raw)
        assert response.status_code == 422 and isinstance(response.json()["detail"], list), raw
    monkeypatch.setattr(prices, "private_edition_quotes", real_quotes)
    found = world()
    allowed = [("you_give" if number < 50 else "you_get", edition, 1) for number, edition in enumerate(many[:100])]
    body = body_of(value(allowed))
    assert side(body["you_give"]) == ("no_quotes", None, "0", "50") and side(body["you_get"])[3] == "50"
    body = body_of(value([("you_give", found["normal"]["id"], 1), ("you_get", found["normal"]["id"], 1)]))
    assert body["you_give"]["total_copies"] == body["you_get"]["total_copies"] == "1"
    body = body_of(value([]))
    assert side(body["you_give"]) == side(body["you_get"]) == ("empty", "$0.00", "0", "0")


def test_the_answer_carries_no_source_check_time_or_refresh_and_takes_no_cash(store):
    schemas = app.openapi()["components"]["schemas"]
    assert set(schemas["SideValue"]["properties"]) == {"status", "display_total", "priced_copies", "total_copies"}
    assert set(schemas["TradeValue"]["properties"]) == {"you_give", "you_get"}
    assert set(schemas["TradeValueRequest"]["properties"]) == {"lines"}
    assert set(schemas["TradeValueLine"]["properties"]) == {"side", "edition_id", "quantity"}
    banned = ("provider", "checked", "refresh", "source", "stale", "fallback", "age", "reason", "cash")
    for name in ("SideValue", "TradeValue", "TradeValueRequest", "TradeValueLine"):
        assert not [key for key in schemas[name]["properties"] if any(word in key for word in banned)], name
    found = world()
    seed(store, found["normal"], "0.25")
    response = value([("you_give", found["normal"]["id"], 2)])
    assert side(body_of(response)["you_give"])[0] == "priced"
    assert "tcgdex" not in response.text.lower() and "checked_at" not in response.text.lower()


def test_the_route_is_private_signed_and_budgeted(store, monkeypatch):
    found = world()
    lines = [("you_give", found["normal"]["id"], 1)]
    stranger = f"value-{uuid4()}"
    monkeypatch.setattr(prices, "private_edition_quotes", lambda *a, **k: pytest.fail("a price read ran"))
    assert value(lines, budget=False).status_code == 401
    assert value(lines, forge="0" * 64).status_code == 401
    assert value(lines, caller=f"user:{stranger}").status_code == 401
    assert client.post(PATH, json={"lines": []}).status_code == 401
    raw = json.dumps({"lines": []}, separators=(",", ":")).encode()
    other = client.post(PATH, content=raw, headers=headers_for(raw, path="/api/prices/editions", user="price-reader"))
    assert other.status_code == 401
    assert price_budget.is_budgeted("POST", PATH) is True
    assert price_budget.is_budgeted("GET", PATH) is False


def test_the_gateway_budgets_exactly_the_routes_the_api_lists():
    text = (Path(__file__).resolve().parents[2] / "auth/src/server.ts").read_text()
    block = re.search(r"const BUDGETED_ROUTES[^=]*=\s*\[(.*?)\n\];", text, re.S).group(1)
    entries = {(method, pattern.replace("\\/", "/"))
               for method, pattern in re.findall(r'method:\s*"(\w+)",\s*pattern:\s*/(.+?)/\s*[,}]', block, re.S)}
    assert entries == {(method, pattern.pattern) for method, pattern in price_budget.BUDGETED_ROUTES}
    assert len(entries) == 5 and ("POST", "^/api/trades/value$") in entries
