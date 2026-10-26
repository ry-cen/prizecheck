import { afterEach, describe, expect, it, vi } from "vitest";
import { CameraFrameSource } from "./frames";
import { expandGuide, guideRect } from "./guide";

afterEach(() => vi.unstubAllGlobals());

function fakeVideo(w: number, h: number, ready = 4) {
  const listeners: Record<string, () => void> = {};
  return {
    muted: false,
    playsInline: false,
    autoplay: false,
    srcObject: null as unknown,
    readyState: ready,
    videoWidth: w,
    videoHeight: h,
    addEventListener: (n: string, f: () => void) => (listeners[n] = f),
    play: vi.fn(async () => {}),
  } as unknown as HTMLVideoElement;
}

describe("CameraFrameSource", () => {
  it("asks for the back camera at an ideal 1920x1080", async () => {
    const track = { label: "back", getSettings: () => ({}), stop: vi.fn() };
    const getUserMedia = vi.fn(async () => ({
      getVideoTracks: () => [track],
      getTracks: () => [track],
    }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const source = new CameraFrameSource(fakeVideo(1920, 1080));
    await source.start();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        facingMode: "environment",
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    source.stop();
    expect(track.stop).toHaveBeenCalled();
  });

  it("turns off a stream that arrives after stop()", async () => {
    const track = { label: "back", getSettings: () => ({}), stop: vi.fn() };
    let arrive!: (stream: unknown) => void;
    const getUserMedia = vi.fn(
      () =>
        new Promise((resolve) => {
          arrive = resolve;
        })
    );
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const source = new CameraFrameSource(fakeVideo(1920, 1080));
    const started = source.start();
    source.stop();
    arrive({ getVideoTracks: () => [track], getTracks: () => [track] });
    await started;
    expect(track.stop).toHaveBeenCalled();
  });

  it("crops each frame to the guide grown by a quarter, as the worker contract says", async () => {
    const createImageBitmap = vi.fn(async () => ({}) as ImageBitmap);
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    const video = fakeVideo(1920, 1080);
    const source = new CameraFrameSource(video);
    const frame = await source.next();
    const g = guideRect(1920, 1080);
    const crop = expandGuide(g, 0.25, 1920, 1080);
    expect(createImageBitmap).toHaveBeenCalledWith(video, ...crop);
    expect(frame?.crop).toEqual(crop);
    expect(frame?.guide).toEqual([
      g[0] - crop[0],
      g[1] - crop[1],
      g[2] - crop[0],
      g[3] - crop[1],
    ]);
  });

  it("has no frame until the video does", async () => {
    const source = new CameraFrameSource(fakeVideo(0, 0, 0));
    expect(await source.next()).toBeNull();
  });
});
