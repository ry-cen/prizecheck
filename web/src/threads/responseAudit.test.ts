import { expect, it, vi } from "vitest";
import { responseAudit } from "../../tests/support/responseAudit";
it("detaches before draining a pending privacy response and never reads teardown responses", async () => {
  let receive!: (response: { text: () => Promise<string> }) => void;
  const detach = vi.fn();
  const audit = responseAudit((listener) => {
    receive = listener;
    return detach;
  });
  let deliver!: (body: string) => void;
  receive({
    text: () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
  });
  const completed = audit.finish();
  expect(detach).toHaveBeenCalledTimes(1);
  const late = vi.fn(async () => {
    throw new Error("Target page, context or browser has been closed");
  });
  // A queued response callback may run while collectors teardown closes the context.
  receive({ text: late });
  expect(late).not.toHaveBeenCalled();
  deliver("public Trade body");
  await expect(completed).resolves.toEqual(["public Trade body"]);
  audit.stop();
  expect(detach).toHaveBeenCalledTimes(1);
});
it("still fails the audit on every unexpected captured body error, including context closure", async () => {
  let receive!: (response: { text: () => Promise<string> }) => void;
  const audit = responseAudit((listener) => {
    receive = listener;
    return () => {};
  });
  const error = new Error("Target page, context or browser has been closed");
  receive({
    text: async () => {
      throw error;
    },
  });
  await Promise.resolve();
  await expect(audit.finish()).rejects.toBe(error);
});
it("keeps valid bodies non-vacuous while retaining only the existing navigation-discard exception", async () => {
  let receive!: (response: { text: () => Promise<string> }) => void;
  const audit = responseAudit((listener) => {
    receive = listener;
    return () => {};
  });
  receive({ text: async () => '{"public":"cards"}' });
  receive({
    text: async () => {
      throw new Error(
        "Response unavailable: navigated away from this document"
      );
    },
  });
  await expect(audit.finish()).resolves.toEqual(['{"public":"cards"}']);
});
