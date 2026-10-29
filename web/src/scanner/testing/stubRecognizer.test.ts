import { describe, expect, it } from "vitest";
import type { Img } from "../types";
import type { FromWorker, ToWorker } from "../worker/messages";
import { StubRecognizer } from "./stubRecognizer";
import type { StubScript } from "./stubRecognizer";

type FakeBitmap = ImageBitmap & { luma: number };
const flat = (luma: number): Img => ({
  width: 100,
  height: 140,
  channels: 3,
  data: new Uint8Array(100 * 140 * 3).fill(luma),
});
const bitmap = (luma: number): FakeBitmap =>
  ({ luma, width: 100, height: 140, close() {} }) as unknown as FakeBitmap;
const CARD = 120;
const TABLE = 60; // thumbnail difference 60 > 24: the card has left the guide
const GUIDE: [number, number, number, number] = [10, 10, 90, 130];

function rig(script: StubScript) {
  const out: FromWorker[] = [];
  let t = 0;
  const stub = new StubRecognizer(
    script,
    (m) => out.push(m),
    (b) => flat((b as FakeBitmap).luma),
    () => (t += 100)
  );
  let id = 0;
  const send = (m: ToWorker) => stub.handle(m);
  const frame = (luma = CARD) =>
    send({ t: "frame", id: ++id, bitmap: bitmap(luma), guide: GUIDE });
  const sent = (type: FromWorker["t"]) => out.filter((m) => m.t === type);
  return { out, send, frame, sent };
}

describe("StubRecognizer", () => {
  it("answers init with ready and every frame with frameDone", () => {
    const r = rig({ frames: [{ top: ["A"] }] });
    r.send({ t: "init", assets: {} as never, debugTiming: false });
    r.frame();
    expect(r.out[0]).toEqual({ t: "ready", imageMatching: true });
    expect(r.out.at(-1)).toEqual({ t: "frameDone", id: 1 });
  });

  it("a number-backed script locks automatically, a second placement needs a gap", () => {
    const f = { top: ["A", "B"], ocr: ["A"] };
    const r = rig({
      frames: [f, f, f, { gate: "ok" }, { gate: "ok" }, f, f, f],
    });
    for (let i = 0; i < 3; i++) r.frame();
    expect(r.sent("lock")).toEqual([
      {
        t: "lock",
        lockId: 1,
        printingIds: ["A", "B"],
        via: "auto",
        lookalikes: [],
      },
    ]);
    r.send({ t: "lockOutcome", lockId: 1, added: true });
    r.frame(TABLE);
    r.frame(TABLE);
    for (let i = 0; i < 3; i++) r.frame();
    expect(r.sent("lock")).toHaveLength(2);
  });

  it("an image-only script suggests, posts absent once when the card leaves, and dismissed waits for a fresh absence", () => {
    const f = { top: ["A", "B", "C"] };
    const r = rig({ frames: [f, f, f, {}, {}, {}, {}, f, f, f] });
    for (let i = 0; i < 3; i++) r.frame();
    expect(r.sent("lock")).toEqual([
      {
        t: "lock",
        lockId: 1,
        printingIds: ["A", "B", "C"],
        via: "suggest",
        lookalikes: [],
      },
    ]);
    r.frame(TABLE);
    r.frame(TABLE);
    r.frame(TABLE);
    expect(r.sent("absent")).toEqual([{ t: "absent", lockId: 1 }]);
    r.send({ t: "lockOutcome", lockId: 1, added: false, reason: "dismissed" });
    r.frame(TABLE);
    r.frame(TABLE); // the fresh absence
    for (let i = 0; i < 3; i++) r.frame();
    expect(r.sent("lock")).toHaveLength(2);
  });

  it("frames with no card give no lock and no suggestion", () => {
    const r = rig({ frames: [{ top: ["A"], eligible: false }], loop: true });
    for (let i = 0; i < 30; i++) r.frame();
    expect(r.sent("lock")).toEqual([]);
    expect(r.sent("miss")).toEqual([]);
  });

  it("a failing gate reports its reason and runs no recognition", () => {
    const r = rig({
      frames: [{ gate: "dark", top: ["A"], ocr: ["A"] }],
      loop: true,
    });
    for (let i = 0; i < 6; i++) r.frame();
    expect(r.sent("gate")[0]).toEqual({
      t: "gate",
      id: 1,
      ok: false,
      reason: "dark",
    });
    expect(r.sent("lock")).toEqual([]);
  });

  it("the shutter locks the window leader, posts miss with no candidate, and does nothing while a suggestion is pending", () => {
    const r = rig({ frames: [{ top: ["A", "B"] }, {}, { top: ["A"] }] });
    r.frame();
    r.send({ t: "shutter" });
    expect(r.sent("lock")).toEqual([
      {
        t: "lock",
        lockId: 1,
        printingIds: ["A", "B"],
        via: "shutter",
        lookalikes: [],
      },
    ]);
    r.send({ t: "lockOutcome", lockId: 1, added: true });
    const m = rig({ frames: [{}] });
    m.send({ t: "shutter" });
    m.frame();
    expect(m.sent("miss")).toEqual([{ t: "miss" }]);
    const s = rig({ frames: [{ top: ["A"] }], loop: true });
    for (let i = 0; i < 3; i++) s.frame();
    expect(s.sent("lock")).toHaveLength(1);
    s.send({ t: "shutter" });
    s.frame();
    expect(s.sent("lock")).toHaveLength(1);
    expect(s.sent("miss")).toEqual([]);
  });

  it("script shutter miss posts miss at once", () => {
    const r = rig({ frames: [{ top: ["A"] }], shutter: "miss" });
    r.send({ t: "shutter" });
    expect(r.sent("miss")).toEqual([{ t: "miss" }]);
  });

  it("drops frames while paused", () => {
    const f = { top: ["A"], ocr: ["A"] };
    const r = rig({ frames: [f], loop: true });
    r.send({ t: "pause" });
    for (let i = 0; i < 5; i++) r.frame();
    expect(r.sent("lock")).toEqual([]);
    expect(r.sent("frameDone")).toHaveLength(5);
    r.send({ t: "resume" });
    for (let i = 0; i < 3; i++) r.frame();
    expect(r.sent("lock")).toHaveLength(1);
  });

  it("scripted lookalikes reach the lock message", () => {
    const f = { top: ["A", "B"], ocr: ["A", "L2"] };
    const r = rig({
      frames: [f, f, f],
      lookalikes: { A: ["L1", "L2"], B: ["L9"] },
    });
    for (let i = 0; i < 3; i++) r.frame();
    // An automatic lock keeps only what the scripted OCR numbers support.
    expect(r.sent("lock")).toEqual([
      {
        t: "lock",
        lockId: 1,
        printingIds: ["A", "B"],
        via: "auto",
        lookalikes: ["L2"],
      },
    ]);
  });
});
