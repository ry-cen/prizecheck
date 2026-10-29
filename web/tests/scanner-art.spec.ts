// Ticket #359: the scanner's pictures come from our own origin. /collection/scan is cross-origin isolated (COEP
// require-corp), and assets.tcgdex.net sends Access-Control-Allow-Origin twice for about one file in five, which the
// browser rejects. Every scanner <img> therefore points at /api/art, whose fetcher reads the stub of
// support/art-upstream.ts (the API's only upstream here, with the doubled header). A card with no picture shows the plain
// placeholder and asks the route once.
import { test, expect, type Locator } from "@playwright/test";
import { Pool } from "pg";
import { artUpstream } from "./support/art-upstream";
import {
  holding,
  placements,
  ORIGIN,
  empty,
  imageOnly,
  installScript,
  openScanner,
  pickFinish,
  printingIds,
  reviewTray,
  seedPopup,
  signInFresh,
  suggestionCard,
  trayOpen,
  trayPeek,
} from "./support/scanner";

test.use({ viewport: { width: 1280, height: 800 } });
test.beforeEach(async () => {
  seedPopup();
  // seedPopup gives only Bulbasaur a picture; Rare Candy and Switch get one too. Professor's Research keeps none.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      `UPDATE catalog_generation_printing SET image_url='https://assets.tcgdex.net/en/me/me01/' ||
         substring(source_id from '[0-9]+$')
       WHERE source_id IN ('me01-125','me01-130')
         AND generation_id=(SELECT active_generation FROM catalog_state WHERE singleton)`
    );
  } finally {
    await pool.end();
  }
});

const loaded = (images: Locator) =>
  images.evaluateAll(
    (list) =>
      list.length > 0 &&
      list.every((i) => {
        const img = i as HTMLImageElement;
        return img.complete && img.naturalWidth > 0;
      })
  );

test("card pictures load through our origin while the art host sends a doubled CORS header", async ({
  page,
}) => {
  await signInFresh(page);
  const upstream = await artUpstream();
  const ids = await printingIds(page);
  const imageRequests: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "image") imageRequests.push(request.url());
  });
  await installScript(page, {
    frames: [
      ...holding(ids["Bulbasaur"]),
      ...empty(),
      ...imageOnly([ids["Rare Candy"]]),
    ],
  });
  await openScanner(page);
  await pickFinish(page, "Normal");

  // The tray peek and, once opened, the tray row show Bulbasaur's picture.
  await expect(trayPeek(page)).toContainText("Bulbasaur");
  await expect.poll(() => loaded(trayPeek(page).locator("img"))).toBe(true);
  await reviewTray(page);
  await expect.poll(() => loaded(trayOpen(page).locator("img"))).toBe(true);
  await expect(trayOpen(page).locator("img")).toHaveCount(1);
  await trayOpen(page).getByRole("button", { name: "Keep scanning" }).click();

  // The Scan Suggestion for Rare Candy.
  const card = suggestionCard(page);
  await expect(card.getByRole("button", { name: /^Rare Candy/ })).toBeVisible();
  await expect.poll(() => loaded(card.locator("img"))).toBe(true);

  // The scanner card search, reached through None of these.
  await card.getByRole("button", { name: "None of these" }).click();
  const search = page.getByRole("dialog", { name: "Find this card" });
  await search
    .getByRole("searchbox", { name: "Search the catalog" })
    .fill("Rare Candy");
  await expect(
    search.getByRole("button", { name: /^Rare Candy/ }).first()
  ).toBeVisible();
  await expect.poll(() => loaded(search.locator("img"))).toBe(true);

  const sources = await page.evaluate(() =>
    [...document.images].map((i) => i.src)
  );
  expect(sources.length).toBeGreaterThan(0);
  for (const src of sources) {
    const url = new URL(src);
    expect(url.origin, src).toBe(new URL(page.url()).origin);
    expect(url.pathname, src).toMatch(/^\/api\/art\//);
  }
  expect(upstream.requests.length, "the API reached the stub").toBeGreaterThan(
    0
  );
  expect(
    imageRequests.filter((url) => url.startsWith(upstream.origin)),
    "no <img> request goes to the stub"
  ).toEqual([]);

  // Control: the same stub pointed at directly, as the old scanner did, is rejected under COEP require-corp.
  const outcome = await page.evaluate(
    (src) =>
      new Promise<string>((resolve) => {
        const img = document.createElement("img");
        img.crossOrigin = "anonymous";
        img.dataset.control = "";
        img.onload = () => resolve("load");
        img.onerror = () => resolve("error");
        img.src = src;
        document.body.append(img);
      }),
    `${upstream.origin}/en/me/me01/001/low.webp`
  );
  expect(upstream.requests, "the stub did answer the control").toContain(
    "/en/me/me01/001/low.webp"
  );
  expect(outcome, "the browser rejects the stub's doubled header").toBe(
    "error"
  );
});

for (const { card, art } of [
  { card: "Switch", art: true },
  { card: "Professor", art: false },
]) {
  test(`a card with ${art ? "missing" : "no"} art (${card}) shows the plain placeholder${art ? " and asks once" : " and asks nothing"}`, async ({
    page,
  }) => {
    await signInFresh(page);
    const upstream = await artUpstream();
    upstream.missing.add("/en/me/me01/130/low.webp");
    const found = await page.request.get(
      `${ORIGIN}/api/catalog/editions?q=${card}`
    );
    const id = (
      (await found.json()) as {
        editions: { name: string; printing_id: string }[];
      }
    ).editions.find((e) => e.name.startsWith(card))!.printing_id;
    const asked: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/art/")) asked.push(path);
    });
    await installScript(page, { frames: holding(id) });
    await openScanner(page);

    const peek = trayPeek(page);
    await expect(peek).toContainText(card);
    await expect(peek.locator("span[aria-hidden]").first()).toBeVisible();
    await expect(peek.locator("img")).toHaveCount(0);
    if (art) {
      await expect
        .poll(() => asked.filter((p) => p.startsWith(`/api/art/${id}/small`)))
        .toHaveLength(1);
      expect(upstream.requests).toContain("/en/me/me01/130/low.webp");
    } else {
      expect(asked.filter((p) => p.includes(id))).toEqual([]);
    }
  });
}

test("a card with missing art is asked for once however often it is scanned or the tray is opened", async ({
  page,
}) => {
  await signInFresh(page);
  const upstream = await artUpstream();
  upstream.missing.add("/en/me/me01/130/low.webp");
  const ids = await printingIds(page);
  const asked: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/art/")) asked.push(path);
  });
  // Two placements: the second changes the count, so the peek's row is keyed anew.
  await installScript(page, {
    frames: placements(ids["Switch"], ids["Switch"]),
  });
  await openScanner(page);
  await expect(trayPeek(page)).toContainText("×2");
  await expect(
    trayPeek(page).locator("span[aria-hidden]").first()
  ).toBeVisible();
  await reviewTray(page);
  const row = trayOpen(page).getByRole("listitem", { name: /^Switch/ });
  await expect(row.locator("span[aria-hidden]").first()).toBeVisible();
  await expect(row.locator("img")).toHaveCount(0);
  expect(upstream.requests).toContain("/en/me/me01/130/low.webp");
  expect(
    asked.filter((p) => p.startsWith(`/api/art/${ids["Switch"]}/small`))
  ).toHaveLength(1);
});
