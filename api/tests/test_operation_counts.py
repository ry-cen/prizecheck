"""Operational counts are written off the request path (app/operation_counts.py)."""
import asyncio
import threading
import time

import httpx
import pytest
from starlette.responses import JSONResponse

from app.main import app, connect, operation_counter
from app.operation_counts import Count, OperationCounter


class Gate:
    """A writer that blocks until released, then records what it was given."""

    def __init__(self):
        self.release = threading.Event()
        self.entered = threading.Event()
        self.written = []

    def write(self, count):
        self.entered.set()
        self.release.wait(10)
        self.written.append(count)


class Failing:
    def __init__(self):
        self.calls = 0

    def write(self, count):
        self.calls += 1
        raise RuntimeError("database down")


@pytest.fixture
def writer():
    """Swaps the shared counter's writer; restores the real one and drains before the next test."""
    real = operation_counter.set_writer(None)
    operation_counter.flush()
    yield operation_counter.set_writer
    operation_counter.set_writer(real)
    operation_counter.flush()


def counted_request():
    """A counted /api/ request (an unsigned call is a 401) and a 20 ms ticker on the same event loop."""
    async def go():
        gaps = []

        async def ticker(stop):
            last = time.perf_counter()
            while not stop.is_set():
                await asyncio.sleep(0.02)
                now = time.perf_counter()
                gaps.append(now - last)
                last = now

        stop = asyncio.Event()
        task = asyncio.create_task(ticker(stop))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as http:
            started = time.perf_counter()
            response = await http.get("/api/locations")
            elapsed = time.perf_counter() - started
            await asyncio.sleep(0.1)
        stop.set()
        await task
        return response.status_code, elapsed, max(gaps)
    return asyncio.run(go())


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_a_blocked_writer_delays_neither_the_request_nor_other_requests_on_the_worker(writer):
    gate = Gate()
    writer(gate)
    status, elapsed, worst_gap = counted_request()
    assert status == 401
    assert gate.entered.wait(5) and not gate.release.is_set()  # the write is in flight while the response was served
    assert elapsed < 1 and worst_gap < 0.5
    gate.release.set()
    assert operation_counter.flush()
    assert [c.authorization_denials for c in gate.written] == [1]


def test_a_failing_writer_is_swallowed_and_never_reaches_a_request(writer, caplog):
    failing = Failing()
    writer(failing)
    lost = operation_counter.lost
    operation_counter._last_warning = float('-inf')  # the warning is rate-limited
    assert counted_request()[0] == 401
    assert operation_counter.flush()
    assert failing.calls == 1 and operation_counter.lost == lost + 1
    assert "Operational counts not written (RuntimeError)" in caplog.text


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_a_full_queue_drops_counts_instead_of_growing_or_blocking():
    gate = Gate()
    counter = OperationCounter(gate, limit=4)
    try:
        counter.record(Count())
        assert gate.entered.wait(5)  # the thread holds the first count; the queue is empty
        started = time.perf_counter()
        for _ in range(10):
            counter.record(Count())
        assert time.perf_counter() - started < 1
        assert counter.dropped == 6  # 4 queued, 6 dropped
    finally:
        gate.release.set()
    assert counter.flush()
    assert sum(c.requests for c in gate.written) == 5  # the first, then the 4 queued as one batch
    counter.stop()


def test_stop_drains_then_a_later_count_restarts_the_writer():
    got = []
    counter = OperationCounter(type("W", (), {"write": lambda self, c: got.append(c)})())
    counter.record(Count())
    counter.stop()
    counter.record(Count(failures=1))
    assert counter.flush()
    assert sum(c.requests for c in got) == 2
    counter.stop()


def hour_row():
    with connect() as conn:
        return conn.execute("""SELECT coalesce(sum(requests),0) AS requests, coalesce(sum(failures),0) AS failures,
          coalesce(sum(authorization_denials),0) AS denials, coalesce(sum(elapsed_ms),0) AS elapsed_ms FROM operations_hour""").fetchone()


def projection_failures():
    with connect() as conn:
        return conn.execute("SELECT projection_failures FROM operations_state WHERE singleton").fetchone()["projection_failures"]


def test_counts_reach_operations_hour_and_projection_failures_in_postgres():
    assert operation_counter.flush()
    before, failures_before = hour_row(), projection_failures()

    async def failing_publication(request):
        return JSONResponse({"detail": "failed"}, status_code=500)
    app.add_route("/api/test-counts/publication", failing_publication)
    try:
        async def go():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as http:
                return (await http.get("/api/locations")).status_code, (await http.get("/api/test-counts/publication")).status_code
        statuses = asyncio.run(go())
    finally:
        app.router.routes.pop()
    assert statuses == (401, 500)
    assert operation_counter.flush()
    after = hour_row()
    assert after["requests"] - before["requests"] == 2
    assert after["denials"] - before["denials"] == 1
    assert after["failures"] - before["failures"] == 1
    assert projection_failures() - failures_before == 1


def test_health_and_public_reads_are_never_handed_to_the_writer(writer):
    gate = Gate()
    gate.release.set()
    writer(gate)

    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as http:
            await http.get("/api/health")
            await http.get("/api/public/decks/" + "z" * 32)
            await http.get("/api/public/invites/" + "z" * 32)
    asyncio.run(go())
    assert operation_counter.flush() and gate.written == []
