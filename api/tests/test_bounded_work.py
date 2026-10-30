"""Lane: a hard cap on the worker threads that abandoned work leaves running (#77), without a database."""
import threading
import time

import pytest

from app.main import app  # noqa: F401
from app import bounded_work
from app.games.pokemon.prices import prices
from app.bounded_work import Lane, Late


def drain(lane):
    end = time.monotonic() + 5
    while lane.live() and time.monotonic() < end:
        time.sleep(0.01)
    assert lane.live() == 0


def test_a_lane_returns_the_value_and_reraises_the_error():
    lane = Lane('t', 1)
    assert lane.run(lambda: 7, 1) == 7
    error = KeyError('x')

    def fail():
        raise error
    with pytest.raises(KeyError) as caught:
        lane.run(fail, 1)
    assert caught.value is error
    assert lane.live() == 0


def test_late_work_keeps_its_slot_until_it_ends_and_a_full_lane_never_starts_the_call():
    lane, gate, started = Lane('t', 2), threading.Event(), []
    try:
        for _ in range(2):
            with pytest.raises(Late):
                lane.run(lambda: gate.wait(5), 0.05)
        assert lane.live() == 2
        with pytest.raises(Late):
            lane.run(lambda: started.append(1), 0.05)
        assert started == []
    finally:
        gate.set()
    drain(lane)
    assert lane.run(lambda: 1, 1) == 1


def test_a_caller_waits_for_a_slot_inside_its_budget():
    lane, go = Lane('t', 1), threading.Event()
    holder = threading.Thread(target=lambda: lane.run(lambda: go.wait(5), 5), daemon=True)
    holder.start()
    try:
        end = time.monotonic() + 5
        while lane.live() != 1 and time.monotonic() < end:
            time.sleep(0.01)
        assert lane.live() == 1
        threading.Thread(target=lambda: (time.sleep(0.05), go.set()), daemon=True).start()
        assert lane.run(lambda: 'ok', 2) == 'ok'
    finally:
        go.set()
    holder.join(5)
    drain(lane)


def test_a_slot_acquired_after_the_deadline_is_released_without_starting(monkeypatch):
    class Clock:
        def __init__(self):
            self.calls = 0

        def monotonic(self):
            self.calls += 1
            return 0.0 if self.calls == 1 else 10.0

    lane, started = Lane('t', 1), []
    with monkeypatch.context() as patched:
        patched.setattr(bounded_work, 'time', Clock())
        with pytest.raises(Late):
            lane.run(lambda: started.append(1), 1)
    assert started == [] and lane.live() == 0
    assert lane.run(lambda: 1, 1) == 1


def test_a_spent_budget_is_late_without_starting():
    lane, started = Lane('t', 1), []
    for budget in (0, -1):
        with pytest.raises(Late):
            lane.run(lambda: started.append(1), budget)
    assert started == [] and lane.live() == 0


def test_a_thread_that_cannot_start_frees_its_slot(monkeypatch):
    class Refuses:
        def __init__(self, *args, **kwargs):
            pass

        def start(self):
            raise RuntimeError("can't start new thread")

    lane = Lane('t', 1)
    with monkeypatch.context() as patched:
        patched.setattr(bounded_work.threading, 'Thread', Refuses)
        with pytest.raises(Late):
            lane.run(lambda: 1, 1)
    assert lane.live() == 0
    assert lane.run(lambda: 1, 1) == 1


def test_a_lane_needs_a_slot():
    with pytest.raises(ValueError):
        Lane('t', 0)


def test_prices_late_is_the_lane_late():
    assert prices._Late is Late


@pytest.mark.parametrize('error, outcome', [(MemoryError, Late), (RuntimeError, Late), (KeyboardInterrupt, KeyboardInterrupt)])
def test_a_thread_that_cannot_start_gives_its_slot_back(monkeypatch, error, outcome):
    lane = Lane('t', 1)

    class Broken:
        def __init__(self, *args, **kwargs):
            pass

        def start(self):
            raise error()
    monkeypatch.setattr(bounded_work.threading, 'Thread', Broken)
    with pytest.raises(outcome):
        lane.run(lambda: 1, 1)
    assert lane.live() == 0
    monkeypatch.undo()
    assert lane.run(lambda: 2, 1) == 2
