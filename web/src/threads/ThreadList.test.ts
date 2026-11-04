// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { getLoans } from "../social_generated";
import { ThreadList } from "./ThreadList";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getLoans: vi.fn(),
}));
it("keeps a successful empty list quiet after a failed return read", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(getLoans)
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error("offline"));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const props = { kind: "loan" as const, active: true, onOpen: vi.fn() };
  try {
    await act(async () => root.render(h(ThreadList, props)));
    expect(host.textContent).toContain("No Loans yet.");
    await act(async () =>
      root.render(h(ThreadList, { ...props, active: false }))
    );
    await act(async () => root.render(h(ThreadList, props)));
    expect(getLoans).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("No Loans yet.");
    expect(host.querySelector('[role="status"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});
it("exposes Retry on a failed first load and recovers without a reload", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(getLoans)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce([]);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(ThreadList, { kind: "loan", active: true, onOpen: vi.fn() })
      )
    );
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      "Your Loans couldn't be loaded."
    );
    const retry = host.querySelector("button")!;
    expect(retry.textContent).toBe("Retry");
    await act(async () => retry.click());
    expect(host.textContent).toContain("No Loans yet.");
    expect(host.querySelector('[role="status"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});
it("reuses a quiet read still in flight across another hide and show", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let release!: (rows: []) => void;
  const held = new Promise<[]>((resolve) => {
    release = resolve;
  });
  vi.mocked(getLoans)
    .mockResolvedValueOnce([])
    .mockReturnValueOnce(held)
    .mockResolvedValue([]);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const props = { kind: "loan" as const, active: true, onOpen: vi.fn() };
  try {
    await act(async () => root.render(h(ThreadList, props)));
    await act(async () =>
      root.render(h(ThreadList, { ...props, active: false }))
    );
    await act(async () => root.render(h(ThreadList, props)));
    expect(getLoans).toHaveBeenCalledTimes(2);
    const signal = vi.mocked(getLoans).mock.calls[1][0]!;
    await act(async () =>
      root.render(h(ThreadList, { ...props, active: false }))
    );
    await act(async () => root.render(h(ThreadList, props)));
    expect(signal.aborted).toBe(false);
    expect(getLoans).toHaveBeenCalledTimes(2);
    await act(async () => release([]));
    expect(host.textContent).toContain("No Loans yet.");
    expect(host.querySelector('[role="status"]')).toBeNull();
  } finally {
    release([]);
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});
