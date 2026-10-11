"""Format check latency through the real gateway (Deck Lists 19, issue #100; spec acceptance criterion 10).

A real API process (uvicorn) behind a real gateway process (auth/src/server.ts), both on this test's database, serve an
owner signed in with an emailed code. Every time is measured outside the gateway with a real clock, over one kept-alive
connection, as a browser asks. Each path is sampled ``SAMPLES`` times after ``WARMUP`` unmeasured requests:

- cold: ``GET /api/decks/{id}/format-checks`` with no saved result. The test deletes the Deck's saved results before
  each request, outside the measured time, so every request reads the Deck List and evaluates all three formats.
- warm: the same request while the saved results match, so it reuses them.
- command: ``PATCH /api/decks/{id}/deck-list/lines/{edition}``, which evaluates and saves all three formats inside its
  transaction and returns them (Deck Lists 17).

The cards come through a real catalog import, so their attributes and Reprint Groups come from the real derivation
rules, and every format reads the real rules file. Each Trainer identity has three printings with equal text, so the
check reads three-member Reprint Groups and judges two of every three lines through them.

Budgets: p95 under 200 ms at 60 lines (the spec) and under ``LARGE_P95_MS`` at 1,000 lines (Deck Lists 19).
"""
import json
import math
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from uuid import uuid4

import httpx
import pytest

from app.main import connect
from test_card_attributes import ENERGY_SV, card
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run

ROOT = Path(__file__).resolve().parents[2]
ORIGIN = "http://localhost:5173"
WARMUP = 5
SAMPLES = 40
P95_MS = 200            # spec acceptance criterion 10: a 60-line Deck List
LARGE_LINES = 1000
LARGE_P95_MS = 500      # Deck Lists 19: the bound for very large Deck Lists
LARGE_SAMPLES = 20
AS_OF = "2026-10-11"    # the rules files' date: reads assert statuses that later rotations would change


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def eventually(predicate, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.1)
    raise AssertionError("the latency stack did not become ready")


def metric(line):
    """Measurements for the evidence record: stdout, plus format-check-latency-metrics.log in TEST_LOG_DIR."""
    print(f"[format-check-latency] {line}")
    if os.environ.get("TEST_LOG_DIR"):
        with open(Path(os.environ["TEST_LOG_DIR"]) / "format-check-latency-metrics.log", "a") as log:
            log.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {line}\n")


def percentile(samples, p):
    ordered = sorted(samples)
    return ordered[math.ceil(len(ordered) * p) - 1]


def summary(samples):
    return {"n": len(samples), "min": round(min(samples), 1), "p50": round(percentile(samples, 0.5), 1),
            "p95": round(percentile(samples, 0.95), 1), "max": round(max(samples), 1)}


TRAINER_SETS = (("me01", "Mega Evolution", "I"), ("sv01", "Scarlet & Violet", "G"),
                ("swsh1", "Sword & Shield", "D"))


def latency_cards(identities, pokemon):
    """``identities`` Trainer Card Identities with one printing in each of TRAINER_SETS (equal text, so one Reprint
    Group of three: mark G and mark D are out of Standard on their own and legal through the mark I printing), and
    ``pokemon`` single-printing Basic Pokémon. Returns the records and their TCGdex IDs in Deck order."""
    records = []
    for number in range(identities):
        for set_id, set_name, mark in TRAINER_SETS:
            records.append(card(id=f"fixture-{set_id}-{9000 + number}", name=f"Latency Trainer {number:04d}",
                                localId=str(9000 + number), category="Trainer", set={"id": set_id, "name": set_name},
                                regulationMark=mark, rarity="Common", trainerType="Item",
                                effect=f"Draw {number % 7 + 1} cards. Latency fixture {number}."))
    for number in range(pokemon):
        records.append(card(id=f"fixture-me01-{8000 + number}", name=f"Latency Pokémon {number:04d}",
                            localId=str(8000 + number), category="Pokemon", set={"id": "me01", "name": "Mega Evolution"},
                            regulationMark="I", stage="Basic", rarity="Common", hp=70, types=["Fire"],
                            attacks=[{"cost": ["Fire"], "name": "Latency Ember", "damage": 30}]))
    return records, [record["id"] for record in records]


def shape(lines):
    """The Trainer identities and Pokémon of a ``lines``-line Deck List; its last line is Basic Grass Energy."""
    return divmod(lines - 1, 3)


