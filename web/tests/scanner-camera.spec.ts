import { test } from "./support/art-upstream";
// Ticket #321: the real-camera smoke test. Chromium's fake capture device plays web/tests/fixtures/scanner/synthetic-card.mjpeg
// (a synthetic 320x240 clip made by scripts/make_scanner_fixtures.py, no card artwork) in place of a camera, and the page's
// real CameraFrameSource reads it. The recognizer is the stub, so only the camera path is under test: frames come out of
// the camera, cross to the worker and are answered there. The launch flags are scoped to this file with `test.use`.
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { installScript, openScanner, signInFresh } from "./support/scanner";

const CLIP = fileURLToPath(
  new URL("./fixtures/scanner/synthetic-card.mjpeg", import.meta.url)
);

test.use({
  viewport: { width: 1280, height: 800 },
  permissions: ["camera"],
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${CLIP}`,
    ],
  },
});

type Hook = { played?: number; delivered?: number };
const counts = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const hook = (window as unknown as { __PRIZECHECK_SCANNER_TEST__: Hook })
      .__PRIZECHECK_SCANNER_TEST__;
    return { played: hook.played ?? 0, delivered: hook.delivered ?? 0 };
  });

test("CameraFrameSource delivers the fake camera's frames to the recognizer worker", async ({
  page,
}) => {
  await signInFresh(page);
  await installScript(page, { frames: [{}], source: "camera" });
  await openScanner(page);

  // The camera is running: its video has the clip's size.
  const video = page.locator("video");
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth))
    .toBe(320);
  expect(await video.evaluate((v: HTMLVideoElement) => v.videoHeight)).toBe(
    240
  );

  // Frames leave the camera source and the worker finishes them (its `frameDone`).
  await expect
    .poll(async () => (await counts(page)).delivered, {
      message: "the worker has finished frames from the camera",
    })
    .toBeGreaterThanOrEqual(5);
  const { played, delivered } = await counts(page);
  expect(played).toBeGreaterThanOrEqual(delivered);

  // An empty table: nothing was recognized, so nothing was added.
  const rows = await page.evaluate(() =>
    Object.entries(localStorage)
      .filter(([key]) => key.startsWith("prizecheck:scanner:tray:v1:"))
      .flatMap(([, value]) => (JSON.parse(value) as { rows: unknown[] }).rows)
  );
  expect(rows).toEqual([]);
});
