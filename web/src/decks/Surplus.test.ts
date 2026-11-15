// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CompetitionNotice } from "./Surplus";

vi.mock("../workspace/media", () => ({
  MOBILE_QUERY: "phone",
  useMediaQuery: () => phone,
}));
let phone = true;
afterEach(() => vi.unstubAllGlobals());

it.each([true, false])(
  "keeps the warning details available, initially collapsed on phone=%s",
  async (isPhone) => {
    phone = isPhone;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          h(CompetitionNotice, {
            lines: [],
            warnings: [
              {
                edition_id: "card",
                spare: "1",
                counted_elsewhere: "3",
                decks: [
                  {
                    deck_id: "other",
                    name: "Weekend",
                    in_deck: "0",
                    elsewhere: "2",
                  },
                ],
              },
            ],
          })
        )
      );
      const details = host.querySelector("details");
      expect(details).not.toBeNull();
      expect(details?.open).toBe(!isPhone);
      expect(details?.querySelector("summary")?.textContent).toContain(
        "Other Decks count the same spare copies"
      );
      expect(details?.textContent).toContain(
        "3 copies are counted as owned elsewhere, but only 1 is spare."
      );
      expect(details?.textContent).toContain(
        "Weekend also counts 2 as owned elsewhere."
      );
    } finally {
      await act(async () => root.unmount());
    }
  }
);
