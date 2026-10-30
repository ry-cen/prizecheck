import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READ_TIMEOUT_MS, timedRead } from "./timedRead";

describe("timedRead", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves a read that finishes before the deadline", async () => {
    const result = timedRead(
      () =>
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("ready"), 1000)
        )
    );
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe("ready");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the deadline counts from the call, not earlier", async () => {
    await vi.advanceTimersByTimeAsync(3000);
    const result = timedRead(
      () =>
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("ready"), 3000)
        )
    );
    await vi.advanceTimersByTimeAsync(3000);
    await expect(result).resolves.toBe("ready");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects at the deadline when the reader ignores its signal", async () => {
    let sent: AbortSignal | undefined;
    const result = timedRead((signal) => {
      sent = signal;
      return new Promise<never>(() => {});
    });
    const expired = expect(result).rejects.toThrow("Read timed out");
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    await expired;
    expect(sent?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects at once and never calls read when the parent is already aborted", async () => {
    const parent = new AbortController();
    const reason = new Error("superseded");
    parent.abort(reason);
    const read = vi.fn(async () => "should not send");
    await expect(timedRead(read, parent.signal)).rejects.toBe(reason);
    expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("parent abort cancels a sent read", async () => {
    const parent = new AbortController();
    let sent: AbortSignal | undefined;
    const result = timedRead((signal) => {
      sent = signal;
      return new Promise<never>(() => {});
    }, parent.signal);
    const reason = new Error("unmounted");
    const stopped = expect(result).rejects.toBe(reason);
    parent.abort(reason);
    await stopped;
    expect(sent?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a synchronous throw rejects and leaves no timer", async () => {
    await expect(
      timedRead(() => {
        throw new Error("failed immediately");
      })
    ).rejects.toThrow("failed immediately");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a late rejection after the deadline is not unhandled", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const result = timedRead(
        () =>
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("late failure")),
              READ_TIMEOUT_MS + 100
            )
          )
      );
      const expired = expect(result).rejects.toThrow("Read timed out");
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
      await expired;
      await vi.advanceTimersByTimeAsync(100);
      expect(unhandled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
