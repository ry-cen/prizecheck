// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getPendingLoans,
  getWantListMatches,
  type PendingLoans,
  type WantListMatches,
} from "../social_generated";
import type { WantList } from "../want_list_generated";
import { borrowDefault, borrowRemainder } from "./pendingLoans";
import { readBorrowMatches, useBorrowMatches } from "./useBorrowMatches";
let pulse = 0;
vi.mock("../inbox/Inbox", () => ({
  usePulseChanged: () => pulse,
  useLoansChanged: () => 0,
}));
vi.mock("../social_generated", () => ({
  getPendingLoans: vi.fn(),
  getWantListMatches: vi.fn(),
}));
const pending = (requested: string, accepted = "0"): PendingLoans => ({
  deck_id: "deck",
  lines: [
    {
      edition_id: "A",
      requested,
      accepted,
      lenders: [
        {
          lender_id: "one",
          lender: "Misty",
          state: accepted === "0" ? "requested" : "accepted",
          copies: accepted === "0" ? requested : accepted,
        },
      ],
    },
  ],
});
const matches = (spare: string): WantListMatches => ({
  has_friends: true,
  cards: [
    {
      edition_id: "A",
      copies: [
        {
          collector_id: "one",
          handle: "misty",
          display_name: "Misty",
          edition_id: "A",
          name: "Iono",
          set_code: "PAL",
          collector_number: "185",
          descriptor: {},
          other_printing: false,
          spare,
          in_deck: "0",
        },
      ],
    },
  ],
});
const list: WantList = {
  deck_id: "deck",
  want_list_counting: "all_at_once",
  settings_revision: 1,
  owner_revision: 1,
  deck_lists_digest: "pins",
  decks: [],
  sections: [],
  combined: [],
  to_get: "3",
};
beforeEach(() => {
  pulse = 0;
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => vi.unstubAllGlobals());
it("re-reads availability when a partial acceptance arrives between the paired reads", async () => {
  vi.mocked(getPendingLoans)
    .mockResolvedValueOnce(pending("2"))
    .mockResolvedValue(pending("0", "1"));
  vi.mocked(getWantListMatches)
    .mockResolvedValueOnce(matches("2"))
    .mockResolvedValue(matches("1"));
  const result = await readBorrowMatches("deck", new AbortController().signal);
  expect(getWantListMatches).toHaveBeenCalledTimes(2);
  const coverage = result.pending!.lines[0];
  const cap = borrowRemainder(
    3,
    Number(result.matches.cards[0].copies[0].spare),
    coverage,
    coverage,
    "one"
  );
  expect(cap).toBe(1);
  expect(borrowDefault(3, 1, cap)).toBe(1);
});
it("never enables an offer while pending or availability is delayed, and disables a failed refresh", async () => {
  let releasePending!: (p: PendingLoans) => void;
  let releaseMatches!: (p: WantListMatches) => void;
  vi.mocked(getPendingLoans)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePending = resolve;
        })
    )
    .mockResolvedValue(pending("1"));
  vi.mocked(getWantListMatches).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseMatches = resolve;
      })
  );
  const host = document.createElement("div");
  const root = createRoot(host);
  function Probe() {
    const { friends, pending: read } = useBorrowMatches(list, 0);
    const known =
      friends.kind === "ready" &&
      !friends.pending &&
      read.state.kind === "ready" &&
      !read.state.stale;
    let text = "unknown";
    if (known && friends.kind === "ready" && read.state.kind === "ready") {
      const coverage = read.state.lines.get("A");
      const spare = Number(friends.byCard.get("A")![0].spare);
      const cap = borrowRemainder(3, spare, coverage, coverage, "one");
      text = `offer ${cap}, default ${borrowDefault(3, spare, cap)}`;
    }
    return h("span", null, text);
  }
  try {
    await act(async () => root.render(h(Probe)));
    expect(host.textContent).toBe("unknown");
    await act(async () => releasePending(pending("1")));
    expect(host.textContent).toBe("unknown");
    await act(async () => releaseMatches(matches("2")));
    expect(host.textContent).toBe("offer 1, default 1");
    let releaseAcceptance!: (p: PendingLoans) => void;
    vi.mocked(getPendingLoans)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseAcceptance = resolve;
          })
      )
      .mockResolvedValue(pending("0", "1"));
    vi.mocked(getWantListMatches).mockResolvedValue(matches("1"));
    pulse++;
    await act(async () => root.render(h(Probe)));
    expect(host.textContent).toBe("unknown");
    await act(async () => releaseAcceptance(pending("0", "1")));
    expect(host.textContent).toBe("offer 1, default 1");
    vi.mocked(getPendingLoans).mockRejectedValue(new Error("offline"));
    pulse++;
    await act(async () => root.render(h(Probe)));
    expect(host.textContent).toBe("unknown");
  } finally {
    await act(async () => root.unmount());
  }
});
it("refuses continually changing reads instead of guessing quantities", async () => {
  let count = 0;
  vi.mocked(getPendingLoans).mockImplementation(async () =>
    pending(String(++count))
  );
  vi.mocked(getWantListMatches).mockResolvedValue(matches("3"));
  await expect(
    readBorrowMatches("deck", new AbortController().signal)
  ).rejects.toThrow("changed during");
});
