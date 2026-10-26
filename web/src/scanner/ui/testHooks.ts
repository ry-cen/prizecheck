// Browser-test seam, loaded only by `chooseDeps` on the dev server when a test set `window.__PRIZECHECK_SCANNER_TEST__`
// before the page loaded (page.addInitScript). It swaps the three real parts for scripted ones: no model, wasm, index
// or card table is fetched, the stub recognizer (testing/stubRecognizer.ts) answers from the script, and a scripted
// source hands it flat-colour frames. Voting, lock, lockOutcome, absent, miss, the tray and the save all run for real.
import type { Frame, FrameSource } from "../frames";
import { expandGuide, guideRect, GUIDE_EXPAND } from "../guide";
import { checkCaps } from "../caps";
import type { StubFrame, StubScript } from "../testing/stubRecognizer";
import type { SessionDeps, WorkerLike } from "./session";
import { nextAnimationFrame } from "./liveDeps";

export type ScriptedFrame = StubFrame & {
  /** The grey level (0..255) the frame is drawn in. The voter's absence rule compares these frames' thumbnails; the
   * default is 200 for a frame with a `top` and 40 for one without. */
  scene?: number;
};
export type ScannerTestScript = Omit<StubScript, "frames"> & {
  frames: ScriptedFrame[];
  /** The camera fails to start: `denied` (permission) or `none` (no camera). */
  camera?: "denied" | "none";
  /** What the asset load answers (default: it succeeds). `hold` shows `progress` and never finishes. */
  assets?: "ok" | "cannot-start" | "hold";
  progress?: { loaded: number; total: number };
};
export type ScannerTestHook = {
  script: ScannerTestScript;
  /** Frames the scripted source has handed out so far; a test waits on it to know the script has moved on. */
  played?: number;
};

const VIDEO_W = 640;
const VIDEO_H = 480;

/** Hands out frames in script order, one grey frame each, cropped as the camera's are. */
export class ScriptedFrameSource implements FrameSource {
  private index = 0;
  constructor(
    private readonly script: ScannerTestScript,
    /** True while a lock waits for its `lockOutcome`: no frame is handed out then, so the script cannot run ahead of the
     * tray's printings call. */
    private readonly holding: () => boolean = () => false,
    private readonly played: (n: number) => void = () => {}
  ) {}

  start(): Promise<void> {
    if (this.script.camera === "denied")
      return Promise.reject(new DOMException("denied", "NotAllowedError"));
    if (this.script.camera === "none")
      return Promise.reject(new DOMException("none", "NotFoundError"));
    return Promise.resolve();
  }

  async next(): Promise<Frame | null> {
    if (this.holding()) return null;
    const frames = this.script.frames;
    const i = this.index++;
    this.played(this.index);
    const entry =
      frames.length === 0
        ? {}
        : frames[
            this.script.loop
              ? i % frames.length
              : Math.min(i, frames.length - 1)
          ];
    const grey = entry.scene ?? (entry.top?.length ? 200 : 40);
    const g = guideRect(VIDEO_W, VIDEO_H);
    const [sx, sy, sw, sh] = expandGuide(g, GUIDE_EXPAND, VIDEO_W, VIDEO_H);
    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = `rgb(${grey},${grey},${grey})`;
    ctx.fillRect(0, 0, sw, sh);
    return {
      bitmap: await createImageBitmap(canvas),
      guide: [g[0] - sx, g[1] - sy, g[2] - sx, g[3] - sy],
      crop: [sx, sy, sw, sh],
      guideInVideo: g,
      videoW: VIDEO_W,
      videoH: VIDEO_H,
      t: performance.now(),
    };
  }

  stop(): void {}
}

/** Wraps the stub worker to see which locks still wait for their `lockOutcome`. A suggestion is not held: its frames must
 * keep coming so the card can leave the guide. */
function watched(real: Worker, waiting: Set<number>): WorkerLike {
  const wrapped: WorkerLike = {
    postMessage: (message, transfer) => {
      if (message.t === "lockOutcome") waiting.delete(message.lockId);
      real.postMessage(message, transfer ?? []);
    },
    terminate: () => real.terminate(),
    get onmessage() {
      return real.onmessage as WorkerLike["onmessage"];
    },
    set onmessage(handler) {
      real.onmessage = handler
        ? (event: MessageEvent) => {
            const m = event.data;
            if (m.t === "lock" && m.via !== "suggest") waiting.add(m.lockId);
            handler(event);
          }
        : null;
    },
    get onerror() {
      return real.onerror as WorkerLike["onerror"];
    },
    set onerror(handler) {
      real.onerror = handler as Worker["onerror"];
    },
  };
  return wrapped;
}

export function stubDeps(raw: unknown): SessionDeps {
  const hook = raw as ScannerTestHook;
  const script = hook.script;
  const waiting = new Set<number>();
  hook.played = 0;
  return {
    loadAssets: async (options) => {
      if (!checkCaps().ok) return { failed: "unsupported" };
      if (script.assets === "cannot-start") return { failed: "cannot-start" };
      if (script.progress) options.onProgress?.(script.progress);
      if (script.assets === "hold")
        return new Promise(() => {
          // Never settles: the page keeps showing the progress bar.
        });
      return {
        assets: {
          embedder: "/scanner/m/stub/embedder.onnx",
          ocr: "/scanner/m/stub/ocr.onnx",
          dict: "/scanner/m/stub/dict.txt",
          cards: "/api/scanner/cards/stub",
          fingerprints: null,
        },
      };
    },
    createWorker: () =>
      watched(
        new Worker(
          new URL("../testing/stubRecognizer.worker.ts", import.meta.url),
          { type: "module", name: JSON.stringify(script) }
        ),
        waiting
      ),
    createSource: () =>
      new ScriptedFrameSource(
        script,
        () => waiting.size > 0,
        (n) => {
          hook.played = n;
        }
      ),
    tick: nextAnimationFrame,
  };
}

/** Alias used by the browser tests' helpers. */
export type ScannedTestFrame = ScriptedFrame;