@pytest.fixture(scope="module")
def world():
    """One catalog import holding the cards of the 1,000-line Deck List; the 60-line one uses its first cards."""
    records, ids = latency_cards(max(shape(60)[0], shape(LARGE_LINES)[0]), max(shape(60)[1], shape(LARGE_LINES)[1]))
    reset_catalog()
    started = time.monotonic()
    run(Records(*records, ENERGY_SV))
    metric(f"import of {len(records) + 1} records: {time.monotonic() - started:.1f} s")
    with connect() as conn:
        editions = {row["source_id"]: row["id"] for row in conn.execute(
            """SELECT p.source_id,e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
               WHERE p.source_id=ANY(%s)""", (ids + [ENERGY_SV["id"]],))}
    return ids, editions


@pytest.fixture(scope="module")
def gateway(tmp_path_factory):
    """A real API and a real gateway on this test's database, and a client signed in as their owner."""
    directory = tmp_path_factory.mktemp("format-check-latency")
    mail = directory / "mail"
    mail.touch()
    email = f"latency-{uuid4().hex[:12]}@example.test"   # one owner per run: allowedSend limits sends per address
    api_port, gateway_port = free_port(), free_port()
    env = {**os.environ, "OWNER_EMAIL": email, "MAIL_MODE": "file", "MAIL_FILE": str(mail),
           "SIGNUP_MODE": "owner-only", "NODE_ENV": "test", "PUBLIC_ORIGIN": ORIGIN, "AUTH_PORT": str(gateway_port),
           "API_ORIGIN": f"http://127.0.0.1:{api_port}",
           "PYTHONPATH": str(ROOT / "api/tests/catalog_process_fixture") + os.pathsep + str(ROOT / "api")}
    children = []
    base = f"http://127.0.0.1:{gateway_port}"
    try:
        # Started inside the try, so a failed second start still stops the first.
        children.append(subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--app-dir", "api", "--host", "127.0.0.1",
             "--port", str(api_port), "--no-access-log"], cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        children.append(subprocess.Popen(["node", "--import", "tsx", "auth/src/server.ts"], cwd=ROOT, env=env,
                                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL))
        def healthy():
            assert all(child.poll() is None for child in children), "a latency stack process exited"
            try:
                return httpx.get(base + "/api/health", timeout=0.5).status_code == 200
            except httpx.HTTPError:
                return False
        eventually(healthy)
        with httpx.Client(base_url=base, headers={"origin": ORIGIN}, timeout=10) as signer:
            assert signer.post("/auth/request-code", json={"email": email}).status_code == 202
            sent = mail.read_text().strip().splitlines()
            # request-code answers 202 even when allowedSend refuses (per address and per IP on 127.0.0.1).
            assert sent, "no sign-in code was mailed: the gateway's send limits refused it"
            code = json.loads(sent[-1])["otp"]
            signed = signer.post("/auth/verify-code", json={"email": email, "code": code})
            assert signed.status_code == 200, signed.text
            cookie = "; ".join(f"{name}={value}" for name, value in signed.cookies.items())
        with httpx.Client(base_url=base, headers={"origin": ORIGIN, "cookie": cookie}, timeout=10) as client:
            session = client.get("/auth/session").json()
            assert session["signedIn"], session
            assert client.get("/api/locations").status_code == 200    # onboards the owner
            yield client, session["userId"]
    finally:
        for child in children:
            child.terminate()
        for child in children:
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


def deck_of(client, user, editions):
    """A new, half-built Deck: its Deck List holds one copy of each Edition and the Deck holds every other one, so each
    command also pairs a large Deck's lines with its Holdings (``decks.read_deck_list``). Written in one transaction:
    the held copies are already covered, so the Deck List trigger changes nothing."""
    created = client.post("/api/decks", json={"name": f"Latency {uuid4().hex[:8]}", "idempotency_key": str(uuid4())})
    assert created.status_code == 201, created.text
    deck = created.json()["location"]["id"]
    with connect() as conn, conn.transaction():
        conn.execute("""INSERT INTO deck_list_line(owner_id,deck_id,edition_id,quantity)
          SELECT %s,%s,e,1 FROM unnest(%s::uuid[]) AS e""", (user, deck, list(editions)))
        conn.execute("UPDATE deck_list SET revision=revision+1 WHERE owner_id=%s AND deck_id=%s", (user, deck))
        conn.execute("""INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
          SELECT %s,%s,e,1,1 FROM unnest(%s::uuid[]) AS e""", (user, deck, list(editions)[::2]))
        conn.execute("UPDATE inventory_owner SET revision=revision+1 WHERE user_id=%s", (user,))
    return deck


