import { describe, expect, it, vi } from "vitest";
import { leaveForSignIn, startScanner } from "./bootstrap";

function session(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
    })) as typeof fetch;
}

describe("startScanner", () => {
  it("is ready with the signed-in user id", async () => {
    expect(
      await startScanner(session({ signedIn: true, userId: "user-1" }))
    ).toEqual({ kind: "ready", userId: "user-1" });
  });

  it("reads the session with the cookie, from /auth/session", async () => {
    const fetchSession = vi.fn(session({ signedIn: false, userId: null }));
    await startScanner(fetchSession as unknown as typeof fetch);
    expect(fetchSession).toHaveBeenCalledWith("/auth/session", {
      credentials: "same-origin",
    });
  });

  it.each([
    { signedIn: false, userId: null },
    { signedIn: false, userId: "user-1" },
    { signedIn: true },
    { signedIn: true, userId: "" },
    { signedIn: true, userId: null },
  ])("is signed out for %j", async (body) => {
    expect(await startScanner(session(body))).toEqual({ kind: "signed-out" });
  });

  it("is unavailable when the read fails, is not JSON or is not a success", async () => {
    const failing = (async () => {
      throw new TypeError("network");
    }) as typeof fetch;
    expect(await startScanner(failing)).toEqual({ kind: "unavailable" });
    expect(await startScanner(session("<html>"))).toEqual({
      kind: "unavailable",
    });
    expect(
      await startScanner(session({ signedIn: true, userId: "u" }, 503))
    ).toEqual({ kind: "unavailable" });
    expect(await startScanner(session({}, 500))).toEqual({
      kind: "unavailable",
    });
  });
});

describe("leaveForSignIn", () => {
  it("goes to Collection with a full navigation", () => {
    const assign = vi.fn();
    leaveForSignIn(assign);
    expect(assign).toHaveBeenCalledExactlyOnceWith("/collection");
  });
});
