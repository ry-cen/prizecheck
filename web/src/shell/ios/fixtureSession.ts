/** This is a local demonstration, not an authentication implementation. Nothing here grants API access. */
export const RETURN_URL = "prizecheck-prototype://auth/return";
const KEY = "prizecheck.ios.fixture.v1";
const ATTEMPT_MS = 5 * 60_000;
const SESSION_MS = 30 * 60_000;
type Pending = { state: string; until: number };
type Session = { userId: "fixture-collector"; until: number };
export type FixtureState = {
  pending?: Pending;
  session?: Session;
};
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export class FixtureSession {
  private value: FixtureState = {};
  constructor(
    private store: Store,
    private now = Date.now
  ) {
    try {
      const parsed = JSON.parse(store.getItem(KEY) || "{}");
      if (
        parsed.session?.userId === "fixture-collector" &&
        Number.isFinite(parsed.session.until) &&
        parsed.session.until > now() &&
        parsed.session.until <= now() + SESSION_MS
      )
        this.value.session = parsed.session;
      if (
        typeof parsed.pending?.state === "string" &&
        /^[a-f0-9]{64}$/.test(parsed.pending.state) &&
        Number.isFinite(parsed.pending.until) &&
        parsed.pending.until > now() &&
        parsed.pending.until <= now() + ATTEMPT_MS
      )
        this.value.pending = parsed.pending;
    } catch {
      /* Corrupt local demo state is signed out. */
    }
    this.save();
  }
  private save() {
    this.store.setItem(KEY, JSON.stringify(this.value));
  }
  signedIn() {
    if (this.value.session && this.value.session.until <= this.now()) {
      delete this.value.session;
      this.save();
    }
    return !!this.value.session;
  }
  waiting() {
    if (this.value.pending && this.value.pending.until <= this.now()) {
      delete this.value.pending;
      this.save();
    }
    return !!this.value.pending;
  }
  begin() {
    const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, "0")
    ).join("");
    this.value = { pending: { state, until: this.now() + ATTEMPT_MS } };
    this.save();
    return `http://127.0.0.1:4319/sign-in?state=${state}`;
  }
  cancel() {
    this.value = {};
    this.save();
  }
  returnFromBrowser(
    address: string
  ): "success" | "cancelled" | "error" | "ignored" {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return "ignored";
    }
    if (
      `${url.protocol}//${url.host}${url.pathname}` !== RETURN_URL ||
      url.hash ||
      url.username ||
      url.password
    )
      return "ignored";
    const pending = this.value.pending;
    if (
      !pending ||
      pending.until <= this.now() ||
      url.searchParams.getAll("state").length !== 1 ||
      url.searchParams.get("state") !== pending.state
    )
      return "ignored";
    this.cancel(); // Consume every matched attempt once, including malformed results.
    if (
      url.searchParams.getAll("result").length !== 1 ||
      [...url.searchParams.keys()].some(
        (key) => !["state", "result"].includes(key)
      )
    )
      return "error";
    const result = url.searchParams.get("result");
    if (result === "success") {
      this.value.session = {
        userId: "fixture-collector",
        until: this.now() + SESSION_MS,
      };
      this.save();
      return "success";
    }
    return result === "cancelled" ? "cancelled" : "error";
  }
}
