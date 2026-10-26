#!/usr/bin/env python3
"""Regenerate the committed scanner parity fixtures under web/src/scanner/fixtures/parity/.

The fixtures pin the hand-written TypeScript image primitives in web/src/scanner/vision/ to OpenCV and to the
spike's Python (corner finder, gate, rectify, OCR crops). They need cv2, numpy and the `scanspike` package, so run
this with the spike repository's Python (the shared .venv has no cv2):

  /Users/raian/dev/prizecheck-scan-spike/.venv/bin/python scripts/make_scanner_fixtures.py \
      --spike /Users/raian/dev/prizecheck-scan-spike            # spike checkout at commit 4e3d827

Fixture rule (docs/planning/card-scanner/wayfinder/resolutions/decide-scanner-plumbing.md): every fixture is
synthetic and carries no Pokemon card artwork. The scene cards are drawn from flat colours, lines and OpenCV's
Hershey font; the art region (card fractions x 0.08 to 0.92, y 0.10 to 0.55) is one flat colour. Output is
deterministic (fixed seed, lossless PNG and raw little-endian blobs) and the script fails if it exceeds 2 MB.
Real-art fixtures are never written here; they live in the gitignored web/src/scanner/__local__/.

The browser fixtures (web/tests/fixtures/scanner/) are written by `--browser`, which needs only cv2 and numpy (no spike):

  /Users/raian/dev/prizecheck-scan-spike/.venv/bin/python scripts/make_scanner_fixtures.py --browser

They are the frames of the Playwright specs' scripted source (640x480 PNGs: an empty table and two flat-colour,
card-shaped rectangles with a drawn number) and the fake-camera clip `synthetic-card.mjpeg` (320x240, 20 frames).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np

REPO = Path(__file__).resolve().parent.parent
FIX = REPO / "web" / "src" / "scanner" / "fixtures" / "parity"
SEED = 20261022
BROWSER_FIX = REPO / "web" / "tests" / "fixtures" / "scanner"
BROWSER_W, BROWSER_H = 640, 480
CLIP_W, CLIP_H, CLIP_FRAMES, CLIP_CAP = 320, 240, 20, 200_000
SPAN_SEEDS = 8
TOTAL_CAP = 2_000_000
BLOB_SCENES = 3  # scenes that also carry the rectified card, OCR crops and the 224 embed image


def atomic_write_bytes(path, data: bytes) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    part.write_bytes(data)
    os.replace(part, path)


def compact_json(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def write_png(path, logical: np.ndarray) -> None:
    """Lossless PNG whose file order is the *logical* channel order (cv2 stores BGR, so 3-channel arrays are flipped)."""
    arr = np.ascontiguousarray(logical[..., ::-1]) if logical.ndim == 3 else np.ascontiguousarray(logical)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.stem + ".part.png")
    if not cv2.imwrite(str(tmp), arr, [cv2.IMWRITE_PNG_COMPRESSION, 9]):
        raise RuntimeError(f"cannot write {path}")
    os.replace(tmp, path)


_DT = {np.dtype(np.uint8): "u8", np.dtype(np.int8): "i8", np.dtype("<f4"): "f32", np.dtype("<f8"): "f64"}


class Out:
    """Writes blobs under a root and returns their `Blob` descriptors."""

    def __init__(self, root):
        self.root = Path(root)

    def bin(self, rel: str, arr: np.ndarray) -> dict:
        arr = np.asarray(arr)
        dt = {np.dtype(np.float32): np.dtype("<f4"), np.dtype(np.float64): np.dtype("<f8")}.get(arr.dtype, arr.dtype)
        arr = np.ascontiguousarray(arr.astype(dt, copy=False))
        atomic_write_bytes(self.root / rel, arr.tobytes())
        return {"file": rel, "dtype": _DT[arr.dtype], "shape": list(arr.shape)}

    def img(self, rel: str, logical: np.ndarray) -> dict:
        assert logical.dtype == np.uint8 and rel.endswith(".png")
        assert logical.ndim == 2 or (logical.ndim == 3 and logical.shape[2] == 3)
        write_png(self.root / rel, logical)
        return {"file": rel, "dtype": "u8", "shape": list(logical.shape)}

    def json(self, rel: str, obj) -> None:
        atomic_write_bytes(self.root / rel, compact_json(obj))

    def bytes(self, rel: str, data: bytes) -> None:
        atomic_write_bytes(self.root / rel, data)


def measure_groups(root) -> int:
    return sum(p.stat().st_size for p in Path(root).rglob("*") if p.is_file())


# ------------------------------------------------------------------ facts
def make_facts() -> dict:
    imp = np.zeros((7, 7), np.float32)
    imp[3, 3] = 1.0
    lap = cv2.Laplacian(imp, cv2.CV_32F, ksize=3)
    px = lambda bgr: int(cv2.cvtColor(np.array([[bgr]], np.uint8), cv2.COLOR_BGR2GRAY)[0, 0])  # noqa: E731
    return {
        "cv2": cv2.__version__, "numpy": np.__version__,
        "laplacian3": lap[2:5, 2:5].astype(float).tolist(),
        "gaussian5": [float(v) for v in cv2.getGaussianKernel(5, 0).ravel()],
        "gray": {"blue": px((255, 0, 0)), "green": px((0, 255, 0)), "red": px((0, 0, 255)),
                 "mixed": {"rgb": [17, 99, 201], "gray": px((201, 99, 17))}},
        "round_half": [round(0.5), round(1.5), round(2.5), float(np.round(2.5)), float(np.rint(-0.5))],
    }


def gate_grey512(img_bgr, guide_rect):
    """The grey region `gate.measure` works on, kept in step with it by an assertion."""
    from scanspike import gate

    h, w = img_bgr.shape[:2]
    x0, y0, x1, y1 = guide_rect
    xa, ya = max(0, int(round(x0))), max(0, int(round(y0)))
    xb, yb = min(w, int(round(x1))), min(h, int(round(y1)))
    crop = img_bgr[ya:yb, xa:xb]
    g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    ch, cw = g.shape[:2]
    s = gate.WORK_H / ch
    interp = cv2.INTER_AREA if s < 1.0 else cv2.INTER_LINEAR
    return cv2.resize(g, (max(1, round(cw * s)), gate.WORK_H), interpolation=interp)


def ocr_resize(crop_bgr):
    h, w = crop_bgr.shape[:2]
    nw = max(8, int(round(w * 48 / h)))
    interp = cv2.INTER_CUBIC if h < 48 else cv2.INTER_AREA
    return cv2.resize(crop_bgr, (nw, 48), interpolation=interp)


# ------------------------------------------------------------------ fixtures: prim
def smooth(rng, h, w, c):
    base = rng.integers(0, 256, (math.ceil(h / 12), math.ceil(w / 12), c), dtype=np.uint8)
    img = cv2.resize(base, (w, h), interpolation=cv2.INTER_CUBIC).reshape(h, w, c).astype(np.int16)
    img = img + rng.integers(-1, 2, img.shape)
    return np.clip(img, 0, 255).astype(np.uint8)


def rand_convex_quad(rng):
    from scanspike.corners import order_quad  # noqa: F401

    while True:
        j = rng.uniform(-0.2, 0.2, (4, 2))
        base = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], np.float64)
        q = ((base + j) * np.array([300.0, 420.0]) + np.array([40.0, 30.0])).astype(np.float32)
        if cv2.isContourConvex(q.reshape(-1, 1, 2)) and abs(cv2.contourArea(q)) > 20000:
            return q


def make_prim(out: Out, rng) -> list:
    from scanspike import corners

    prim = []

    def add(id_, op, params, inp, outb):
        prim.append({"id": id_, "op": op, "params": params, "in": inp, "out": outb})

    def bgr_of(rgb):
        return np.ascontiguousarray(rgb[..., ::-1]) if rgb.ndim == 3 else rgb

    def logical_of(bgr):
        return np.ascontiguousarray(bgr[..., ::-1]) if bgr.ndim == 3 else bgr

    # gray
    rgb = rng.integers(0, 256, (48, 64, 3), dtype=np.uint8)
    add("gray-0", "gray", {}, out.img("prim/gray-0-in.png", rgb),
        out.img("prim/gray-0-out.png", cv2.cvtColor(bgr_of(rgb), cv2.COLOR_BGR2GRAY)))
    # lab
    rgb = rng.integers(0, 256, (32, 32, 3), dtype=np.uint8)
    add("lab-0", "lab", {}, out.img("prim/lab-0-in.png", rgb),
        out.img("prim/lab-0-out.png", cv2.cvtColor(bgr_of(rgb), cv2.COLOR_BGR2LAB)))
    idx = np.arange(4096)
    lv = (np.arange(16) * 17).astype(np.uint8)
    grid = np.stack([lv[idx // 256], lv[(idx // 16) % 16], lv[idx % 16]], axis=1).reshape(64, 64, 3)
    add("lab-grid", "lab", {}, out.img("prim/lab-grid-in.png", grid),
        out.img("prim/lab-grid-out.png", cv2.cvtColor(bgr_of(grid), cv2.COLOR_BGR2LAB)))
    # resize: (id, mode, c, (h, w), (dh, dw))
    cases = [("area", 3, (120, 86), (31, 31)), ("area", 1, (150, 109), (56, 40)), ("area", 3, (64, 64), (16, 16)),
             ("area", 3, (60, 200), (48, 160)), ("linear", 1, (30, 40), (53, 70)), ("cubic", 3, (37, 210), (48, 272)),
             ("cubic", 3, (31, 170), (48, 263))]
    interp = {"area": cv2.INTER_AREA, "linear": cv2.INTER_LINEAR, "cubic": cv2.INTER_CUBIC}
    for i, (mode, c, (h, w), (dh, dw)) in enumerate(cases):
        src = smooth(rng, h, w, c)
        src2 = src[..., 0] if c == 1 else src
        res = cv2.resize(bgr_of(src2), (dw, dh), interpolation=interp[mode])
        add(f"resize-{i}", "resize", {"mode": mode, "dw": dw, "dh": dh}, out.img(f"prim/resize-{i}-in.png", src2),
            out.img(f"prim/resize-{i}-out.png", logical_of(res)))
    # gauss5
    g = rng.integers(0, 256, (48, 64), dtype=np.uint8)
    add("gauss5-0", "gauss5", {}, out.img("prim/gauss5-0-in.png", g),
        out.img("prim/gauss5-0-out.png", cv2.GaussianBlur(g, (5, 5), 0)))
    # sobel dx / dy
    s8 = rng.integers(0, 256, (48, 64), dtype=np.uint8)
    sf = s8.astype(np.float32)
    sin = out.bin("prim/sobel-in.f32", sf)
    for name, dx, dy in (("dx", 1, 0), ("dy", 0, 1)):
        add(f"sobel-{name}", "sobel", {"dx": dx, "dy": dy}, sin,
            out.bin(f"prim/sobel-{name}-out.f32", cv2.Sobel(sf, cv2.CV_32F, dx, dy, ksize=3)))
    # laplacian3
    l8 = rng.integers(0, 256, (48, 64), dtype=np.uint8)
    add("laplacian3-0", "laplacian3", {}, out.img("prim/laplacian3-0-in.png", l8),
        out.bin("prim/laplacian3-0-out.f32", cv2.Laplacian(l8, cv2.CV_32F, ksize=3)))
    # perspective
    dst = np.array([[0, 0], [629, 0], [629, 879], [0, 879]], np.float32)
    for i in range(5):
        q = rand_convex_quad(rng)
        M = cv2.getPerspectiveTransform(q, dst)
        add(f"perspective-{i}", "perspective", {}, out.bin(f"prim/perspective-{i}-in.f64", q.astype(np.float64)),
            out.bin(f"prim/perspective-{i}-out.f64", M.astype(np.float64)))
    # warp
    wsrc = smooth(rng, 75, 100, 3)
    wb = out.img("prim/warp-in.png", wsrc)
    wdst = np.array([[0, 0], [62, 0], [62, 87], [0, 87]], np.float32)
    for i in range(3):
        j = rng.uniform(-1, 1, (4, 2)) * np.array([8.0, 6.0])
        q = (np.array([[14, 10], [86, 10], [86, 64], [14, 64]], np.float64) + j).astype(np.float32)
        M = cv2.getPerspectiveTransform(q, wdst)
        res = cv2.warpPerspective(bgr_of(wsrc), M, (63, 88), flags=cv2.INTER_LINEAR)
        add(f"warp-{i}", "warp", {"dw": 63, "dh": 88, "flags": "linear"},
            [wb, out.bin(f"prim/warp-{i}-M.f64", M.astype(np.float64))], out.img(f"prim/warp-{i}-out.png", logical_of(res)))
    # fitline
    for i in range(5):
        n = int(rng.integers(20, 41))
        ang = rng.uniform(0, math.pi)
        d = np.array([math.cos(ang), math.sin(ang)])
        c0 = rng.uniform(50, 250, 2)
        t = rng.uniform(-100, 100, n)
        pts = (c0 + t[:, None] * d + rng.normal(0, 1.5, (n, 2))).astype(np.float32)
        line = cv2.fitLine(pts, cv2.DIST_L2, 0, 0.01, 0.01).ravel().astype(np.float32)
        add(f"fitline-{i}", "fitline", {}, out.bin(f"prim/fitline-{i}-in.f32", pts), out.bin(f"prim/fitline-{i}-out.f32", line))
    # area / convex / order: 10 quads each, 2 degenerate
    def quads10():
        qs = [rand_convex_quad(rng) for _ in range(6)]
        for k in (1, 3, 5):  # shuffled vertex order: only `order` cares, area/convex see a self-crossing quad
            qs[k] = qs[k][rng.permutation(4)]
        q = rand_convex_quad(rng)
        q[2] = q.mean(axis=0) * 0.6 + q[0] * 0.4  # concave: one vertex pushed inside
        qs.append(q)
        q = rand_convex_quad(rng)
        q[1] = q[0] + (q[2] - q[0]) * 0.3  # reflex/degenerate-ish, still a proper quad
        qs.append(q)
        q = rand_convex_quad(rng)
        q[[1, 2]] = q[[2, 1]]  # degenerate: self-crossing (bowtie) order
        qs.append(q)
        c0 = rng.uniform(40, 200, 2)
        dd = rng.uniform(-1, 1, 2)
        qs.append((c0 + np.arange(4)[:, None] * dd * 40).astype(np.float32))  # degenerate: collinear points
        return qs

    for op, fn in (("area", lambda q: np.array([abs(cv2.contourArea(q))], np.float64)),
                   ("convex", lambda q: np.array([1 if cv2.isContourConvex(q.reshape(-1, 1, 2)) else 0], np.uint8)),
                   ("order", lambda q: np.asarray(corners.order_quad(q), np.float32))):
        for i, q in enumerate(quads10()):
            suffix = {"area": "f64", "convex": "bin", "order": "f32"}[op]
            add(f"{op}-{i}", op, {"degenerate": i >= 8}, out.bin(f"prim/{op}-{i}-in.f32", q.astype(np.float32)),
                out.bin(f"prim/{op}-{i}-out.{suffix}", fn(q)))
    return prim


# ------------------------------------------------------------------ fixtures: scenes
SCENE_COLORS = [(50, 20, 70), (20, 60, 30), (70, 40, 15), (15, 30, 80), (60, 20, 50),
                (80, 60, 15), (40, 30, 70), (30, 70, 50), (25, 50, 75), (60, 35, 35)]
SCENE_SIZES = [(540, 720)] * 8 + [(360, 480)] * 2
SCENE_GRADIENT = {1, 4, 7, 9}
DEFAULT_SCENE_PARAMS = {"dark": 0.25, "ellipse_area": 0.30, "blur": 0.8, "line_grey": 120, "text_scale_left": 0.9,
                        "text_scale_right": None, "jitter": 0.03, "shift9": 0.45, "noise_sigma": 4.0}


def make_template(art_bgr, p) -> tuple[np.ndarray, dict]:
    from scanspike.corners import CARD_W, CARD_H

    assert (CARD_W, CARD_H) == (630, 880)
    t = np.empty((880, 630, 3), np.uint8)
    t[:] = (0, 200, 240)
    t[22:858, 22:608] = (215, 225, 230)
    x0, x1, y0, y1 = (round(0.08 * 630), round(0.92 * 630), round(0.10 * 880), round(0.55 * 880))
    t[y0:y1, x0:x1] = art_bgr
    g = int(p["line_grey"])
    cv2.line(t, (50, 520), (420, 520), (g, g, g), 7)
    cv2.line(t, (50, 560), (300, 560), (g, g, g), 7)
    font = cv2.FONT_HERSHEY_SIMPLEX
    # number strip text: "025/198" inside the left crop box (x 19..227, y 818..855), the long string in the right box
    cv2.putText(t, "025/198", (26, 846), font, p["text_scale_left"], (0, 0, 0), 2, cv2.LINE_AA)
    right = "SVI EN 025/198"
    scale = p["text_scale_right"]
    if scale is None:  # the brief's 0.9 overflows the 163 px box; shrink only this string so it fits inside the panel
        scale = 0.9
        while cv2.getTextSize(right, font, scale, 2)[0][0] > 146:
            scale -= 0.01
        scale = round(scale, 2)
    cv2.putText(t, right, (458, 850), font, scale, (0, 0, 0), 2 if scale >= 0.6 else 1, cv2.LINE_AA)
    return t, {"text_scale_right": scale, "right_text_width": cv2.getTextSize(right, font, scale, 2 if scale >= 0.6 else 1)[0][0]}


def make_scene(i: int, p: dict) -> tuple[np.ndarray, tuple, dict]:
    from scanspike.guide import guide_quad, guide_rect

    W, H = SCENE_SIZES[i]
    rng = np.random.default_rng([SEED, 100 + i])
    guide = guide_rect(W, H)
    gh = guide[3] - guide[1]
    tmpl, tinfo = make_template(SCENE_COLORS[i], p)
    if i in SCENE_GRADIENT:
        col = np.linspace(70, 112, H).astype(np.float32)[:, None, None] * np.array([1.0, 1.05, 1.1], np.float32)
        bg = np.broadcast_to(col, (H, W, 3)).copy()
    else:
        bg = np.empty((H, W, 3), np.float32)
        bg[:] = (90, 95, 100)
    if i == 3 and p["noise_sigma"] > 0:
        bg = bg + np.random.default_rng([SEED, 200]).normal(0, p["noise_sigma"], bg.shape).astype(np.float32)
    bg = np.clip(np.rint(bg), 0, 255).astype(np.uint8)
    quad = guide_quad(guide).astype(np.float64) + rng.uniform(-1, 1, (4, 2)) * p["jitter"] * gh
    ang = math.radians(rng.uniform(-3, 3))
    c = quad.mean(axis=0)
    R = np.array([[math.cos(ang), -math.sin(ang)], [math.sin(ang), math.cos(ang)]])
    quad = (quad - c) @ R.T + c
    if i == 9:
        quad = quad + p["shift9"] * gh
    src = np.array([[0, 0], [629, 0], [629, 879], [0, 879]], np.float32)
    M = cv2.getPerspectiveTransform(src, quad.astype(np.float32))
    img = cv2.warpPerspective(tmpl, M, (W, H), dst=bg, flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_TRANSPARENT)
    if p["blur"] > 0:
        img = cv2.GaussianBlur(img, (0, 0), p["blur"])
    if i == 6:
        img = np.clip(np.rint(img.astype(np.float32) * p["dark"]), 0, 255).astype(np.uint8)
    if i == 7:
        cc = quad.mean(axis=0)
        cw = np.linalg.norm(quad[1] - quad[0])
        ch = np.linalg.norm(quad[3] - quad[0])
        a = math.sqrt(4 * p["ellipse_area"] / math.pi) / 2  # axes as a fraction of the card so area = ellipse_area
        cv2.ellipse(img, (int(round(cc[0])), int(round(cc[1]))), (int(round(a * cw)), int(round(a * ch))), 0, 0, 360,
                    (255, 255, 255), -1, cv2.LINE_8)
    return img, tuple(float(v) for v in guide), tinfo


def assess_scenes(uctx, params) -> tuple[list, list]:
    """Build the 10 scenes, run the Python reference on each, and return (rows, failed assertions)."""
    from scanspike import corners, gate

    rows = []
    for i in range(10):
        img, guide, tinfo = make_scene(i, params)
        m = gate.measure(img, guide)
        ok, reasons = gate.decide(m, uctx.gate_cfg)
        g512 = gate_grey512(img, guide)
        assert abs(float(g512.mean()) - m["mean_luma"]) < 1e-9, "gate_grey512 drifted from gate.measure"
        res = corners.find_card_guided(img, guide)
        rows.append({"i": i, "img": img, "guide": guide, "m": m, "ok": bool(ok), "reasons": list(reasons), "g512": g512,
                     "quad": None if res.quad is None else np.asarray(res.quad, np.float64), "tinfo": tinfo})
    fails = []
    if "dark" not in rows[6]["reasons"]:
        fails.append("scene 6 gate reasons lack 'dark'")
    if "clipped" not in rows[7]["reasons"]:
        fails.append("scene 7 gate reasons lack 'clipped'")
    # clear passes only: a scene within 1% of sharp_min would make the TS decision check meaningless
    clear = sum(r["ok"] and r["m"]["sharpness"] >= 1.01 * uctx.gate_cfg.sharp_min for r in rows)
    if clear < 3:
        fails.append(f"only {clear} scenes pass the tuned gate by more than 1% of sharp_min")
    if sum(r["quad"] is not None for r in rows[:9]) < 7:
        fails.append(f"only {sum(r['quad'] is not None for r in rows[:9])} of scenes 0-8 have a quad")
    if rows[9]["quad"] is not None:
        fails.append("scene 9 has a quad")
    return rows, fails


SCENE_PARAM_LADDER = [{"dark": d, "blur": b, "line_grey": g}
                      for b, g in ((0.8, 120), (0.5, 120), (0.5, 0), (0.0, 120), (0.0, 60), (0.0, 0))
                      for d in (0.25, 0.15, 0.10)]


def choose_scenes(uctx) -> tuple[list, dict, list]:
    tried = []
    for delta in SCENE_PARAM_LADDER:
        params = {**DEFAULT_SCENE_PARAMS, **delta}
        rows, fails = assess_scenes(uctx, params)
        tried.append({"delta": delta, "fails": fails, "gate_ok": [r["ok"] for r in rows],
                      "quads": [r["quad"] is not None for r in rows],
                      "sharpness": [round(r["m"]["sharpness"]) for r in rows]})
        if not fails:
            return rows, params, tried
    raise SystemExit("STOP (brief section 6): no scene parameter setting satisfies the assertions:\n"
                     + json.dumps(tried, indent=1))


def make_scenes(out: Out, uctx, rows, params, blob_scenes: int) -> list:
    from scanspike import corners, ocr

    entries = []
    for r in rows:
        i = r["i"]
        img = r["img"]
        guide = r["guide"]
        W, H = SCENE_SIZES[i]
        png = f"scenes/s{i:02d}.png"
        write_png(out.root / png, img[..., ::-1])
        thumb = cv2.resize(r["g512"], (32, 32), interpolation=cv2.INTER_AREA)
        e = {"id": f"s{i:02d}", "png": png, "width": W, "height": H, "guide": list(guide),
             "gate": {"sharpness": float(r["m"]["sharpness"]), "mean_luma": float(r["m"]["mean_luma"]),
                      "clipped_frac": float(r["m"]["clipped_frac"]), "ok": r["ok"], "reasons": r["reasons"]},
             "thumb": out.bin(f"scenes/s{i:02d}-thumb.bin", thumb),
             "quad": None if r["quad"] is None else r["quad"].tolist()}
        if i < blob_scenes:
            from scanspike.guide import guide_quad

            quad_used = r["quad"] if r["quad"] is not None else guide_quad(guide).astype(np.float64)
            card = corners.rectify(img, quad_used.astype(np.float32))
            e["quadUsed"] = np.asarray(quad_used, np.float64).tolist()
            e["card"] = out.img(f"scenes/s{i:02d}-card.png", card[..., ::-1])
            crops = ocr.crop_regions(card, uctx.ocr_cfg)
            e["ocr"] = []
            for (name, *_), crop in zip(uctx.ocr_cfg.crops, crops):
                e["ocr"].append({"name": name, "crop": out.img(f"scenes/s{i:02d}-ocr-{name}-crop.png", crop[..., ::-1]),
                                 "resized": out.img(f"scenes/s{i:02d}-ocr-{name}-resized.png", ocr_resize(crop)[..., ::-1])})
            e224 = cv2.resize(cv2.cvtColor(card, cv2.COLOR_BGR2RGB), (224, 224), interpolation=cv2.INTER_AREA)
            e["embed224"] = out.img(f"scenes/s{i:02d}-embed224.png", e224)
        entries.append(e)
    return entries


# ------------------------------------------------------------------ fixtures: browser
def browser_frame(w: int, h: int, card_bgr, label: str | None, shift: int = 0) -> np.ndarray:
    """A table (flat, dark) with a card-shaped rectangle on the guide (flat colour, light border, a drawn number).

    The rectangle is the guide's 63:88 shape at 80% of the height, as web/src/scanner/guide.ts places it, so a
    frame's 32x32 guide thumbnail differs a lot between a card and the bare table (the voter's absence rule)."""
    img = np.empty((h, w, 3), np.uint8)
    img[:] = (38, 36, 34)
    if label is None:
        return img
    gh = 0.8 * h
    gw = gh * 63 / 88
    x0, y0 = int(round((w - gw) / 2)) + shift, int(round((h - gh) / 2))
    x1, y1 = x0 + int(round(gw)), y0 + int(round(gh))
    cv2.rectangle(img, (x0, y0), (x1, y1), (215, 225, 230), -1)
    pad = max(2, int(gw * 0.04))
    cv2.rectangle(img, (x0 + pad, y0 + pad), (x1 - pad, y1 - pad), card_bgr, -1)
    scale = max(0.3, w / 640 * 0.8)
    cv2.putText(img, label, (x0 + pad, y1 - pad - 4), cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), 1, cv2.LINE_AA)
    return img


def make_browser(root: Path) -> int:
    """Writes the Playwright fixtures and returns their total size in bytes."""
    if root.exists():
        shutil.rmtree(root)
    for name, colour, label in (("table", None, None), ("card-a", (160, 120, 70), "025/198"),
                                ("card-b", (70, 140, 100), "061/191")):
        write_png(root / f"{name}.png", browser_frame(BROWSER_W, BROWSER_H, colour or (0, 0, 0), label)[..., ::-1])
    # The fake camera's clip: concatenated JPEG frames (Chromium reads .mjpeg as a motion-JPEG stream). The card slides a
    # little each frame so the frames differ.
    frames = []
    for i in range(CLIP_FRAMES):
        f = browser_frame(CLIP_W, CLIP_H, (160, 120, 70), "025/198", shift=(i % 5) * 2 - 4)
        ok, jpg = cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, 70])
        assert ok
        frames.append(jpg.tobytes())
    clip = b"".join(frames)
    if len(clip) > CLIP_CAP:
        raise SystemExit(f"FAIL: synthetic-card.mjpeg is {len(clip)} bytes, over the {CLIP_CAP} byte cap")
    atomic_write_bytes(root / "synthetic-card.mjpeg", clip)
    return measure_groups(root)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--browser", action="store_true",
                    help="write only the Playwright fixtures (web/tests/fixtures/scanner/); needs no spike")
    ap.add_argument("--spike", type=Path, help="spike checkout (prizecheck-scan-spike at commit 4e3d827)")
    ap.add_argument("--out", type=Path, default=FIX)
    ap.add_argument("--dry-run", action="store_true", help="generate into a temp dir, print the size, delete it")
    a = ap.parse_args(argv)
    if a.browser:
        total = make_browser(BROWSER_FIX if a.out == FIX else a.out)
        print(f"scanner browser fixtures: {total} bytes in {BROWSER_FIX if a.out == FIX else a.out}")
        if total > TOTAL_CAP:
            print(f"FAIL: fixtures are {total} bytes, over the {TOTAL_CAP} byte cap", file=sys.stderr)
            return 1
        return 0
    if a.spike is None:
        ap.error("--spike is required unless --browser is given")
    sys.path.insert(0, str(a.spike.resolve()))
    from scanspike import gate, ocr

    uctx = SimpleNamespace(gate_cfg=gate.load_gate_config()[0], ocr_cfg=ocr.OcrConfig())
    rows, params, tried = choose_scenes(uctx)
    root = Path(tempfile.mkdtemp(prefix="scanner-fixtures-")) if a.dry_run else a.out
    if not a.dry_run and root.exists():
        shutil.rmtree(root)
    out = Out(root)
    ss = np.random.SeedSequence(SEED).spawn(SPAN_SEEDS)
    out.json("facts.json", make_facts())
    prim = make_prim(out, np.random.default_rng(ss[0]))
    scenes = make_scenes(out, uctx, rows, params, BLOB_SCENES)
    scene_params = {**params, "text_scale_right": rows[0]["tinfo"]["text_scale_right"], "blob_scenes": BLOB_SCENES,
                    "art_colors_bgr": [list(c) for c in SCENE_COLORS], "art_region": "x 0.08-0.92, y 0.10-0.55, flat colour"}
    out.json("manifest.json", {"schema": "prizecheck-scan-parity/1", "seed": SEED, "facts": "facts.json",
                               "prim": prim, "scenes": scenes, "sceneParams": scene_params})
    total = measure_groups(root)
    print(f"scanner fixtures: {total} bytes in {root}")
    if a.dry_run:
        shutil.rmtree(root)
    if total > TOTAL_CAP:
        print(f"FAIL: fixtures are {total} bytes, over the {TOTAL_CAP} byte cap", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
