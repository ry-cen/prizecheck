// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useLeaveGuard, useRoute, type LeaveGuard } from "./useRoute";
it.each([
  "already mounted",
  "appears while asking",
  "settles before leaving",
] as const)(
  "keeps a pending Loan and its parent draft independently authoritative: %s",
  async (schedule) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("scrollTo", vi.fn());
    window.history.replaceState(null, "", "/trades/new/friend");
    let approve!: () => void;
    const parentAsk = vi.fn((leave: () => void) => {
      approve = leave;
    });
    const pendingAsk = vi.fn();
    const parent: LeaveGuard = { blocks: () => true, ask: parentAsk };
    const pending: LeaveGuard = { blocks: () => true, ask: pendingAsk };
    let show!: (value: boolean) => void;
    function Pending() {
      useLeaveGuard(pending);
      return h("p", null, "Retry the same Loan request");
    }
    function View() {
      const route = useRoute();
      useLeaveGuard(parent);
      const [shown, setShown] = useState(schedule === "already mounted");
      show = setShown;
      return h(
        "div",
        null,
        shown ? h(Pending) : null,
        h("button", { onClick: () => route.navigate("/collection") }, "Leave")
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const navigate = () => host.querySelector("button")!.click();
    try {
      await act(async () => root.render(h(View)));
      if (schedule === "settles before leaving") {
        await act(async () => show(true));
        await act(async () => navigate());
        expect(pendingAsk).toHaveBeenCalledTimes(1);
        await act(async () => show(false));
        await act(async () => navigate());
        expect(parentAsk).toHaveBeenCalledTimes(1);
        expect(window.location.pathname).toBe("/trades/new/friend");
        await act(async () => approve());
        expect(window.location.pathname).toBe("/collection");
      } else {
        await act(async () => navigate());
        if (schedule === "appears while asking") {
          expect(parentAsk).toHaveBeenCalledTimes(1);
          await act(async () => show(true));
        }
        if (parentAsk.mock.calls.length) await act(async () => approve());
        expect(window.location.pathname).toBe("/trades/new/friend");
        expect(pendingAsk).toHaveBeenCalledTimes(1);
        await act(async () => show(false));
        await act(async () => navigate());
        expect(parentAsk.mock.calls.length).toBeGreaterThan(0);
        await act(async () => approve());
        expect(window.location.pathname).toBe("/collection");
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    }
  }
);

it("rechecks a Loan that starts after discard approval but before the approved browser pop arrives", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("scrollTo", vi.fn());
  window.history.replaceState(null, "", "/trades/new/friend");
  let approve!: () => void;
  let show!: (value: boolean) => void;
  const parentAsk = vi.fn((leave: () => void) => {
    approve = leave;
  });
  const pendingAsk = vi.fn();
  const parent: LeaveGuard = { blocks: () => true, ask: parentAsk };
  const pending: LeaveGuard = { blocks: () => true, ask: pendingAsk };
  const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
  function Pending() {
    useLeaveGuard(pending);
    return h("p", null, "Pending Loan");
  }
  function View() {
    useRoute();
    useLeaveGuard(parent);
    const [shown, setShown] = useState(false);
    show = setShown;
    return shown ? h(Pending) : null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const arrivingPop = () => {
    window.history.replaceState(null, "", "/collection");
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  try {
    await act(async () => root.render(h(View)));
    await act(async () => arrivingPop());
    expect(parentAsk).toHaveBeenCalledTimes(1);
    await act(async () => approve());
    expect(back).toHaveBeenCalledTimes(1);
    await act(async () => show(true));
    await act(async () => arrivingPop());
    expect(window.location.pathname).toBe("/trades/new/friend");
    expect(pendingAsk).toHaveBeenCalledTimes(1);
    expect(parentAsk).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    back.mockRestore();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});
