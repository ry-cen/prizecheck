"""Test-only helper shared by the Riftbound API tests that make requests while the request-count writer is off."""
from app.core.ops.operation_counts import counter


def restore_counter(previous):
    """Drain the counts these Riftbound requests queued while the writer is still off, then put the writer back.

    `record` queues even with no writer and the background thread reads the writer only when it drains, so restoring
    first could write Riftbound request counts to another database (operation_counts.py `flush`, as test_operation_counts does).
    """
    assert counter.flush(), 'queued request counts were not drained'
    assert counter._queue.unfinished_tasks == 0 and counter._queue.empty()
    counter.set_writer(previous)
