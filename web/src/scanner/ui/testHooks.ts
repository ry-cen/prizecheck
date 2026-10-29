// Browser-test seam, loaded only by `chooseDeps` on the dev server when a test set `window.__PRIZECHECK_SCANNER_TEST__`
// before the page loaded (page.addInitScript). It swaps the three real parts for scripted ones: no model, wasm, index
// or card table is fetched, the stub recognizer (testing/stubRecognizer.ts) answers from the script, and a scripted
// source hands it flat-colour frames. Voting, lock, lockOutcome, absent, miss, the tray and the save all run for real.
import { CameraFrameSource, type Frame, type FrameSource } from "../frames";
import { expandGuide, guideRect, GUIDE_EXPAND } from "../guide";
import { checkCaps } from "../caps";
import type { StubFrame, StubScript } from "../testing/stubRecognizer";
import type { SessionDeps, WorkerLike } from "./session";
import { nextAnimationFrame } from "./liveDeps";

export type ScriptedFrame = StubFrame & {
  /** A synthetic PNG under web/tests/fixtures/scanner/ (a 640x480 video frame, as the dev server serves it), e.g.
   * `/tests/fixtures/scanner/card-a.png`. The voter's absence rule compares these pictures' guide thumbnails. */
  url: string;
};
export type ScannerTestScript = Omit<StubScript, "frames"> & {
  frames: ScriptedFrame[];
  /** The camera fails to start: `denied` (permission) or `none` (no camera). */
  camera?: "denied" | "none";
  /** What the asset load answers (default: it succeeds). `hold` shows `progress` and never finishes. */
  assets?: "ok" | "cannot-start" | "hold";
  progress?: { loaded: number; total: number };
  /** `camera`: the frames come from the real `CameraFrameSource` (Chromium's fake device), not from `frames`' pictures. The
   * stub recognizer still answers from `frames`. */
  source?: "camera";
  /** Frames keep coming while a choice prompt is open, so the script can take the card out of the guide with the prompt
   * showing. Without it the source waits for every lock's `lockOutcome`, so a tap can come before the script moves on. */
  walkAway?: boolean;
};
export type ScannerTestHook = {
  script: ScannerTestScript;
  /** Frames the scripted source has handed out so far; a test waits on it to know the script has moved on. */
  played?: number;
  /** Frames the recognizer worker has finished (its `frameDone`): the frames reached the worker. */
  delivered?: number;
  /** `self.crossOriginIsolated` as the recognizer worker reports it, once it has answered. */
  workerIsolated?: boolean;
};

/** Worker message of the test seam only (not part of the worker contract): the page asks, the stub worker answers. */
export const ISOLATION_PROBE = "test:isolated?";
export const ISOLATION_ANSWER = "test:isolated";

const VIDEO_W = 640;
const VIDEO_H = 480;

/** Hands out frames in script order, one grey frame each, cropped as the camera's are. */
export class ScriptedFrameSource implements FrameSource {
  private index = 0;
  private readonly pictures = new Map<string, Promise<ImageBitmap>>();
  constructor(
    private readonly script: ScannerTestScript,
    /** True while a lock waits for its `lockOutcome`: no frame is handed out then, so the script cannot run ahead of the
     * tray's printings call. */
    private readonly holding: () => boolean = () => false,
    private readonly played: (n: number) => void = () => {}
  ) {}

  async start(): Promise<void> {
    if (this.script.camera === "denied")
      throw new DOMException("denied", "NotAllowedError");
    if (this.script.camera === "none")
      throw new DOMException("none", "NotFoundError");
    // Preload every picture, so a missing fixture fails the start and a frame never waits on the network.
    await Promise.all(this.script.frames.map((f) => this.picture(f.url)));
  }

  private picture(url: string): Promise<ImageBitmap> {
    let found = this.pictures.get(url);
    if (!found) {
      found = fetch(url).then(async (response) => {
        if (!response.ok) throw new Error(`fixture ${url}: ${response.status}`);
        return createImageBitmap(await response.blob());
      });
      this.pictures.set(url, found);
    }
    return found;
  }

  async next(): Promise<Frame | null> {
    if (this.holding()) return null;
    const frames = this.script.frames;
    const i = this.index++;
    this.played(this.index);
    const entry =
      frames[
        this.script.loop ? i % frames.length : Math.min(i, frames.length - 1)
      ];
    const picture = await this.picture(entry.url);
    const g = guideRect(VIDEO_W, VIDEO_H);
    const [sx, sy, sw, sh] = expandGuide(g, GUIDE_EXPAND, VIDEO_W, VIDEO_H);
    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(picture, sx, sy, sw, sh, 0, 0, sw, sh);
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

  stop(): void {
    for (const p of this.pictures.values()) void p.then((b) => b.close());
    this.pictures.clear();
  }
}

/** The real camera source, counting the frames it hands out (the smoke test's proof that the camera delivers). */
class CountingCamera implements FrameSource {
  private readonly camera: CameraFrameSource;
  private n = 0;
  constructor(
    video: HTMLVideoElement,
    private readonly played: (n: number) => void
  ) {
    this.camera = new CameraFrameSource(video);
  }
  start = () => this.camera.start();
  async next(): Promise<Frame | null> {
    const frame = await this.camera.next();
    if (frame) this.played(++this.n);
    return frame;
  }
  stop = () => this.camera.stop();
}

/** Wraps the stub worker to see which locks still wait for their `lockOutcome` (see `createSource` for when the
 * frames are held). */
function watched(
  real: Worker,
  waiting: Set<number>,
  hook: ScannerTestHook
): WorkerLike {
  real.postMessage({ t: ISOLATION_PROBE });
  let delivered = 0;
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
            if (m.t === ISOLATION_ANSWER) {
              hook.workerIsolated = m.value;
              return;
            }
            if (m.t === "frameDone") hook.delivered = ++delivered;
            if (m.t === "lock") waiting.add(m.lockId);
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
  hook.delivered = 0;
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
        waiting,
        hook
      ),
    createSource: (video) =>
      script.source === "camera"
        ? new CountingCamera(video, (n) => {
            hook.played = n;
          })
        : new ScriptedFrameSource(
            script,
            // With `walkAway`, an open prompt does not hold the frames: the card can be taken out of the guide.
            () =>
              waiting.size > 0 &&
              !(
                script.walkAway &&
                document.querySelector('[data-testid="scan-suggestion"]')
              ),
            (n) => {
              hook.played = n;
            }
          ),
    tick: nextAnimationFrame,
  };
}

/** Alias used by the browser tests' helpers. */
export type ScannedTestFrame = ScriptedFrame;
