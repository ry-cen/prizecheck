import { describe, expect, it } from "vitest";
import { FixtureSession, RETURN_URL } from "./fixtureSession";

function setup() {
  const values = new Map<string, string>();
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  let now = 1000;
  const clock = () => now;
  const session = new FixtureSession(store, clock);
  const address = session.begin();
  const state = new URL(address).searchParams.get("state")!;
  const callback = (result = "success") =>
    `${RETURN_URL}?state=${state}&result=${result}`;
  return {
    session,
    store,
    clock,
    callback,
    state,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("iOS fixture browser contract (no real credentials)", () => {
  it("recovers a pending attempt on cold launch and a session on relaunch", () => {
    const f = setup();
    const cold = new FixtureSession(f.store, f.clock);
    expect(cold.returnFromBrowser(f.callback())).toBe("success");
    expect(new FixtureSession(f.store, f.clock).signedIn()).toBe(true);
  });
  it("rejects unsolicited, mismatched, duplicate and foreign callbacks", () => {
    const f = setup();
    for (const address of [
      f.callback().replace(f.state, "attacker"),
      f.callback().replace("auth/return", "auth/other"),
      f.callback().replace("prizecheck-prototype:", "https:"),
      `${f.callback()}&state=${f.state}`,
      `${f.callback()}#extra`,
      "not a URL",
    ])
      expect(f.session.returnFromBrowser(address)).toBe("ignored");
    expect(f.session.signedIn()).toBe(false);
    expect(f.session.returnFromBrowser(f.callback())).toBe("success");
    expect(f.session.returnFromBrowser(f.callback())).toBe("ignored");
  });
  it.each(["cancelled", "error"])(
    "handles %s without creating a session",
    (result) => {
      const f = setup();
      expect(f.session.returnFromBrowser(f.callback(result))).toBe(result);
      expect(f.session.signedIn()).toBe(false);
      expect(f.session.returnFromBrowser(f.callback())).toBe("ignored");
    }
  );
  it("consumes malformed results without accepting credentials or arbitrary identities", () => {
    const f = setup();
    expect(f.session.returnFromBrowser(`${f.callback()}&token=forbidden`)).toBe(
      "error"
    );
    expect(f.session.signedIn()).toBe(false);
    expect(f.session.returnFromBrowser(f.callback())).toBe("ignored");
  });
  it("cancellation and sign-out invalidate old callbacks across relaunch", () => {
    const f = setup();
    f.session.cancel();
    expect(
      new FixtureSession(f.store, f.clock).returnFromBrowser(f.callback())
    ).toBe("ignored");
    const url = f.session.begin();
    const callback = `${RETURN_URL}?state=${new URL(url).searchParams.get("state")}&result=success`;
    expect(f.session.returnFromBrowser(callback)).toBe("success");
    f.session.cancel();
    expect(new FixtureSession(f.store, f.clock).signedIn()).toBe(false);
  });
  it("expires pending attempts and sessions with no cached Collection access", () => {
    const f = setup();
    f.advance(5 * 60_000);
    expect(f.session.returnFromBrowser(f.callback())).toBe("ignored");
    const g = setup();
    g.session.returnFromBrowser(g.callback());
    g.advance(30 * 60_000);
    expect(g.session.signedIn()).toBe(false);
    expect(new FixtureSession(g.store, g.clock).signedIn()).toBe(false);
  });
  it("treats corrupt or another collector's persisted state as signed out", () => {
    const f = setup();
    for (const value of [
      "invalid",
      "null",
      '{"session":{"userId":"another-collector","until":999999}}',
    ]) {
      f.store.setItem("prizecheck.ios.fixture.v1", value);
      expect(new FixtureSession(f.store, f.clock).signedIn()).toBe(false);
    }
  });
});
