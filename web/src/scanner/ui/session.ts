// One run of the scanner: get the assets, start the recognizer worker, start the camera and pump frames to the worker
// one at a time. No React here; the page gives it callbacks and shows what they report. Everything outside the browser
// (the worker, the frame source, the loader) comes in through `SessionDeps`, which the tests replace.
import type { Frame, FrameSource } from "../frames";
import type {
  FromWorker,
  GateReason,
  LockVia,
  OutcomeReason,
  ScannerAssets,
  ToWorker,
} from "../worker/messages";
import type {
  LoadOptions,
  LoadResult,
  ScannerProgress,
} from "../assets/loader";
import { cameraCause, loadCause, type StartCause } from "./startFailure";

export type WorkerLike = {
  postMessage(message: ToWorker, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null;
  onerror: ((event: Event) => void) | null;
};

export type SessionDeps = {
  loadAssets(options: LoadOptions): Promise<LoadResult>;
  createWorker(): WorkerLike;
  createSource(video: HTMLVideoElement): FrameSource;
  /** Waits for the next moment to look for a frame (an animation frame in the browser). */
  tick(): Promise<void>;
};

export type SessionEvents = {
  onProgress(progress: ScannerProgress): void;
  /** The keys the recognizer reads; again when a background update brings a newer card table. */
  onAssets(assets: ScannerAssets): void;
  onRunning(): void;
  onCannotStart(cause: StartCause): void;
  onGate(ok: boolean, reason: GateReason | undefined): void;
  onLock(lock: {
    lockId: number;
    printingIds: string[];
    via: LockVia;
    lookalikes: string[];
  }): void;
  onAbsent(lockId: number): void;
  onMiss(): void;
};

export class ScannerSession {
  private worker: WorkerLike | null = null;
  private source: FrameSource | null = null;
  private readonly abort = new AbortController();
  private disposed = false;
  private paused = false;
  private inFlight: number | null = null;
  private nextId = 0;
  private pendingSwap: { cards?: string; fingerprints?: string } | null = null;
  private workerReady = false;
  private stopped = false;
  /** Settles once the worker is ready (and a held swap is posted), or the start failed or the session ended. */
  private readonly settled: Promise<void>;
  private settle: () => void = () => {};

  constructor(
    private readonly deps: SessionDeps,
    private readonly events: SessionEvents,
    private readonly video: HTMLVideoElement
  ) {
    this.settled = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  /** Runs to the first frame, or to `onCannotStart`. */
  async start(): Promise<void> {
    let assets: ScannerAssets;
    try {
      const loaded = await this.deps.loadAssets({
        onProgress: (p) => !this.disposed && this.events.onProgress(p),
        signal: this.abort.signal,
        // The loader deletes the entries this update replaces once this settles, so it waits until the worker has
        // finished reading what it started with (ready) and the swap is posted.
        onUpdate: async ({ assets, cards, fingerprints }) => {
          this.swap({ cards, fingerprints });
          if (!this.disposed) this.events.onAssets(assets);
          await this.settled;
        },
      });
      if (this.disposed) return;
      if ("failed" in loaded) return this.fail(loadCause(loaded.failed));
      assets = loaded.assets;
      this.events.onAssets(assets);
    } catch {
      return this.fail("generic");
    }
    const ready = await this.startWorker(assets);
    if (!ready || this.disposed) return;
    try {
      const source = this.deps.createSource(this.video);
      this.source = source;
      await source.start();
      // Closed while the camera was starting: the stream that just arrived must not stay on.
      if (this.disposed) source.stop();
    } catch (error) {
      if (this.disposed) return;
      return this.fail(cameraCause(error));
    }
    if (this.disposed) return;
    this.events.onRunning();
    void this.pump();
  }

  private fail(cause: StartCause): void {
    if (this.disposed) return;
    this.teardown();
    this.settle();
    this.events.onCannotStart(cause);
  }

  private startWorker(assets: ScannerAssets): Promise<boolean> {
    return new Promise((resolve) => {
      let worker: WorkerLike;
      try {
        worker = this.deps.createWorker();
      } catch {
        this.fail("generic");
        resolve(false);
        return;
      }
      this.worker = worker;
      worker.onerror = () => {
        this.fail("generic");
        resolve(false);
      };
      worker.onmessage = (event) => {
        const m = event.data;
        if (m.t === "ready") {
          this.workerReady = true;
          if (this.pendingSwap) this.swap(this.pendingSwap);
          this.settle();
          resolve(true);
        } else if (m.t === "error") {
          this.fail("generic");
          resolve(false);
        } else this.onWorker(m);
      };
      worker.postMessage({ t: "init", assets, debugTiming: false });
    });
  }

  private onWorker(m: FromWorker): void {
    switch (m.t) {
      case "frameDone":
        if (this.inFlight === m.id) this.inFlight = null;
        break;
      case "gate":
        this.events.onGate(m.ok, m.reason);
        break;
      case "lock":
        this.events.onLock({
          lockId: m.lockId,
          printingIds: m.printingIds,
          via: m.via,
          lookalikes: m.lookalikes,
        });
        break;
      case "absent":
        this.events.onAbsent(m.lockId);
        break;
      case "miss":
        this.events.onMiss();
        break;
      default:
        break;
    }
  }

  private swap(update: { cards?: string; fingerprints?: string }): void {
    if (!update.cards && !update.fingerprints) return;
    if (!this.workerReady || !this.worker) {
      this.pendingSwap = { ...this.pendingSwap, ...update };
      return;
    }
    this.pendingSwap = null;
    this.worker.postMessage({ t: "swap", ...update });
  }

  private async pump(): Promise<void> {
    while (!this.disposed && !this.stopped) {
      if (!this.paused && this.inFlight === null && this.source) {
        let frame: Frame | null = null;
        try {
          frame = await this.source.next();
        } catch {
          frame = null;
        }
        if (frame) {
          if (
            this.disposed ||
            this.stopped ||
            !this.worker ||
            this.paused ||
            this.inFlight !== null
          ) {
            frame.bitmap.close();
          } else {
            const id = ++this.nextId;
            this.inFlight = id;
            this.worker?.postMessage(
              { t: "frame", id, bitmap: frame.bitmap, guide: frame.guide },
              [frame.bitmap]
            );
          }
        }
      }
      await this.deps.tick();
    }
  }

  /** The tray sheet, a dialog or a hidden page stops the frames; the worker keeps its state. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.worker?.postMessage({ t: paused ? "pause" : "resume" });
  }

  shutter(): void {
    this.worker?.postMessage({ t: "shutter" });
  }

  answer(lockId: number, added: boolean, reason?: OutcomeReason): void {
    this.worker?.postMessage({ t: "lockOutcome", lockId, added, reason });
  }

  private teardown(): void {
    this.stopped = true;
    this.abort.abort();
    this.worker?.terminate();
    this.worker = null;
    this.source?.stop();
    this.source = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown();
    this.settle();
  }
}
