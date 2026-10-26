// Camera frame source. The frame carries its guide (deviates from the resolution's `next(): ImageBitmap`; note for the scanner page).
import { expandGuide, guideRect, GUIDE_EXPAND } from "./guide";
import type { Rect } from "./types";

export type Frame = {
  bitmap: ImageBitmap;
  guide: [number, number, number, number]; // guide rectangle in bitmap pixels
  crop: [number, number, number, number]; // [sx, sy, sw, sh] in video pixels
  guideInVideo: Rect; // the guide in video pixels
  videoW: number;
  videoH: number;
  t: number;
};

/** Where the scanner's frames come from: the camera, or in a browser test a scripted source. `next()` is null while
 * there is no frame to take now; the caller tries again on its next tick. */
export interface FrameSource {
  start(): Promise<void>;
  next(): Promise<Frame | null>;
  stop(): void;
}

export async function listCameras(): Promise<
  { deviceId: string; label: string }[]
> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === "videoinput")
    .map((d) => ({ deviceId: d.deviceId, label: d.label }));
}

export type CameraOpts = { deviceId?: string; width?: number; height?: number };

/** The back camera at an ideal 1920x1080, cropped to the guide as the worker contract says (`Frame.crop`). */
export class CameraFrameSource implements FrameSource {
  private stream: MediaStream | null = null;
  private stopped = false;
  private label = "";
  private settings: MediaTrackSettings = {};

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly opts: CameraOpts = {}
  ) {}

  async start(): Promise<void> {
    const W = this.opts.width ?? 1920;
    const H = this.opts.height ?? 1080;
    const size = { width: { ideal: W }, height: { ideal: H } };
    const video: MediaTrackConstraints = this.opts.deviceId
      ? { deviceId: { exact: this.opts.deviceId }, ...size }
      : { facingMode: "environment", ...size };
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video,
    });
    if (this.stopped) {
      // Stopped while the browser was asking: the stream that arrives late must not keep the camera on.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    const v = this.video;
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    v.srcObject = stream;
    await new Promise<void>((resolve, reject) => {
      if (v.readyState >= 1) {
        resolve();
        return;
      }
      v.addEventListener("loadedmetadata", () => resolve(), { once: true });
      v.addEventListener("error", () => reject(new Error("video error")), {
        once: true,
      });
    });
    await v.play();
    const track = stream.getVideoTracks()[0];
    this.label = track?.label ?? "";
    this.settings = track?.getSettings() ?? {};
  }

  /** null when the video has no frame yet. */
  async next(): Promise<Frame | null> {
    const v = this.video;
    if (v.readyState < 2 || v.videoWidth === 0) return null;
    const vw = v.videoWidth,
      vh = v.videoHeight;
    const g = guideRect(vw, vh);
    const [sx, sy, sw, sh] = expandGuide(g, GUIDE_EXPAND, vw, vh);
    const bitmap = await createImageBitmap(v, sx, sy, sw, sh);
    return {
      bitmap,
      guide: [g[0] - sx, g[1] - sy, g[2] - sx, g[3] - sy],
      crop: [sx, sy, sw, sh],
      guideInVideo: g,
      videoW: vw,
      videoH: vh,
      t: performance.now(),
    };
  }

  stop(): void {
    this.stopped = true;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  info(): {
    label: string;
    settings: MediaTrackSettings;
    videoW: number;
    videoH: number;
  } {
    return {
      label: this.label,
      settings: this.settings,
      videoW: this.video.videoWidth,
      videoH: this.video.videoHeight,
    };
  }
}
