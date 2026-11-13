// @vitest-environment jsdom
import React, { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Dialog } from "./Dialog";

vi.mock("./ScrollArea", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  document.body.style.overflow = "";
});

for (const cause of ["breakpoint", "Back"] as const) {
  test(`${cause} can remove the sheet before cancelling its action without leaking the scroll lock`, () => {
    let setSheet!: (open: boolean) => void;
    let setAction!: (open: boolean) => void;
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    function Host() {
      const [sheet, changeSheet] = useState(true);
      const [action, changeAction] = useState(false);
      setSheet = changeSheet;
      setAction = changeAction;
      useEffect(() => {
        const closeSheet = () => changeSheet(false);
        const event = cause === "Back" ? "popstate" : "resize";
        window.addEventListener(event, closeSheet);
        return () => window.removeEventListener(event, closeSheet);
      }, []);
      return React.createElement(
        React.Fragment,
        null,
        sheet &&
          React.createElement(Dialog, {
            open: true,
            title: "Card sheet",
            onClose: () => setSheet(false),
            children: "Card",
          }),
        action &&
          React.createElement(Dialog, {
            open: true,
            title: "Move 1 copy",
            onClose: () => setAction(false),
            children: "Move",
          })
      );
    }
    act(() => root.render(React.createElement(Host)));
    try {
      act(() => setAction(true));
      expect(document.body.style.overflow).toBe("hidden");
      act(() =>
        window.dispatchEvent(
          new Event(cause === "Back" ? "popstate" : "resize")
        )
      );
      expect(node.querySelectorAll("dialog[open]")).toHaveLength(1);
      // The remaining action modal must retain the lock.
      expect(document.body.style.overflow).toBe("hidden");
      act(() => setAction(false));
      expect(node.querySelectorAll("dialog[open]")).toHaveLength(0);
      expect(document.body.style.overflow).toBe("");
    } finally {
      act(() => root.unmount());
      node.remove();
    }
  });
}
