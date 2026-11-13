import { expect, test, vi } from "vitest";
import { createRecoveryOwner } from "./recoveryNotice";
const add = () => ({ kind: "add" as const, message: "Added", undo: null });
const clear = () => ({ kind: "clear" as const, restore: () => true });
test("R1 claim retires the previous notice and returns a larger token", () => {
  const owner = createRecoveryOwner(vi.fn());
  const first = owner.claim(add()),
    second = owner.claim(clear());
  expect(second).toBe(first + 1);
  expect(owner.current()).toEqual({
    ...clear(),
    restore: expect.any(Function),
    token: second,
  });
  expect(owner.owns(first)).toBe(false);
});
test("R2 captured ownership is checked at call time", () => {
  const owner = createRecoveryOwner(vi.fn());
  const token = owner.claim(clear()),
    act = vi.fn();
  const held = () => {
    if (owner.owns(token)) act();
  };
  owner.claim(add());
  held();
  expect(act).not.toHaveBeenCalled();
});
test("R3 update only applies to the owning Add", () => {
  const owner = createRecoveryOwner(vi.fn());
  const first = owner.claim(add());
  expect(owner.update(first, { message: "Updated" })).toBe(true);
  expect(owner.current()).toMatchObject({ message: "Updated" });
  const second = owner.claim(clear());
  expect(owner.update(first, { message: "Stale" })).toBe(false);
  expect(owner.update(second, { message: "Wrong kind" })).toBe(false);
});
test("R4 stale retire leaves the owner; unqualified retire returns it", () => {
  const owner = createRecoveryOwner(vi.fn());
  const first = owner.claim(add()),
    second = owner.claim(clear());
  expect(owner.retire(first)).toBeNull();
  expect(owner.owns(second)).toBe(true);
  const current = owner.current();
  expect(owner.retire()).toBe(current);
  expect(owner.current()).toBeNull();
  expect(owner.owns(second)).toBe(false);
});
test("R5 onChange observes immutable claim, update and retire", () => {
  const changed = vi.fn(),
    owner = createRecoveryOwner(changed);
  const token = owner.claim(add()),
    first = owner.current();
  owner.update(token, { message: "Next" });
  const next = owner.current();
  expect(first).not.toBe(next);
  expect(first).toMatchObject({ message: "Added" });
  owner.retire(token);
  expect(changed.mock.calls.map(([n]) => n)).toEqual([first, next, null]);
});
