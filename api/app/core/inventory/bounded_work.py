"""Run blocking work so a caller's own clock bounds its wait, with a hard cap on the threads that work can leave running.

A bare thread per call, abandoned when late, grows without limit while a dependency stalls. A ``Lane`` takes a slot
before it starts a daemon thread and gives the slot back only when the work itself returns, so a lane never has more live
worker threads than its limit. Work that the caller gave up on keeps its slot until it ends on its own timeouts. A caller
waits for a slot only inside its own timeout; when none frees in time, or the wait used the budget up, the call is never
started and the caller gets ``Late``. The threads stay daemon threads, so stalled work never holds up interpreter exit.
"""
import threading
import time


class Late(Exception):
    """The work did not finish, or could not start, inside the caller's budget."""


class Lane:
    """At most ``limit`` live worker threads. The lane is the cap on live threads, not on callers."""

    def __init__(self, name: str, limit: int):
        if limit < 1:
            raise ValueError('limit')
        self.name = name
        self.limit = limit
        self._slots = threading.BoundedSemaphore(limit)
        self._lock = threading.Lock()
        self._live = 0

    def live(self) -> int:
        with self._lock:
            return self._live

    def _add(self, n: int) -> None:
        with self._lock:
            self._live += n

    def run(self, call, timeout: float):
        """The value of ``call()``, or its exception re-raised, or ``Late``. Abandoned work keeps its slot until it
        returns on its own timeouts; the wait for a slot counts against ``timeout``."""
        if not timeout > 0:  # also catches NaN
            raise Late()
        deadline = time.monotonic() + timeout
        if not self._slots.acquire(timeout=timeout):
            raise Late()
        if time.monotonic() >= deadline:  # the wait for the slot used up the budget: never start the call
            self._slots.release()
            raise Late()
        self._add(1)
        box = {}

        def work():
            try:
                box['value'] = call()
            except BaseException as exc:  # noqa: BLE001 - re-raised in the caller
                box['error'] = exc
            finally:
                self._add(-1)
                self._slots.release()  # only when the work itself ends, never when the caller gives up

        try:
            thread = threading.Thread(target=work, name=self.name, daemon=True)
            thread.start()
        except BaseException as exc:  # no thread runs the work, so nothing else will give the slot back
            self._add(-1)
            self._slots.release()
            if isinstance(exc, Exception):  # RuntimeError, MemoryError: the call never started inside the budget
                raise Late() from None
            raise  # KeyboardInterrupt, SystemExit: not ours to swallow, but the slot is already back
        thread.join(max(0.0, deadline - time.monotonic()))
        if thread.is_alive():
            raise Late()
        if 'error' in box:
            raise box['error']
        return box['value']
