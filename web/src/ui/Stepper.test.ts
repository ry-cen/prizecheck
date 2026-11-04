// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Stepper } from "./Stepper";
for (const shared of [true, false]) {
  it(`announces a quantity change through exactly one semantic status (shared=${shared})`, async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    function View() {
      const [value, setValue] = useState(1);
      return h(
        "div",
        null,
        h(Stepper, {
          label: "Iono",
          value,
          onChange: setValue,
          announceValue: !shared,
        }),
        shared && h("p", { role: "status" }, `${value} Iono selected`)
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(h(View)));
      // A native output has an implicit status role even with role=none when
      // global ARIA properties make the presentation role inapplicable.
      const statuses = () => host.querySelectorAll('output, [role="status"]');
      expect(statuses()).toHaveLength(1);
      expect(statuses()[0].textContent).toBe(shared ? "1 Iono selected" : "1");
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Increase Iono"]'
          )!
          .click()
      );
      expect(statuses()).toHaveLength(1);
      expect(statuses()[0].textContent).toBe(shared ? "2 Iono selected" : "2");
      expect(
        host.querySelector('[role="group"][aria-label="Iono"]')?.textContent
      ).toBe("2");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
}
