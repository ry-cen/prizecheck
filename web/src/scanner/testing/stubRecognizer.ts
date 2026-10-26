// A stub recognizer that speaks the worker message contract, for the browser tests (no model, wasm, index or card table).
// It replaces only the gate verdict and the ranking, which come from the script. Voting (eligibility, suggestions, the
// absence rule on the real 32x32 thumbnails of the scripted bitmaps), `lock`, `lockOutcome`, `absent` and `miss` run for real.
import type { Img, Rect } from "../types";
import { VoteSession } from "../recognize/session";
import type { VoteFrame } from "../recognize/vote";
import { measureGate } from "../vision/gate";
import type { FromWorker, GateReason, ToWorker } from "../worker/messages";

export type StubFrame = {
  gate?: "ok" | GateReason; // default "ok"
  top?: string[]; // ranked Printing ids (up to 10) this frame "recognizes"; omitted: nothing recognized
  eligible?: boolean; // a card is evidently there (corners or OCR candidates); default true
  ocr?: string[]; // the frame's OCR number candidates, as Printing ids; `textBacked` is "ocr contains top[0]"
};
export type StubScript = {
  frames: StubFrame[];
  loop?: boolean; // repeat the frames; default false (past the end the last frame repeats)
  shutter?: "leader" | "miss"; // what a shutter press yields; default "leader"
  imageMatching?: boolean; // ready.imageMatching; default true
};

/** Frame i of the script answers the i-th `frame` message, so a scripted source must hand frames over in order. A frame the
 *  stub drops while paused still uses up its entry. */
export class StubRecognizer {
  private readonly session = new VoteSession();
  private next = 0;
  private paused = false;

  constructor(
    private readonly script: StubScript,
    private readonly post: (m: FromWorker) => void,
    private readonly read: (bitmap: ImageBitmap) => Img,
    private readonly now: () => number = () => performance.now()
  ) {}

  private scripted(): StubFrame {
    const n = this.script.frames.length;
    if (n === 0) return {};
    const i = this.next++;
    return this.script.frames[this.script.loop ? i % n : Math.min(i, n - 1)];
  }

  handle(m: ToWorker): void {
    switch (m.t) {
      case "init":
        this.post({
          t: "ready",
          imageMatching: this.script.imageMatching ?? true,
        });
        break;
      case "frame":
        this.onFrame(m.id, m.bitmap, m.guide);
        break;
      case "shutter":
        if (this.script.shutter === "miss") {
          if (this.session.state !== "pending") this.post({ t: "miss" });
        } else
          for (const out of this.session.shutter(this.now())) this.post(out);
        break;
      case "lockOutcome":
        this.session.outcome(m, this.now());
        break;
      case "pause":
        this.paused = true;
        break;
      case "resume":
        this.paused = false;
        break;
      case "swap":
        break;
    }
  }

  private onFrame(
    id: number,
    bitmap: ImageBitmap,
    guide: [number, number, number, number]
  ): void {
    const f = this.scripted();
    if (this.paused) {
      bitmap.close();
      this.post({ t: "frameDone", id });
      return;
    }
    let thumb: Uint8Array;
    try {
      thumb = measureGate(this.read(bitmap), guide as Rect).thumb;
    } finally {
      bitmap.close();
    }
    const gate = f.gate ?? "ok";
    const ran = gate === "ok";
    const top = ran ? (f.top ?? []) : null;
    const vf: VoteFrame = {
      t: this.now(),
      thumb,
      top,
      eligible: ran && (f.eligible ?? true) && top !== null && top.length > 0,
      textBacked:
        top !== null && top.length > 0 && (f.ocr ?? []).includes(top[0]),
    };
    this.post(
      gate === "ok"
        ? { t: "gate", id, ok: true }
        : { t: "gate", id, ok: false, reason: gate }
    );
    for (const out of this.session.frame(vf, this.session.takeShutter()))
      this.post(out);
    this.post({ t: "frameDone", id });
  }
}

/** Browser pixel reader for a stub running in a worker. */
export function canvasReader(): (bitmap: ImageBitmap) => Img {
  let canvas: OffscreenCanvas | null = null;
  return (bitmap) => {
    canvas ??= new OffscreenCanvas(bitmap.width, bitmap.height);
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0);
    const d = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: d.width, height: d.height, channels: 4, data: d.data };
  };
}
