"""The art storage contract (#358, A1.10): every ArtStorage implementation must pass these through the interface only."""
import threading

import pytest

from app.art_storage import DiskArtStorage, check_key


# A later S3-compatible implementation adds its name to params and builds itself here; the tests below do not change.
@pytest.fixture(params=["disk"])
def store_kind(request):
    return request.param


@pytest.fixture
def store(store_kind, tmp_path):
    return DiskArtStorage(tmp_path / "art")


def test_get_missing_is_none(store):
    assert store.get("tcgdex/small/ab/missing") is None


@pytest.mark.parametrize("size", [1, 2 * 1024 * 1024])
def test_put_then_get_round_trips(store, size):
    data = bytes(range(256)) * (size // 256 + 1)
    data = data[:size]
    store.put("a/b", data)
    assert store.get("a/b") == data


def test_put_overwrites(store):
    store.put("k", b"one")
    store.put("k", b"two!")
    assert store.get("k") == b"two!"


def test_delete_then_get_is_none_and_delete_missing_is_silent(store):
    store.put("k", b"x")
    store.delete("k")
    assert store.get("k") is None
    store.delete("k")
    store.delete("never/was")


def test_nested_keys_work(store):
    store.put("tcgdex/small/ab/abcd-0123456789abcdef", b"1")
    store.put("tcgdex/large/ab/abcd-0123456789abcdef", b"2")
    assert store.get("tcgdex/small/ab/abcd-0123456789abcdef") == b"1"
    assert store.get("tcgdex/large/ab/abcd-0123456789abcdef") == b"2"


@pytest.mark.parametrize("key", ["", "/a", "a//b", "a/../b", "A/b", "a/b/", "x" * 256, "a\\b", "..", "a/./b", ".hidden"])
def test_invalid_keys_raise(store, key):
    with pytest.raises(ValueError):
        check_key(key)
    with pytest.raises(ValueError):
        store.put(key, b"x")
    with pytest.raises(ValueError):
        store.get(key)
    with pytest.raises(ValueError):
        store.delete(key)


def test_valid_keys_pass_the_check():
    assert check_key("a") == "a" and check_key("x" * 255) == "x" * 255 and check_key("a.b-c_d/e") == "a.b-c_d/e"


def test_concurrent_puts_leave_one_whole_object(store):
    payloads = [bytes([index]) * (50_000 + index) for index in range(8)]
    start = threading.Barrier(8)

    def write(data):
        start.wait()
        store.put("same/key", data)

    threads = [threading.Thread(target=write, args=(data,)) for data in payloads]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert store.get("same/key") in payloads


def test_disk_leaves_no_temp_files(store_kind, store, tmp_path):
    if store_kind != "disk":
        pytest.skip("disk only")
    store.put("a/b", b"1")
    store.put("a/b", b"22")
    store.delete("a/b")
    store.put("a/c", b"3")
    assert [path.name for path in (tmp_path / "art").rglob("*") if path.is_file()] == ["c"]
