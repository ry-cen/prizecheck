// The scanner's real parts: the asset loader, the recognizer worker, the camera.
import { loadScannerAssets } from "../assets/loader";
import { CameraFrameSource } from "../frames";
import type { SessionDeps, WorkerLike } from "./session";

export const nextAnimationFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

export const liveDeps: SessionDeps = {
  loadAssets: (options) => loadScannerAssets(options),
  createWorker: () =>
    new Worker(new URL("../worker/recognizer.worker.ts", import.meta.url), {
      type: "module",
    }) as WorkerLike,
  createSource: (video) => new CameraFrameSource(video),
  tick: nextAnimationFrame,
};

/** The parts to use: the real ones, or in a browser test on the dev server the scripted ones. The test branch is
 * `import.meta.env.DEV`, so a production build drops it and the stub's modules with it. */
export async function chooseDeps(): Promise<SessionDeps> {
  if (import.meta.env.DEV && window.__PRIZECHECK_SCANNER_TEST__) {
    const { stubDeps } = await import("./testHooks");
    return stubDeps(window.__PRIZECHECK_SCANNER_TEST__);
  }
  return liveDeps;
}
