import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { effects, getPrices } = vi.hoisted(() => ({
  effects: [] as Array<() => void>,
  getPrices: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void) => effects.push(effect),
}));
vi.mock("../prices_generated", async (original) => ({
  ...(await original<typeof import("../prices_generated")>()),
  getEditionPrices: getPrices,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  getPrices.mockReset();
  effects.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

async function slot(id = "edition") {
  const { EditionPrice } = await import("../EditionPrice");
  const html = renderToStaticMarkup(
    createElement(EditionPrice, { editionId: id })
  );
  effects.splice(0).forEach((effect) => effect());
  return html;
}
const row = {
  edition_id: "edition",
  status: "quote",
  display_amount: "$12.34",
};

it("renders a cached row synchronously without another request", async () => {
  getPrices.mockResolvedValue({ prices: [row] });
  await slot();
  await vi.advanceTimersByTimeAsync(15);
  const html = await slot();
  expect(html).toContain("$12.34");
  expect(html).not.toContain("Checking prices");
  await vi.advanceTimersByTimeAsync(15);
  expect(getPrices).toHaveBeenCalledTimes(1);
});

it("batches simultaneous subscribers to the same edition once", async () => {
  getPrices.mockResolvedValue({ prices: [row] });
  await slot();
  await slot();
  await vi.advanceTimersByTimeAsync(15);
  expect(getPrices).toHaveBeenCalledTimes(1);
  expect(getPrices.mock.calls[0][0]).toEqual(["edition"]);
});

it("joins the request already in flight for the same edition", async () => {
  let resolve!: (value: unknown) => void;
  getPrices.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    })
  );
  await slot();
  await vi.advanceTimersByTimeAsync(15);
  await slot();
  await vi.advanceTimersByTimeAsync(15);
  expect(getPrices).toHaveBeenCalledTimes(1);
  resolve({ prices: [row] });
  await vi.advanceTimersByTimeAsync(0);
  expect(await slot()).toContain("$12.34");
});

it.each(["error", "timeout"])("does not cache a %s", async (kind) => {
  if (kind === "error") getPrices.mockRejectedValue(new Error("offline"));
  else
    getPrices.mockImplementation(
      (_ids, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
  await slot();
  await vi.advanceTimersByTimeAsync(3515);
  expect(await slot()).toContain("Checking prices");
  await vi.advanceTimersByTimeAsync(15);
  expect(getPrices).toHaveBeenCalledTimes(2);
});
