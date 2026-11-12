// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { ToastProvider, useToast } from "./Toast";

test("the toast version counts shows synchronously, including shows dismissed before render", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let kit!: ReturnType<typeof useToast>;
  function Probe() {
    kit = useToast();
    return null;
  }
  try {
    await act(async () => root.render(h(ToastProvider, null, h(Probe))));
    expect(kit.getVersion()).toBe(0);
    await act(async () => {
      const id = kit.show({ message: "First" });
      expect(kit.getVersion()).toBe(1);
      kit.update(id, { message: "Updated" });
      kit.dismiss(id);
      expect(kit.getVersion()).toBe(1);
      kit.show({ message: "Second" });
      kit.dismiss();
      expect(kit.getVersion()).toBe(2);
    });
    expect(host.textContent).toBe("");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