def timed(request):
    started = time.perf_counter()
    response = request()
    elapsed = (time.perf_counter() - started) * 1000
    assert response.status_code == 200, response.text
    return response, elapsed


def measure(client, user, deck, edition, samples, statuses):
    """Cold, warm and command samples in milliseconds for one Deck. Reads check as of AS_OF, where every result must
    have its expected status (``statuses``, by format); commands check as of today, like the route."""
    path = f"/api/decks/{deck}/format-checks?as_of={AS_OF}"

    def forget():
        with connect() as conn:
            conn.execute("DELETE FROM deck_format_result WHERE owner_id=%s AND deck_id=%s", (user, deck))

    def cold():
        forget()
        response, elapsed = timed(lambda: client.get(path))
        assert {result["format"]: result["status"] for result in response.json()["results"]} == statuses
        return response, elapsed

    for _ in range(WARMUP):
        cold()
    cold_ms = [cold()[1] for _ in range(samples)]
    saved, _ = timed(lambda: client.get(path))
    warm_ms = []
    for _ in range(WARMUP + samples):
        response, elapsed = timed(lambda: client.get(path))
        assert response.json() == saved.json()          # reused: computed at the same time
        warm_ms.append(elapsed)
    warm_ms = warm_ms[WARMUP:]
    revision = saved.json()["deck_list_revision"]
    command_ms = []
    for number in range(WARMUP + samples):
        body = {"quantity": str(2 - number % 2), "revision": revision,
                "idempotency_key": str(uuid4())}
        response, elapsed = timed(lambda: client.patch(f"/api/decks/{deck}/deck-list/lines/{edition}", json=body))
        checks = response.json()["format_checks"]
        revision = response.json()["deck_list"]["revision"]
        assert checks["deck_list_revision"] == revision and len(checks["results"]) == 3
        command_ms.append(elapsed)
    command_ms = command_ms[WARMUP:]
    return {"cold": summary(cold_ms), "warm": summary(warm_ms), "command": summary(command_ms)}


def lines_of(ids, editions, lines):
    """The Editions of a ``lines``-line Deck List: Trainers by identity, then Pokémon, then one Basic Energy line."""
    identities, pokemon = shape(lines)
    trainers = ids[:3 * identities]
    monsters = [source_id for source_id in ids if source_id.startswith("fixture-me01-8")][:pokemon]
    chosen = [editions[source_id] for source_id in (*trainers, *monsters, ENERGY_SV["id"])]
    assert len(chosen) == len(set(chosen)) == lines
    return chosen


@pytest.mark.serial(reason="process: asserts a p95 of real gateway and API processes")
@pytest.mark.slow(reason="process: starts a real gateway and API and samples 260 requests")
def test_a_60_line_format_check_meets_its_p95_through_the_gateway(world, gateway):
    client, user = gateway
    ids, editions = world
    chosen = lines_of(ids, editions, 60)
    deck = deck_of(client, user, chosen)
    # Standard and Expanded legal (two thirds of the Trainers only through their Reprint Groups); three copies of each
    # Trainer break Gym Leader Challenge's one-copy rule.
    found = measure(client, user, deck, chosen[0], SAMPLES,
                    {"standard": "legal", "expanded": "legal", "glc": "not_legal"})
    metric(json.dumps({"lines": 60, "bound_ms": P95_MS, **found}, sort_keys=True))
    for path, figures in found.items():
        assert figures["p95"] < P95_MS, (path, found)


@pytest.mark.serial(reason="process: asserts a p95 of real gateway and API processes")
@pytest.mark.slow(reason="capacity: a 1,000-line Deck List through a real gateway and API")
def test_a_1000_line_format_check_meets_its_bound_through_the_gateway(world, gateway):
    client, user = gateway
    ids, editions = world
    chosen = lines_of(ids, editions, LARGE_LINES)
    deck = deck_of(client, user, chosen)
    found = measure(client, user, deck, chosen[0], LARGE_SAMPLES,
                    {"standard": "not_legal", "expanded": "not_legal", "glc": "not_legal"})
    metric(json.dumps({"lines": LARGE_LINES, "bound_ms": LARGE_P95_MS, **found}, sort_keys=True))
    for path, figures in found.items():
        assert figures["p95"] < LARGE_P95_MS, (path, found)
