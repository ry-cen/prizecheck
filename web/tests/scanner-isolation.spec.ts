// Ticket #321: the scanner runs cross-origin isolated. Opened through Scan cards (a full navigation, so the document comes
// with COOP and COEP), the page and the recognizer worker both report `crossOriginIsolated`, the card pictures load under
// COEP, and the console shows no COEP error. Close and the return after Confirm are full navigations: scanner-save.spec.ts
// ("Close leaves by a full navigation", and Confirm's "new document" check) proves both, so they are not repeated here.
import { test, expect } from "@playwright/test";
import {
  holding,
  installScript,
  pickFinish,
  printingIds,
  seedPopup,
  signInFresh,
  trayPeek,
} from "./support/scanner";

const COEP =
  /cross-origin-embedder-policy|\bCOEP\b|ERR_BLOCKED_BY_RESPONSE|cross-origin resource policy/i;

test.use({ viewport: { width: 1280, height: 800 } });
test.beforeEach(() => seedPopup());

test("opened through Scan cards, the page and the recognizer worker are cross-origin isolated and its pictures load", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) =>
    problems.push(`page error: ${error.message}`)
  );
  page.on("requestfailed", (request) =>
    problems.push(`${request.url()}: ${request.failure()?.errorText}`)
  );

  await signInFresh(page);
  const ids = await printingIds(page);
  // The script is installed in every document of the page, the shell's too, so a first load must not use it up.
  const script = { frames: holding(ids["Bulbasaur"]) };
  await installScript(page, script, script);
  await page.evaluate(() => {
    (window as unknown as { __shellMark: boolean }).__shellMark = true;
  });
  const loading = page.waitForRequest(
    (request) =>
      request.isNavigationRequest() &&
      new URL(request.url()).pathname === "/collection/scan"
  );
  await page
    .getByRole("main")
    .getByRole("button", { name: "Scan cards", exact: true })
    .click();
  await loading;
  await expect(page.getByTestId("scanner-page")).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { __shellMark?: boolean }).__shellMark
    ),
    "the scanner is a new document"
  ).toBeUndefined();

  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __PRIZECHECK_SCANNER_TEST__: { workerIsolated?: boolean };
        }
      ).__PRIZECHECK_SCANNER_TEST__.workerIsolated !== undefined
  );
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __PRIZECHECK_SCANNER_TEST__: { workerIsolated?: boolean };
          }
        ).__PRIZECHECK_SCANNER_TEST__.workerIsolated
    ),
    "self.crossOriginIsolated inside the recognizer worker"
  ).toBe(true);

  // A lock puts a card in the tray, whose row draws a picture from another origin.
  await pickFinish(page, "Normal");
  await expect(trayPeek(page)).toContainText("Bulbasaur");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const images = [...document.querySelectorAll("img")];
        return images.length > 0 &&
          images.every((i) => i.complete && i.naturalWidth > 0)
          ? "loaded"
          : `${images.length} images`;
      })
    )
    .toBe("loaded");
  expect(problems.filter((p) => COEP.test(p))).toEqual([]);
});
