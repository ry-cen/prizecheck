"""public_deck's reference-proof rule (tickets 12 to 14), without a database."""
import threading
import time
from dataclasses import replace

import pytest
from fastapi import HTTPException

from app.main import app  # noqa: F401
from app.games.pokemon.publications import public_deck
from app.bounded_work import Lane, Late
from app.games.pokemon.publications.public_deck import FrozenRow, SnapshotLate, same_printing, read_current, read_for_export


def test_same_printing_proves_only_a_frozen_pair_whose_edition_record_names_the_frozen_printing():
    row = FrozenRow("Furret", "swsh3", "Darkness Ablaze", "136", {"finish": "normal"}, None, 1, "a" * 48, "b" * 48)
    assert same_printing(row, "b" * 48)
    assert not same_printing(row, "c" * 48) and not same_printing(row, None)
    legacy = replace(row, edition_ref=None, printing_ref=None)
    assert not same_printing(legacy, None) and not same_printing(legacy, "b" * 48)
    assert not same_printing(replace(row, printing_ref=None), None)


def test_a_full_projection_lane_is_snapshot_late_without_reading(monkeypatch):
    lane, gate = Lane('t', 1), threading.Event()
    monkeypatch.setattr(public_deck, 'PROJECTION_LANE', lane)
    monkeypatch.setattr(public_deck, '_record', lambda *args, **kwargs: pytest.fail('the read must not start'))
    try:
        with pytest.raises(Late):
            lane.run(lambda: gate.wait(5), 0.01)
        with pytest.raises(SnapshotLate):
            read_current('A' * 32, deadline=time.monotonic() + 0.05)
        with pytest.raises(HTTPException) as caught:
            read_for_export('A' * 32, 1, deadline=time.monotonic() + 0.05)
        assert caught.value.status_code == 503 and caught.value.detail == {'code': 'PUBLIC_PROJECTION_UNAVAILABLE'}
    finally:
        gate.set()
