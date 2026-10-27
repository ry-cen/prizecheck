"""Operational counting off the request path.

The request path calls ``record`` and returns; it never opens a database connection, waits for
one or learns whether a write succeeded. A single background thread drains a bounded queue and
writes each batch with ``CountWriter.write``.

Policy for load and outages (counts are best-effort operational telemetry, never worth a request):
- The queue holds at most ``QUEUE_LIMIT`` counts. When it is full, ``record`` drops the new count
  at once (``dropped`` counts them); nothing blocks and memory cannot grow without bound while the
  database is down or slow.
- The writer folds everything queued into one aggregate and writes it in one transaction, so a
  backlog costs one round trip, not one per request.
- A write is bounded by ``WRITE_TIMEOUT_SECONDS`` (connect timeout and statement timeout). A write
  that fails or times out is discarded (``lost`` counts them) and never retried: the next batch
  tries afresh. The writer swallows every failure of its own; none reaches a request.
- The thread starts on the first count (tests that skip the app lifespan still work) and the app
  lifespan stops it, giving the queue a short, bounded time to drain.

Tests replace the writer with ``set_writer`` (a delayed or failing adapter) and call ``flush`` to
wait for the queue to empty, instead of sleeping.
"""
import queue
import threading
import time
from dataclasses import dataclass
from typing import Callable, Protocol

QUEUE_LIMIT = 256
WRITE_TIMEOUT_SECONDS = 2
STOP_DRAIN_SECONDS = 2.0


@dataclass(frozen=True)
class Count:
    requests: int = 1
    failures: int = 0
    authorization_denials: int = 0
    elapsed_ms: int = 0
    projection_failures: int = 0

    def __add__(self, other: 'Count') -> 'Count':
        return Count(self.requests + other.requests, self.failures + other.failures,
                     self.authorization_denials + other.authorization_denials, self.elapsed_ms + other.elapsed_ms,
                     self.projection_failures + other.projection_failures)


class CountWriter(Protocol):
    def write(self, count: Count) -> None: ...


class DatabaseWriter:
    """Writes into operations_hour and operations_state through the given connection factory."""

    def __init__(self, connect: Callable):
        self._connect = connect

    def write(self, count: Count) -> None:
        timeout_ms = WRITE_TIMEOUT_SECONDS * 1000
        with self._connect(connect_timeout=WRITE_TIMEOUT_SECONDS, options=f'-c statement_timeout={timeout_ms}') as conn:
            conn.execute("""INSERT INTO operations_hour(hour,requests,failures,authorization_denials,elapsed_ms)
              VALUES(date_trunc('hour',now()),%s,%s,%s,%s)
              ON CONFLICT(hour) DO UPDATE SET requests=operations_hour.requests+excluded.requests,
              failures=operations_hour.failures+excluded.failures,
              authorization_denials=operations_hour.authorization_denials+excluded.authorization_denials,
              elapsed_ms=operations_hour.elapsed_ms+excluded.elapsed_ms""",
              (count.requests, count.failures, count.authorization_denials, count.elapsed_ms))
            if count.projection_failures:
                conn.execute('UPDATE operations_state SET projection_failures=projection_failures+%s WHERE singleton',
                             (count.projection_failures,))
            conn.execute("DELETE FROM operations_hour WHERE hour<now()-interval '48 hours'")


class OperationCounter:
    def __init__(self, writer: CountWriter | None = None, limit: int = QUEUE_LIMIT):
        self._writer = writer
        self._queue: queue.Queue[Count] = queue.Queue(maxsize=limit)
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stopping = threading.Event()
        self.dropped = 0
        self.lost = 0

    def set_writer(self, writer: CountWriter | None) -> CountWriter | None:
        previous, self._writer = self._writer, writer
        return previous

    def record(self, count: Count) -> None:
        """Hand off one count without blocking; drops it when the queue is full."""
        try:
            self._ensure_thread()
            self._queue.put_nowait(count)
        except queue.Full:
            self.dropped += 1
        except Exception:  # noqa: BLE001 - counting must never fail a request
            self.dropped += 1

    def flush(self, timeout: float = 5.0) -> bool:
        """Wait until everything queued so far has been written or discarded."""
        deadline = time.monotonic() + timeout
        with self._queue.all_tasks_done:
            while self._queue.unfinished_tasks:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._queue.all_tasks_done.wait(remaining)
        return True

    def stop(self, timeout: float = STOP_DRAIN_SECONDS) -> None:
        """Let the queue drain for a bounded time, then stop the thread; a later count starts a new one."""
        with self._lock:
            thread = self._thread
        if thread is None:
            return
        self.flush(timeout)
        self._stopping.set()
        thread.join(timeout)
        with self._lock:
            if self._thread is thread and not thread.is_alive():
                self._thread = None
                self._stopping = threading.Event()

    def _ensure_thread(self) -> None:
        thread = self._thread
        if thread is not None and thread.is_alive() and not self._stopping.is_set():
            return
        with self._lock:
            thread = self._thread
            if thread is not None and thread.is_alive() and not self._stopping.is_set():
                return
            if thread is not None and thread.is_alive():
                return  # stopping; the count is queued and a later one restarts the thread
            self._stopping = threading.Event()
            self._thread = threading.Thread(target=self._run, args=(self._stopping,), name='operation-counts', daemon=True)
            self._thread.start()

    def _run(self, stopping: threading.Event) -> None:
        while not stopping.is_set():
            try:
                batch = [self._queue.get(timeout=0.2)]
            except queue.Empty:
                continue
            while True:
                try:
                    batch.append(self._queue.get_nowait())
                except queue.Empty:
                    break
            try:
                writer = self._writer
                if writer is not None:
                    total = batch[0]
                    for item in batch[1:]:
                        total = total + item
                    writer.write(total)
            except BaseException:  # noqa: BLE001 - a failed or timed out write is discarded, never raised
                self.lost += len(batch)
            finally:
                for _ in batch:
                    self._queue.task_done()


counter = OperationCounter()
