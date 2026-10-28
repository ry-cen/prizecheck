"""FilePublicProjection.read_record: one parse per installed manifest, fresh objects, and every replacement seen (#77)."""
import json
import os
import threading
from pathlib import Path

import pytest

from app.main import app  # noqa: F401
from app import public_projection
from app.public_projection import FilePublicProjection, ProjectionUnavailable

A, B = 'A' * 32, 'B' * 32


def record(value):
    return {'visibility': 'unlisted', 'snapshot': {'n': value}}


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv('PUBLIC_PROJECTION_DIR', str(tmp_path))
    with FilePublicProjection().writer(initialize=True):
        pass
    parses = []
    real = public_projection._record_texts

    def counting(decks):
        parses.append(1)
        return real(decks)
    monkeypatch.setattr(public_projection, '_record_texts', counting)
    return FilePublicProjection(), parses


def swap(projection, change, compact=True):
    """An out-of-band atomic replacement that keeps the revision."""
    value = json.loads(projection.path.read_text())
    change(value['decks'])
    pending = projection.path.with_name('.pending-test')
    pending.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':') if compact else None))
    os.replace(pending, projection.path)


def test_the_manifest_is_parsed_once_until_the_writer_replaces_it(store):
    projection, parses = store
    projection.apply(A, record(1))
    projection.apply(B, record(2))
    assert [projection.read_record(t)['snapshot']['n'] for t in (A, B, A)] == [1, 2, 1]
    assert len(parses) == 1
    projection.apply(A, None)
    assert projection.read_record(A) is None and projection.read_record(B) == record(2)
    assert len(parses) == 2


def test_each_read_is_a_fresh_object(store):
    projection, _ = store
    projection.apply(A, record(1))
    projection.read_record(A)['snapshot']['n'] = 99
    assert projection.read_record(A) == record(1)


def test_an_atomic_rewrite_with_the_same_revision_is_seen(store):
    projection, _ = store
    projection.apply(A, record(1))
    assert projection.read_record(A) == record(1)
    swap(projection, lambda decks: decks.update({A: record(2)}))
    assert projection.read_record(A) == record(2)


def test_same_size_same_revision_replacements_are_each_seen(store):
    projection, _ = store
    projection.apply(A, record('0000'))
    for i in range(50):
        projection.read_record(A)
        swap(projection, lambda decks: decks.update({A: record(f'{i:04d}')}))
        assert projection.read_record(A)['snapshot']['n'] == f'{i:04d}'


def test_an_in_place_rewrite_that_changes_the_size_is_seen(store):
    projection, _ = store
    projection.apply(A, record(1))
    projection.read_record(A)
    value = json.loads(projection.path.read_text())
    value['decks'][A] = record('a longer value')
    Path(projection.path).write_text(json.dumps(value, separators=(',', ':')))
    assert projection.read_record(A) == record('a longer value')


def test_a_broken_manifest_is_unavailable_even_after_a_cached_read(store):
    projection, _ = store
    projection.apply(A, record(1))
    good = json.loads(projection.path.read_text())
    broken = [b'not json', json.dumps({**good, 'format': 2}).encode(), json.dumps({**good, 'decks': []}).encode(),
              b'\xff\xfe{"format":1}']
    for body in broken:
        assert projection.read_record(A) == record(1)  # fills the cache
        pending = projection.path.with_name('.pending-test')
        pending.write_bytes(body)
        os.replace(pending, projection.path)
        with pytest.raises(ProjectionUnavailable):
            projection.read_record(A)
        pending.write_text(json.dumps(good, separators=(',', ':')))
        os.replace(pending, projection.path)
        assert projection.read_record(A) == record(1)
    projection.path.unlink()
    with pytest.raises(ProjectionUnavailable):
        projection.read_record(A)


def test_concurrent_readers_across_a_replacement_end_on_the_newest_manifest(store):
    projection, _ = store
    projection.apply(A, record(0))
    failures = []

    def read():
        try:
            for _ in range(50):
                projection.read_record(A)
        except BaseException as exc:  # noqa: BLE001
            failures.append(exc)
    threads = [threading.Thread(target=read) for _ in range(8)]
    for thread in threads:
        thread.start()
    for i in range(1, 11):
        projection.apply(A, record(i))
    for thread in threads:
        thread.join(30)
    assert failures == []
    assert projection.read_record(A) == record(10)


def test_two_projection_directories_do_not_share_records(tmp_path, monkeypatch):
    for name, value in (('one', 1), ('two', 2)):
        monkeypatch.setenv('PUBLIC_PROJECTION_DIR', str(tmp_path / name))
        with FilePublicProjection().writer(initialize=True) as writer:
            writer.apply(A, record(value))
    for name, value in (('one', 1), ('two', 2), ('one', 1)):
        monkeypatch.setenv('PUBLIC_PROJECTION_DIR', str(tmp_path / name))
        assert FilePublicProjection().read_record(A) == record(value)
