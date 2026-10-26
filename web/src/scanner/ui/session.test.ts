import { describe, expect, it, vi } from "vitest";
import type { Frame } from "../frames";
import type { FromWorker, ScannerAssets, ToWorker } from "../worker/messages";
import {
  ScannerSession,
  type SessionDeps,
  type SessionEvents,
  type WorkerLike,
} from "./session";

const assets: ScannerAssets = {
  embedder: "e",
  ocr: "o",
  dict: "d",
  cards: "c1",
  fingerprints: null,
};

function harness(
  opts: {
    load?: SessionDeps["loadAssets"];
    startError?: unknown;
    answerInit?: FromWorker | null;
  } = {}
) {
  const posted: ToWorker[] = [];
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    terminate: vi.fn(),
    postMessage(m) {
      posted.push(m);
      if (m.t === "init" && opts.answerInit !== null)
        queueMicrotask(() =>
          worker.onmessage?.({
            data: opts.answerInit ?? { t: "ready", imageMatching: true },
          } as MessageEvent<FromWorker>)
        );
    },
  };
  const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
  const frame: Frame = {
    bitmap,
    guide: [1, 2, 3, 4],
    crop: [0, 0, 10, 10],
    guideInVideo: [0, 0, 1, 1],
    videoW: 10,
    videoH: 10,
    t: 0,
  };
  const source = {
    start: vi.fn(async () => {
      if (opts.startError) throw opts.startError;
    }),
    next: vi.fn(async () => frame),
    stop: vi.fn(),
  };
  let ticks = 0;
  let release: (() => void) | null = null;
  const deps: SessionDeps = {
    loadAssets: opts.load ?? (async () => ({ assets })),
    createWorker: () => worker,
    createSource: () => source,
    tick: () =>
      new Promise<void>((resolve) => {
        ticks++;
        release = resolve;
      }),
  };
  const events: SessionEvents = {
    onProgress: vi.fn(),
    onAssets: vi.fn(),
    onRunning: vi.fn(),
    onCannotStart: vi.fn(),
    onGate: vi.fn(),
    onLock: vi.fn(),
    onAbsent: vi.fn(),
    onMiss: vi.fn(),
  };
  const session = new ScannerSession(deps, events, {} as HTMLVideoElement);
  const step = async () => {
    release?.();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { session, events, posted, worker, source, step, ticks: () => ticks };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("ScannerSession", () => {
  it("starts the worker with the loaded assets, then the camera, then runs", async () => {
    const h = harness();
    await h.session.start();
    expect(h.posted[0]).toEqual({ t: "init", assets, debugTiming: false });
    expect(h.events.onRunning).toHaveBeenCalledOnce();
    h.session.dispose();
  });

  it("sends one frame at a time, until the worker says frameDone", async () => {
    const h = harness();
    await h.session.start();
    await settle();
    const frames = () => h.posted.filter((m) => m.t === "frame");
    expect(frames()).toHaveLength(1);
    await h.step();
    await h.step();
    expect(frames()).toHaveLength(1);
    const id = (frames()[0] as { id: number }).id;
    h.worker.onmessage?.({
      data: { t: "frameDone", id },
    } as MessageEvent<FromWorker>);
    await h.step();
    expect(frames()).toHaveLength(2);
    h.session.dispose();
  });

  it("sends no frames while paused and says so to the worker", async () => {
    const h = harness();
    await h.session.start();
    await settle();
    h.session.setPaused(true);
    expect(h.posted.at(-1)).toEqual({ t: "pause" });
    const before = h.posted.filter((m) => m.t === "frame").length;
    h.worker.onmessage?.({
      data: { t: "frameDone", id: 1 },
    } as MessageEvent<FromWorker>);
    await h.step();
    await h.step();
    expect(h.posted.filter((m) => m.t === "frame")).toHaveLength(before);
    h.session.setPaused(false);
    expect(h.posted.at(-1)).toEqual({ t: "resume" });
    h.session.dispose();
  });

  it("passes locks, absences, misses and gates on, and answers a lock", async () => {
    const h = harness();
    await h.session.start();
    const say = (data: FromWorker) =>
      h.worker.onmessage?.({ data } as MessageEvent<FromWorker>);
    say({ t: "lock", lockId: 3, printingIds: ["a"], via: "suggest" });
    say({ t: "absent", lockId: 3 });
    say({ t: "miss" });
    say({ t: "gate", id: 1, ok: false, reason: "dark" });
    expect(h.events.onLock).toHaveBeenCalledWith({
      lockId: 3,
      printingIds: ["a"],
      via: "suggest",
    });
    expect(h.events.onAbsent).toHaveBeenCalledWith(3);
    expect(h.events.onMiss).toHaveBeenCalledOnce();
    expect(h.events.onGate).toHaveBeenCalledWith(false, "dark");
    h.session.answer(3, false, "dismissed");
    expect(h.posted.at(-1)).toEqual({
      t: "lockOutcome",
      lockId: 3,
      added: false,
      reason: "dismissed",
    });
    h.session.dispose();
  });

  it("posts swap from a background update, and holds one until the worker is ready", async () => {
    let onUpdate!: Parameters<SessionDeps["loadAssets"]>[0]["onUpdate"];
    const h = harness({
      load: async (o) => {
        onUpdate = o.onUpdate;
        return { assets };
      },
      answerInit: null,
    });
    const started = h.session.start();
    await settle();
    let settled = false;
    const update = Promise.resolve(
      onUpdate?.({ assets: { ...assets, cards: "c2" }, cards: "c2" })
    ).then(() => (settled = true));
    await settle();
    // The loader deletes old entries once this settles: not before the worker is ready and the swap is posted.
    expect(settled).toBe(false);
    expect(h.posted.some((m) => m.t === "swap")).toBe(false);
    h.worker.onmessage?.({
      data: { t: "ready", imageMatching: true },
    } as MessageEvent<FromWorker>);
    await started;
    await update;
    expect(h.posted).toContainEqual({ t: "swap", cards: "c2" });
    expect(h.events.onAssets).toHaveBeenLastCalledWith(
      expect.objectContaining({ cards: "c2" })
    );
    h.session.dispose();
  });

  it("stops a camera that finishes starting after the session was closed", async () => {
    let finish!: () => void;
    const h = harness();
    h.source.start.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const started = h.session.start();
    await settle();
    h.session.dispose();
    finish();
    await started;
    expect(h.source.stop).toHaveBeenCalled();
    expect(h.events.onRunning).not.toHaveBeenCalled();
  });

  it("stops looking for frames, and closes any it was handed, once it has failed", async () => {
    const h = harness();
    await h.session.start();
    await settle();
    h.worker.onerror?.({} as Event);
    expect(h.events.onCannotStart).toHaveBeenCalledWith("generic");
    const calls = h.source.next.mock.calls.length;
    await h.step();
    await h.step();
    expect(h.source.next.mock.calls.length).toBeLessThanOrEqual(calls + 1);
    await h.step();
    expect(h.source.next.mock.calls.length).toBeLessThanOrEqual(calls + 1);
  });

  it.each([
    ["unsupported", "unsupported"],
    ["cannot-start", "generic"],
  ] as const)("a failed load (%s) cannot start (%s)", async (failed, cause) => {
    const h = harness({ load: async () => ({ failed }) });
    await h.session.start();
    expect(h.events.onCannotStart).toHaveBeenCalledWith(cause);
    expect(h.events.onRunning).not.toHaveBeenCalled();
  });

  it("a worker error is the generic failure", async () => {
    const h = harness({ answerInit: { t: "error", code: "ASSET_INVALID" } });
    await h.session.start();
    expect(h.events.onCannotStart).toHaveBeenCalledWith("generic");
    expect(h.worker.terminate).toHaveBeenCalled();
  });

  it("names a denied or missing camera", async () => {
    const denied = harness({
      startError: new DOMException("x", "NotAllowedError"),
    });
    await denied.session.start();
    expect(denied.events.onCannotStart).toHaveBeenCalledWith("denied");
    const none = harness({
      startError: new DOMException("x", "NotFoundError"),
    });
    await none.session.start();
    expect(none.events.onCannotStart).toHaveBeenCalledWith("no-camera");
  });
});
