"""Read JPEG frame dimensions without decoding the image."""
SOF = {0xC0,0xC1,0xC2,0xC3,0xC5,0xC6,0xC7,0xC9,0xCA,0xCB,0xCD,0xCE,0xCF}


def jpeg_size(data: bytes) -> tuple[int, int] | None:
    if not data.startswith(b"\xff\xd8"):
        return None
    i = 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            return None
        marker = data[i + 1]
        if marker == 0xFF:
            i += 1
            continue
        if marker in (0x01, *range(0xD0, 0xD8)):
            i += 2
            continue
        if marker in (0xD9, 0xDA):
            return None
        length = int.from_bytes(data[i+2:i+4], "big")
        if length < 2 or i + 2 + length > len(data):
            return None
        if marker in SOF:
            if length < 7:
                return None
            h, w = int.from_bytes(data[i+5:i+7], "big"), int.from_bytes(data[i+7:i+9], "big")
            return (w, h) if w and h else None
        i += 2 + length
    return None


def image_size(data: bytes, content_type: str) -> tuple[int, int] | None:
    return jpeg_size(data) if content_type == "image/jpeg" else None
