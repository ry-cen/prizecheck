import { describe, expect, it } from "vitest";
import type { PendingLoans } from "../social_generated";
import {
  createPendingReader,
  pendingText,
  type PendingState,
} from "./pendingLoans";

type Call = {
  deckId: string;
  signal: AbortSignal;
  resolve: (answer: PendingLoans) => void;
  reject: (cause: unknown) => void;
};

function harness() {
  const calls: Call[] = [];
  const states: PendingState[] = [];
  let visible = true;
  const reader = createPendingReader({
    read: (deckId, signal) =>
      new Promise<PendingLoans>((resolve, reject) =>
        calls.push({ deckId, signal, resolve, reject })
      ),
    visible: () => visible,
    onState: (state) => states.push(state),
  });
  return {
    reader,
    calls,
    states,
    last: () => states[states.length - 1],
    hide: () => (visible = false),
    show: () => (visible = true),
  };
}

const answer = (deckId: string, accepted = "1"): PendingLoans => ({
  deck_id: deckId,
  lines: [
    {
      edition_id: "iono",
      requested: "0",
      accepted,
      lenders: [{ lender: "Misty W.", state: "accepted", copies: accepted }],
    },
  ],
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the pending reader", () => {
  it("reads on a new Deck and reads nothing for All Decks", async () => {
    const h = harness();
    // All Decks is where the reader starts: nothing to read and nothing new to show.
    h.reader.setScope(null, "");
    expect(h.calls).toHaveLength(0);
    expect(h.states).toEqual([]);
    h.reader.setScope("charizard", "1:1:a");
    expect(h.calls.map((call) => call.deckId)).toEqual(["charizard"]);
    expect(h.last()).toEqual({ kind: "loading", deckId: "charizard" });
    h.calls[0].resolve(answer("charizard"));
    await settle();
    expect(h.last()).toMatchObject({ kind: "ready", stale: false });
  });

  it("reads once for the focus and visibility notifications of one return", () => {
    const h = harness();
    h.reader.setScope("charizard", "1:1:a");
    // A focus with no leave before it (the page's own first focus) has nothing to catch up on.
    h.reader.trigger("return");
    expect(h.calls).toHaveLength(1);
    h.reader.leave();
    h.reader.leave();
    h.reader.trigger("return");
    h.reader.trigger("return");
    expect(h.calls).toHaveLength(2);
  });

  it("reads on a blur and focus straight after a read, however soon", () => {
    // Regression: a time window after any read swallowed a genuine return, and with no pulse for a write-off the line
    // stayed stale until the next visit.
    const h = harness();
    h.reader.setScope("charizard", "1:1:a");
    h.reader.leave();
    h.reader.trigger("return");
    expect(h.calls).toHaveLength(2);
    h.reader.leave();
    h.reader.trigger("return");
    expect(h.calls).toHaveLength(3);
  });

  it("reads again for new pins of the same Deck and keeps its answer meanwhile", async () => {
    // Regression: the Deck List was edited to an Edition a request already waits on; the Want List read again, so must
    // the pending, on the same Deck.
    const h = harness();
    h.reader.setScope("charizard", "1:1:a");
    h.calls[0].resolve(answer("charizard"));
    await settle();
    h.reader.setScope("charizard", "1:1:a");
    expect(h.calls).toHaveLength(1);
    h.reader.setScope("charizard", "1:1:b");
    expect(h.calls).toHaveLength(2);
    expect(h.last()).toMatchObject({ kind: "ready", stale: false });
    h.calls[1].resolve(answer("charizard", "2"));
    await settle();
    const ready = h.last();
    expect(ready.kind === "ready" && ready.lines.get("iono")?.accepted).toBe(
      "2"
    );
  });

  it("does no work while hidden and reads when the page becomes visible", () => {
    const h = harness();
    h.hide();
    h.reader.setScope("charizard", "1:1:a");
    h.reader.trigger("signal");
    expect(h.calls).toHaveLength(0);
    h.show();
    h.reader.trigger("return");
    expect(h.calls).toHaveLength(1);
  });

  it("reads on every signal and retry, aborting the read in flight", () => {
    const h = harness();
    h.reader.setScope("charizard", "1:1:a");
    h.reader.trigger("signal");
    expect(h.calls[0].signal.aborted).toBe(true);
    h.reader.trigger("retry");
    expect(h.calls).toHaveLength(3);
    expect(h.calls[1].signal.aborted).toBe(true);
  });

  it("drops a slow answer for an older Deck or generation", async () => {
    const h = harness();
    h.reader.setScope("charizard", "1:1:a");
    h.reader.setScope("gardevoir", "1:1:a");
    h.calls[0].resolve(answer("charizard"));
    await settle();
    expect(h.last()).toEqual({ kind: "loading", deckId: "gardevoir" });
    h.reader.trigger("signal");
    h.calls[1].resolve(answer("gardevoir", "3"));
    h.calls[2].resolve(answer("gardevoir", "2"));
    await settle();
    const ready = h.last();
    expect(ready.kind === "ready" && ready.lines.get("iono")?.accepted).toBe(
      "2"
    );
  });

  it("lets nothing in flight reach the screen after it is disposed, as on sign-out", async () => {
    const h = harness();
    h.reader.setScope("charizard", "1:1:a");
    const before = h.states.length;
    h.reader.dispose();
    expect(h.calls[0].signal.aborted).toBe(true);
    h.calls[0].resolve(answer("charizard"));
    await settle();
    h.reader.trigger("signal");
    h.reader.setScope("gardevoir", "1:1:a");
    h.reader.setScope("charizard", "2:1:a");
    expect(h.states).toHaveLength(before);
    expect(h.calls).toHaveLength(1);
  });

  it("keeps the last answer marked stale when a refresh fails, and never shows nothing asked for", async () => {
    const h = harness();
    h.reader.setScope("charizard", "1:1:a");
    h.calls[0].reject(new Error("offline"));
    await settle();
    expect(h.last()).toEqual({ kind: "failed", deckId: "charizard" });
    h.reader.trigger("retry");
    h.calls[1].resolve(answer("charizard"));
    await settle();
    h.reader.trigger("signal");
    h.calls[2].reject(new Error("offline"));
    await settle();
    const stale = h.last();
    expect(stale).toMatchObject({ kind: "ready", stale: true });
    expect(stale.kind === "ready" && stale.lines.get("iono")?.accepted).toBe(
      "1"
    );
  });

  it("picks up a write-off the pulse never saw at the next return", async () => {
    const h = harness();
    h.reader.setScope("charizard", "1:1:a");
    h.calls[0].resolve(answer("charizard", "3"));
    await settle();
    // No pulse and no signal: the screen keeps 3 until the collector comes back to it, even straight away.
    expect(h.calls).toHaveLength(1);
    h.reader.leave();
    h.reader.trigger("return");
    h.calls[1].resolve(answer("charizard", "2"));
    await settle();
    const ready = h.last();
    expect(ready.kind === "ready" && ready.lines.get("iono")?.accepted).toBe(
      "2"
    );
  });
});

describe("the pending note", () => {
  it("names each lender, promises first as the API orders them", () => {
    expect(
      pendingText({
        edition_id: "iono",
        requested: "2",
        accepted: "1",
        lenders: [
          { lender: "Misty W.", state: "accepted", copies: "1" },
          { lender: "Brock S.", state: "requested", copies: "2" },
        ],
      })
    ).toBe("Misty W. agreed to lend 1 · Asked Brock S. for 2");
    expect(pendingText(undefined)).toBe("");
  });
});
