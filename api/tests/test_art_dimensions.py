"""JPEG frame dimensions, without decoding."""
import pytest
from app.core.art.dimensions import image_size


def jpeg(w=717, h=1000, marker=0xC0):
    return b'\xff\xd8\xff' + bytes([marker]) + b'\x00\x11\x08' + h.to_bytes(2,'big') + w.to_bytes(2,'big') + b'\x03' + b'\0'*9 + b'\xff\xd9'


@pytest.mark.parametrize('marker', [0xC0, 0xC2])
def test_frame_headers(marker):
    assert image_size(jpeg(marker=marker), 'image/jpeg') == (717,1000)


def test_fill_and_app_segment():
    body = jpeg()
    assert image_size(body[:2]+b'\xff'+body[2:], 'image/jpeg') == (717,1000)
    assert image_size(body[:2]+b'\xff\xe0\x00\x04ab'+body[2:], 'image/jpeg') == (717,1000)


@pytest.mark.parametrize('data,kind', [(jpeg()[:10],'image/jpeg'), (b'\xff\xd8\xff\xda\x00\x02','image/jpeg'),
                                     (jpeg(),'image/webp'), (b'not jpeg','image/jpeg'), (jpeg(w=0),'image/jpeg')])
def test_unreadable(data, kind):
    assert image_size(data, kind) is None
