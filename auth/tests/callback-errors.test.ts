import { describe, expect, it } from "vitest";
import {
  neutralCallback,
  neutralCallbackLocation,
} from "../src/callbackErrors.js";

const NOT_LINKED = "/sign-in?provider=google&error=account_not_linked";
const NOT_OPEN =
  "/sign-in?provider=google&error=sign_in_unavailable&error_description=sign_in_unavailable";

describe("neutralCallbackLocation", () => {
  it("turns account_not_linked into the owner-only refusal under owner-only", () => {
    expect(neutralCallbackLocation(NOT_LINKED, false)).toBe(NOT_OPEN);
    expect(
      neutralCallbackLocation(
        "http://localhost:5173/sign-in?error=account_not_linked",
        false
      )
    ).toBe(
      "http://localhost:5173/sign-in?error=sign_in_unavailable&error_description=sign_in_unavailable"
    );
  });
  it("leaves it alone in public modes, and leaves every other location alone", () => {
    expect(neutralCallbackLocation(NOT_LINKED, true)).toBe(NOT_LINKED);
    for (const location of [
      "/collection",
      NOT_OPEN,
      "/sign-in?provider=discord&error=email_not_verified&error_description=email_not_verified",
      "/sign-in?provider=google&error=access_denied",
    ])
      expect(neutralCallbackLocation(location, false)).toBe(location);
  });
});

describe("neutralCallback", () => {
  it("keeps the status and cookies while rewriting the Location", () => {
    const headers = new Headers({ location: NOT_LINKED });
    headers.append("set-cookie", "better-auth.state=; Max-Age=0; Path=/");
    const result = neutralCallback(
      new Response(null, { status: 302, headers }),
      false
    );
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toBe(NOT_OPEN);
    expect(result.headers.getSetCookie()).toEqual([
      "better-auth.state=; Max-Age=0; Path=/",
    ]);
  });
  it("returns the same response when nothing changes", () => {
    const original = new Response(null, {
      status: 302,
      headers: { location: "/collection" },
    });
    expect(neutralCallback(original, false)).toBe(original);
  });
});
