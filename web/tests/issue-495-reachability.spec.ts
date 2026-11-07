import type { Page } from "@playwright/test";
import { test, expect } from "./support/collectors";
import { createDeck, ORIGIN, seedCatalog, setLine } from "./support/loans";

async function settleFocus(page: Page) {
  await page.evaluate(async () => {
    let previous = "",
      stable = 0;
    for (let frame = 0; frame < 120; frame++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      );
      const current = JSON.stringify([
        scrollY,
        document.activeElement?.getBoundingClientRect().toJSON(),
      ]);
      stable = previous === current ? stable + 1 : 0;
      previous = current;
      if (stable >= 4) return;
    }
    throw new Error("Focus geometry failed to settle");
  });
}
async function focusObservation(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement!;
    const rect = el.getBoundingClientRect();
    const header = document
      .querySelector("[data-app-shell] > header.sticky")!
      .getBoundingClientRect();
    // The full rectangle is checked separately; surface probes avoid empty rounded corners.
    const points = [0.25, 0.5, 0.75].flatMap((xFraction) =>
      [0.25, 0.5, 0.75].map((yFraction) => {
        const x = rect.left + rect.width * xFraction;
        const y = rect.top + rect.height * yFraction;
        const hit = document.elementFromPoint(x, y);
        return {
          x,
          y,
          ok: !!hit && el.contains(hit),
          hit: hit?.outerHTML.slice(0, 350),
        };
      })
    );
    return {
      tag: el.tagName,
      text: el.textContent?.trim().slice(0, 100),
      label: el.getAttribute("aria-label"),
      inputType: el instanceof HTMLInputElement ? el.type : null,
      labels:
        el instanceof HTMLInputElement
          ? [...(el.labels ?? [])].map((l) => l.textContent)
          : [],
      main: !!el.closest("#main-content"),
      headerControl: !!el.closest("header.sticky"),
      rect: rect.toJSON(),
      header: header.toJSON(),
      scrollY,
      points,
      focusVisible: el.matches(":focus-visible"),
      margin: getComputedStyle(el).scrollMarginTop,
      bottomMargin: getComputedStyle(el).scrollMarginBottom,
      viewport: { width: innerWidth, height: innerHeight },
      focusWidth: getComputedStyle(document.documentElement)
        .getPropertyValue("--focus-width")
        .trim(),
      focusOffset: getComputedStyle(document.documentElement)
        .getPropertyValue("--focus-offset")
        .trim(),
      bottomPadding: getComputedStyle(document.documentElement)
        .scrollPaddingBottom,
      padding: getComputedStyle(document.documentElement).scrollPaddingTop,
      token: getComputedStyle(document.documentElement)
        .getPropertyValue("--layout-header-height")
        .trim(),
      clear:
        rect.left >= 0 &&
        rect.right <= innerWidth &&
        rect.top >= 0 &&
        rect.bottom <= innerHeight &&
        (!el.closest("#main-content") || rect.top >= header.bottom) &&
        points.every((p) => p.ok),
    };
  });
}
for (const height of [800, 600])
  for (const method of ["outside", "panel", "keyboard"]) {
    test(`Combined total exposes every whole row by ${method} at 1280x${height}`, async ({
      collectors,
    }) => {
      const page = (await collectors.signIn()).page;
      const ids = seedCatalog();
      const deck = await createDeck(page, "Synthetic reachability Deck");
      await setLine(page, deck, ids["PAL 185"], 1);
      await page.route(
        (url) => url.pathname === "/api/want-list",
        async (route) => {
          const response = await route.fetch();
          const body = await response.json();
          const row = body.combined[0];
          body.combined = Array.from({ length: 8 }, (_, i) => ({
            ...row,
            edition_id: `${row.edition_id}-${i}`,
            name: `${i === 7 ? "FINAL OCTAGON" : "Summary"} row ${i + 1} with a long identifiable card label for reachability`,
            image_url: null,
          }));
          await route.fulfill({ response, json: body });
        }
      );
      await page.setViewportSize({ width: 1280, height });
      await page.goto(`${ORIGIN}/decks/want-list`);
      const aside = page.getByRole("complementary", {
        name: /^Combined total/,
      });
      const rows = aside.getByRole("listitem");
      await expect(rows).toHaveCount(8);
      const samples: unknown[] = [];
      const seen = new Set<number>();
      const settle = () => settleFocus(page);
      const collect = async (step: number) => {
        const sample = await rows.evaluateAll(
          (els, step) => ({
            step,
            y: scrollY,
            h: innerHeight,
            scrollHeight: document.documentElement.scrollHeight,
            atEnd:
              scrollY + innerHeight >=
              document.documentElement.scrollHeight - 1,
            header: document
              .querySelector("[data-app-shell] > header.sticky")
              ?.getBoundingClientRect()
              .toJSON(),
            panel: els[0].closest("aside")!.getBoundingClientRect().toJSON(),
            rows: els.map((el, i) => {
              const b = el.getBoundingClientRect();
              const points = [
                b.left + 1,
                b.left + b.width / 2,
                b.right - 1,
              ].flatMap((x) =>
                [b.top + 1, b.top + b.height / 2, b.bottom - 1].map((y) => {
                  const hit = document.elementFromPoint(x, y);
                  return {
                    x,
                    y,
                    ok: !!hit && el.contains(hit),
                    hit: hit?.tagName,
                    cls: hit?.className,
                  };
                })
              );
              return {
                i,
                text: el.textContent,
                rect: b.toJSON(),
                fully:
                  b.top >= 0 &&
                  b.bottom <= innerHeight &&
                  b.left >= 0 &&
                  b.right <= innerWidth,
                uncovered: points.every((p) => p.ok),
                points,
                labelRects: [...el.querySelectorAll("span.text-body")].map(
                  (n) => ({
                    text: n.textContent,
                    rect: n.getBoundingClientRect().toJSON(),
                    clientWidth: n.clientWidth,
                    scrollWidth: n.scrollWidth,
                    whiteSpace: getComputedStyle(n).whiteSpace,
                    textOverflow: getComputedStyle(n).textOverflow,
                  })
                ),
                controls: el.querySelectorAll(
                  "a[href],button,input,select,textarea,[tabindex]"
                ).length,
              };
            }),
          }),
          step
        );
        samples.push(sample);
        for (const row of sample.rows)
          if (row.fully && row.uncovered) seen.add(row.i);
        return sample;
      };
      try {
        await collect(-1);
        const b = await aside.boundingBox();
        if (!b) throw Error("no panel");
        await page.mouse.move(
          method === "panel" ? b.x + b.width / 2 : 300,
          Math.min(height - 20, b.y + 20)
        );
        let end = false;
        for (let step = 0; step < 100; step++) {
          const before = await page.evaluate(() => scrollY);
          if (method === "keyboard") await page.keyboard.press("ArrowDown");
          else await page.mouse.wheel(0, 80);
          await expect
            .poll(
              async () =>
                await page.evaluate(
                  (y) =>
                    scrollY > y ||
                    scrollY + innerHeight >=
                      document.documentElement.scrollHeight - 1,
                  before
                )
            )
            .toBe(true);
          await settle();
          const s = await collect(step);
          if (s.atEnd) {
            end = true;
            break;
          }
        }
        expect(end, "actual page end reached").toBe(true);
        const final = await collect(101);
        expect(final.rows[7].fully && final.rows[7].uncovered).toBe(true);
        for (const row of final.rows)
          for (const label of row.labelRects) {
            expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
            expect(label.whiteSpace).not.toBe("nowrap");
          }
        await page.screenshot({
          path: test.info().outputPath("synthetic.png"),
          fullPage: true,
        });
        expect(
          [...seen].sort(),
          "each whole row fully visible and uncovered at a settled reachable position"
        ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      } finally {
        await test.info().attach("method-evidence", {
          body: JSON.stringify({ method, height, samples, seen: [...seen] }),
          contentType: "application/json",
        });
      }
    });
  }

for (const height of [800, 600])
  for (const visibility of ["visible", "hidden"] as const) {
    test(`reverse Tab clears the desktop header at 1280x${height} with Combined total ${visibility}`, async ({
      collectors,
    }) => {
      const page = (await collectors.signIn()).page;
      const ids = seedCatalog();
      const deck = await createDeck(page, "Synthetic reachability Deck");
      await setLine(page, deck, ids["PAL 185"], 1);
      await page.route(
        (url) => url.pathname === "/api/want-list",
        async (route) => {
          const response = await route.fetch();
          const body = await response.json();
          const row = body.combined[0];
          body.combined = Array.from({ length: 8 }, (_, i) => ({
            ...row,
            edition_id: `${row.edition_id}-${i}`,
            name: `${i === 7 ? "FINAL OCTAGON" : "Summary"} row ${i + 1} with a long identifiable card label for reachability`,
            image_url: null,
          }));
          await route.fulfill({ response, json: body });
        }
      );
      await page.setViewportSize({ width: 1280, height });
      await page.goto(`${ORIGIN}/decks/want-list`);
      const panel = page.locator("#main-content aside");
      await expect(panel.getByRole("listitem")).toHaveCount(8);
      const geometry = () =>
        panel.evaluate((el) => ({
          height: document.documentElement.scrollHeight,
          panel: el.getBoundingClientRect().toJSON(),
          main: document
            .querySelector("#main-content")!
            .getBoundingClientRect()
            .toJSON(),
          y: scrollY,
        }));
      const before = await geometry();
      if (visibility === "hidden")
        await panel.evaluate((el) => {
          el.style.visibility = "hidden";
        });
      const after = await geometry();
      expect(after).toEqual(before);
      const observations: ({ key: string } & Awaited<
        ReturnType<typeof focusObservation>
      >)[] = [];
      try {
        let end = false;
        for (let step = 0; step < 100; step++) {
          const y = await page.evaluate(() => scrollY);
          await page.keyboard.press("ArrowDown");
          await expect
            .poll(() =>
              page.evaluate(
                (y) =>
                  scrollY > y ||
                  scrollY + innerHeight >=
                    document.documentElement.scrollHeight - 1,
                y
              )
            )
            .toBe(true);
          await settleFocus(page);
          end = await page.evaluate(
            () =>
              scrollY + innerHeight >= document.documentElement.scrollHeight - 1
          );
          if (end) break;
        }
        expect(end).toBe(true);
        for (const key of ["End", "Home"]) {
          await page.keyboard.press(key);
          await settleFocus(page);
        }
        for (const key of ["Tab", "Shift+Tab"])
          for (let step = 0; step < 40; step++) {
            await page.keyboard.press(key);
            await settleFocus(page);
            const observation = await focusObservation(page);
            observations.push({ key, ...observation });
            if (observation.main || observation.headerControl)
              expect
                .soft(observation.clear, JSON.stringify(observation))
                .toBe(true);
            else if (observation.text !== "Skip to main content")
              expect(observation.tag, "browser boundary").toBe("BODY");
          }
        const reverse = observations.filter((o) => o.key === "Shift+Tab");
        expect(reverse.some((o) => o.text === "Open Deck")).toBe(true);
        expect(reverse.some((o) => o.text === "Want List")).toBe(true);
        expect(reverse.some((o) => o.inputType === "radio")).toBe(true);
        for (const key of ["Tab", "Shift+Tab"]) {
          const path = observations.filter((o) => o.key === key);
          expect(path.some((o) => o.tag === "BODY")).toBe(true);
          expect(path.filter((o) => o.main).length).toBeGreaterThan(1);
          expect(path.filter((o) => o.headerControl).length).toBeGreaterThan(1);
        }
      } finally {
        await test.info().attach("focus-evidence", {
          body: JSON.stringify({
            height,
            visibility,
            before,
            after,
            observations,
          }),
          contentType: "application/json",
        });
      }
    });
  }
