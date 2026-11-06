import type { Page } from "@playwright/test";
import { expect, it, vi } from "vitest";
import { api } from "../../tests/support/loans";
import { tradeThreadFor } from "../../tests/support/item-chat";
vi.mock("../../tests/support/collectors", () => ({ expect }));
vi.mock("../../tests/support/loans", () => ({ api: vi.fn() }));
vi.mock("../../tests/support/trades", () => ({ tradeStep: vi.fn() }));
const page = {} as Page;
it("selects Cara's item when Ash already has an item with Brock", async () => {
  vi.mocked(api).mockImplementation(async (_page, method, path) => {
    expect(method).toBe("GET");
    const query = new URL(path, "http://fixture.test").searchParams;
    return query.get("with") === "cara"
      ? [{ id: "cara-item", other: { trader_id: "cara" } }]
      : [{ id: "brock-item", other: { trader_id: "brock" } }];
  });
  try {
    expect(await tradeThreadFor(page, "cara")).toBe("cara-item");
  } finally {
    vi.clearAllMocks();
  }
});
it("refuses to set up chat on a different collector's returned item", async () => {
  vi.mocked(api).mockResolvedValue([
    { id: "brock-item", other: { trader_id: "brock" } },
  ]);
  try {
    await expect(tradeThreadFor(page, "cara")).rejects.toThrow();
  } finally {
    vi.clearAllMocks();
  }
});
