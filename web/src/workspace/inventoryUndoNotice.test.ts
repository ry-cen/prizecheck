import { expect, test, vi } from "vitest";
import { MoveError } from "../moves_generated";
import { createUndoDismissals, noticeTurn } from "../inventoryUndoNotice";
vi.mock("../inventoryUndo", () => ({ dismissUndo: vi.fn() }));
function deferred() {
  let resolve!: () => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
test("two dismissals share one request and outcome", async () => {
  const d = deferred(),
    remove = vi.fn(() => d.promise),
    r = createUndoDismissals(remove);
  const a = r.dismiss("a"),
    b = r.dismiss("a");
  expect(a).toBe(b);
  expect(remove).toHaveBeenCalledTimes(1);
  d.resolve();
  expect(await a).toBe("dismissed");
  expect(await b).toBe("dismissed");
});
test("404 counts as dismissed and blocks", async () => {
  const r = createUndoDismissals(
    vi.fn().mockRejectedValue(new MoveError(404, "MISSING"))
  );
  expect(await r.dismiss("a")).toBe("dismissed");
  expect(r.blocks("a")).toBe(true);
});
test("failure releases the record for a new request", async () => {
  const remove = vi
      .fn()
      .mockRejectedValueOnce(new Error())
      .mockResolvedValue(undefined),
    r = createUndoDismissals(remove);
  expect(await r.dismiss("a")).toBe("failed");
  expect(r.blocks("a")).toBe(false);
  expect(await r.dismiss("a")).toBe("dismissed");
  expect(remove).toHaveBeenCalledTimes(2);
});
test("blocks during and after deletion and sends nothing more", async () => {
  const d = deferred(),
    remove = vi.fn(() => d.promise),
    r = createUndoDismissals(remove);
  const a = r.dismiss("a");
  expect(r.blocks("a")).toBe(true);
  d.resolve();
  await a;
  expect(r.blocks("a")).toBe(true);
  expect(await r.dismiss("a")).toBe("dismissed");
  expect(remove).toHaveBeenCalledTimes(1);
});
test("sync throw and undefined settle", async () => {
  const remove = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error();
      })
      .mockReturnValue(undefined),
    r = createUndoDismissals(remove);
  expect(await r.dismiss("a")).toBe("failed");
  expect(await r.dismiss("a")).toBe("dismissed");
});
test("turn stays free until another owner shows", () => {
  let version = 0;
  const turn = noticeTurn({ getVersion: () => version }, () => null);
  expect(turn()).toBe(true);
  version++;
  expect(turn()).toBe(false);
});
test("own later show keeps turn free until another owner shows", () => {
  let version = 0,
    own: number | null = null;
  const turn = noticeTurn({ getVersion: () => version }, () => own);
  own = ++version;
  expect(turn()).toBe(true);
  version++;
  expect(turn()).toBe(false);
});
