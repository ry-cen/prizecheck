// PROTOTYPE — throwaway. Three answers to "how do sign-in, the Sign-ins page, failure messages and loading look on the
// shared design system?" for "Prototype sign-in and loading screens" (#140), switched with ?auth=A|B|C.
//   A  Centred card under the slim public header: provider links stacked full width, the email form below an "or"
//      divider only when email sign-in is on.
//   B  Split showcase: a brand panel (card fan, what PrizeCheck does) beside the sign-in panel; on a phone the brand
//      panel shrinks to a band above it.
//   C  Sign-in over the public site: /sign-in is Discover with a sign-in dialog open over it (a bottom sheet on a phone).
// Shared, from "Spec: OAuth sign-in with Google and Discord" (#147): buttons are plain <a href> links drawn from the
// GET /auth/methods list (no hard-coded names; an unknown provider gets a generic button); the message is an alert,
// focused once, directly above the buttons, and the ?error= parameter is stripped after it is read. Loading, unavailable
// and not-found are one shared design each. Sample data only.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Shell } from "../app-shell/AppShellPrototype";
import { Art } from "../deck-experience/DeckExperience";
import "./SignInPrototype.css";

export const AUTH_VARIANTS = [
  { key: "A", name: "Centred card" },
  { key: "B", name: "Split showcase" },
  { key: "C", name: "Dialog over Discover" },
] as const;
export type AuthVariant = (typeof AUTH_VARIANTS)[number]["key"];
export type AuthScreen = "off" | "signin" | "loading" | "unavailable" | "notfound";

// ---------- store ----------
type Provider = { id: string; name: string };
const ALL_PROVIDERS: Provider[] = [
  { id: "google", name: "Google" },
  { id: "discord", name: "Discord" },
  { id: "github", name: "GitHub" }, // stands in for "a third provider added later", which has no brand asset
];
type AuthState = {
  variant: AuthVariant;
  screen: AuthScreen;
  email: boolean;
  providers: 1 | 2 | 3;
  next: string | null;
  linked: Record<string, string | null>;
  errorKey: number;
};
const p = new URLSearchParams(location.search);
let state: AuthState = {
  variant: (["A", "B", "C"].includes(p.get("auth") ?? "") ? p.get("auth") : "A") as AuthVariant,
  screen: (p.get("screen") as AuthScreen) ?? "off",
  email: p.get("email") === "on",
  providers: 2,
  next: null,
  linked: { google: "2026-10-12", discord: null, github: null },
  errorKey: 0,
};
const subs = new Set<() => void>();
function set(patch: Partial<AuthState> | ((s: AuthState) => Partial<AuthState>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  subs.forEach((f) => f());
}
export function useAuth() {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => state
  );
}
function setParam(name: string, value: string | null) {
  const url = new URL(location.href);
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  history.replaceState(null, "", url);
}
export function setAuthVariant(v: AuthVariant) {
  setParam("auth", v);
  set({ variant: v });
}
export function showAuthScreen(screen: AuthScreen, next: string | null = null) {
  setParam("screen", screen === "off" ? null : screen);
  set({ screen, next });
}
/** Simulates landing back on the page with ?error=<code>, as the gateway's error redirect does. */
function arriveWithError(code: string) {
  setParam("error", code);
  set((s) => ({ errorKey: s.errorKey + 1 }));
}
const methods = (s: AuthState) => ({ providers: ALL_PROVIDERS.slice(0, s.providers), email: s.email });

// ---------- messages: the final copy for the seven groups ----------
type Group = { title: string; body: (provider: string) => string; next: "buttons" | "none" | "retry" | "signins" | "signin-again" };
const GROUPS: Record<string, Group> = {
  cancelled: { title: "Sign-in was cancelled.", body: () => "Nothing was changed. Choose a way to sign in below.", next: "buttons" },
  closed: { title: "PrizeCheck isn't open to new collectors yet.", body: () => "Sign-ups open once testing is done. Until then, anyone can browse public decks.", next: "none" },
  unverified: { title: "Your {P} account needs a verified email address.", body: (pr) => `Verify your email with ${pr}, then try again, or choose another way to sign in.`, next: "buttons" },
  other: { title: "That {P} sign-in is already connected to a different PrizeCheck account.", body: () => "Sign in with that account to manage it, or connect a different one here.", next: "signins" },
  stale: { title: "For your security, sign in again to change your sign-ins.", body: () => "You'll come straight back here afterwards.", next: "signin-again" },
  busy: { title: "Too many sign-ins right now.", body: () => "Try again in a little while.", next: "none" },
  failed: { title: "Sign-in didn't complete.", body: () => "Try again. If it keeps happening, try another way to sign in.", next: "retry" },
};
const CODES: Record<string, keyof typeof GROUPS> = {
  access_denied: "cancelled",
  sign_in_unavailable: "closed",
  signup_disabled: "closed",
  email_not_found: "unverified",
  email_not_verified: "unverified",
  account_already_linked_to_different_user: "other",
  recent_sign_in_required: "stale",
  too_many_sign_ups: "busy",
};
export const ERROR_CHOICES = [
  "access_denied",
  "sign_in_unavailable",
  "email_not_verified",
  "too_many_sign_ups",
  "state_mismatch",
  "account_already_linked_to_different_user",
  "recent_sign_in_required",
];
const groupFor = (code: string) => GROUPS[CODES[code] ?? "failed"];
const SIGNINS_ONLY = new Set(["other", "stale"]);

/** Reads ?error= once, maps it through the allowlist (never shows free text), strips it from the address bar. */
function useErrorParam(where: "signin" | "signins") {
  const a = useAuth();
  const [msg, setMsg] = useState<{ g: Group; provider: string } | null>(null);
  useEffect(() => {
    const url = new URL(location.href);
    const code = url.searchParams.get("error");
    if (!code) return;
    const key = CODES[code] ?? "failed";
    // Sign-ins-only groups that land on the sign-in page read as "Didn't complete", and the reverse.
    const g = (where === "signin") === SIGNINS_ONLY.has(key) ? GROUPS.failed : GROUPS[key];
    setMsg({ g, provider: url.searchParams.get("provider") ? "Discord" : "Google" });
    url.searchParams.delete("error");
    url.searchParams.delete("error_description");
    history.replaceState(null, "", url);
  }, [a.errorKey, where]);
  return [msg, () => setMsg(null)] as const;
}
function Alert({ g, provider, onDismiss }: { g: Group; provider: string; onDismiss?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), [g]);
  return (
    <div ref={ref} className={`sx-alert${g === GROUPS.closed ? " sx-alert-calm" : ""}`} role="alert" tabIndex={-1}>
      <strong>{g.title.replace("{P}", provider)}</strong>
      <span>{g.body(provider)}</span>
      {g.next === "signin-again" && (
        <a className="sx-link" href="#signin-again" onClick={(e) => (e.preventDefault(), showAuthScreen("signin", "/settings/sign-ins"))}>
          Sign in again
        </a>
      )}
      {g.next === "none" && g === GROUPS.closed && (
        <a className="sx-link" href="#discover" onClick={(e) => (e.preventDefault(), showAuthScreen("off"))}>
          Browse public decks
        </a>
      )}
      {onDismiss && g.next === "signins" && (
        <button type="button" className="sx-link" onClick={onDismiss}>
          Back to Sign-ins
        </button>
      )}
    </div>
  );
}

// ---------- provider buttons ----------
function GoogleG() {
  // PROTOTYPE: the widely used standard-colour G; ship Google's downloaded asset instead.
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
function DiscordMark() {
  // PROTOTYPE: a placeholder silhouette; ship Discord's official white logo, unmodified.
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="#fff" d="M19.6 5.3A16.6 16.6 0 0 0 15.5 4l-.5 1a15 15 0 0 0-6 0l-.5-1a16.6 16.6 0 0 0-4.1 1.3C1.8 9.2 1.1 13 1.4 16.8a16.8 16.8 0 0 0 5 2.6l1.1-1.7c-.6-.2-1.2-.5-1.7-.8l.4-.3a11.9 11.9 0 0 0 11.6 0l.4.3c-.5.3-1.1.6-1.7.8l1.1 1.7a16.8 16.8 0 0 0 5-2.6c.4-4.4-.7-8.2-3-11.5ZM8.7 14.5c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm6.6 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z" />
    </svg>
  );
}
/** The per-provider asset map. Anything not in it renders the generic button, so a new provider needs no page change. */
const BRANDED: Record<string, { cls: string; mark: () => ReactNode }> = {
  google: { cls: "sx-google", mark: () => <GoogleG /> },
  discord: { cls: "sx-discord", mark: () => <DiscordMark /> },
};
function ProviderLinks() {
  const a = useAuth();
  const next = a.next ? `?next=${encodeURIComponent(a.next)}` : "";
  return (
    <div className="sx-providers">
      {methods(a).providers.map((pr) => {
        const b = BRANDED[pr.id];
        return (
          <a key={pr.id} className={`sx-provider ${b?.cls ?? "sx-generic"}`} href={`/auth/sign-in/${pr.id}${next}`} onClick={(e) => (e.preventDefault(), signedIn())}>
            <span className="sx-mark" aria-hidden="true">{b ? b.mark() : <span className="sx-letter">{pr.name[0]}</span>}</span>
            <span>Continue with {pr.name}</span>
          </a>
        );
      })}
    </div>
  );
}
let onSignedIn: () => void = () => {};
function signedIn() {
  showAuthScreen("off");
  onSignedIn();
}

function EmailForm() {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  return (
    <>
      <div className="sx-or" role="separator">
        <span>or</span>
      </div>
      {step === "email" ? (
        <form className="sx-form" onSubmit={(e) => (e.preventDefault(), setStep("code"))}>
          <label className="sx-field">
            <span>Email</span>
            <input className="sx-input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button className="sx-btn" type="submit">
            Email me a code
          </button>
        </form>
      ) : (
        <form className="sx-form" onSubmit={(e) => (e.preventDefault(), signedIn())}>
          <p className="sx-small">
            We sent a six-digit code to <strong>{email || "you"}</strong>. It works for 10 minutes.
          </p>
          <label className="sx-field">
            <span>Six-digit code</span>
            <input className="sx-input sx-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required />
          </label>
          <button className="sx-btn sx-btn-primary" type="submit">
            Sign in
          </button>
          <div className="sx-row">
            <button type="button" className="sx-link" onClick={() => setStep("email")}>
              Use a different email
            </button>
            <button type="button" className="sx-link">
              Send a new code
            </button>
          </div>
        </form>
      )}
    </>
  );
}

/** Everything inside the sign-in surface, in the DOM order the spec needs: heading, alert, then the buttons. */
function SignInPanel({ heading = true }: { heading?: boolean }) {
  const a = useAuth();
  const [msg] = useErrorParam("signin");
  return (
    <div className="sx-panel-body">
      {heading && (
        <>
          <h1 className="sx-h1">Sign in to PrizeCheck</h1>
          <p className="sx-small sx-muted">{a.next ? "Sign in to continue where you left off." : a.variant === "A" ? "Know every card you own, and where it is." : "Your collection, decks and missing cards, in one place."}</p>
        </>
      )}
      {msg && <Alert g={msg.g} provider={msg.provider} />}
      <ProviderLinks />
      {a.email && <EmailForm />}
      <p className="sx-fine">By continuing you agree to PrizeCheck's terms and privacy notice. We never post anything to your accounts.</p>
    </div>
  );
}

function PublicHeader({ onSignIn = true }: { onSignIn?: boolean }) {
  return (
    <header className="sx-header">
      <a className="sx-brand" href="#discover" onClick={(e) => (e.preventDefault(), showAuthScreen("off"))}>
        <span aria-hidden="true">✦</span> PrizeCheck
      </a>
      <span className="sx-spacer" />
      <a className="sx-headlink" href="#discover" onClick={(e) => (e.preventDefault(), showAuthScreen("off"))}>
        Discover decks
      </a>
      {onSignIn && (
        <button type="button" className="sx-btn sx-btn-primary" onClick={() => showAuthScreen("signin")}>
          Sign in
        </button>
      )}
    </header>
  );
}

// ---------- the three sign-in screens ----------
function SignInA() {
  return (
    <div className="sx-root">
      <PublicHeader onSignIn={false} />
      <main className="sx-main sx-center">
        <section className="sx-card" aria-label="Sign in">
          <SignInPanel />
        </section>
      </main>
    </div>
  );
}
const FAN = [
  { name: "Iono", hue: 300 },
  { name: "Charizard ex", hue: 15 },
  { name: "Gardevoir ex", hue: 270 },
];
function SignInB() {
  return (
    <div className="sx-root">
      <PublicHeader onSignIn={false} />
      <main className="sx-main sx-split">
        <section className="sx-panel" aria-label="Sign in">
          <SignInPanel />
        </section>
        <aside className="sx-showcase" aria-label="What PrizeCheck does">
          <div className="sx-fan" aria-hidden="true">
            {FAN.map((c) => (
              <span key={c.name} className="sx-fancard">
                <Art name={c.name} hue={c.hue} />
              </span>
            ))}
          </div>
          <p className="sx-tagline">Know every card you own, and where it is.</p>
          <ul className="sx-points">
            <li>Sort copies into binders, boxes and decks</li>
            <li>Build decks from what you own, and see what's missing</li>
            <li>Check format legality and the cost to finish</li>
          </ul>
        </aside>
      </main>
    </div>
  );
}
function SignInC() {
  return (
    <div className="sx-root">
      <PublicHeader />
      <main className="sx-main">
        <DiscoverBehind />
      </main>
      <div className="sx-scrim" onClick={() => showAuthScreen("off")} />
      <section className="sx-dialog" role="dialog" aria-modal="true" aria-label="Sign in to PrizeCheck">
        <div className="sx-dialoghead">
          <h1 className="sx-h1">Sign in to PrizeCheck</h1>
          <button type="button" className="sx-close" aria-label="Close" onClick={() => showAuthScreen("off")}>
            ✕
          </button>
        </div>
        <SignInPanel heading={false} />
      </section>
    </div>
  );
}
function DiscoverBehind() {
  return (
    <>
      <h1 className="sx-pagetitle">Discover decks</h1>
      <div className="sx-decks" aria-hidden="true">
        {["Charizard ex", "Gardevoir ex", "Lost Box", "Iron Hands ex", "Dragapult ex", "Raging Bolt ex"].map((d, i) => (
          <div key={d} className="sx-deck">
            <Art name={d} hue={(i * 57) % 360} />
            <strong>{d}</strong>
            <span className="sx-small sx-muted">Standard · $1{i}4</span>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- loading, unavailable, not found (one shared design each) ----------
function Loading() {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setLate(true), 600);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className="sx-root sx-boot">
      <div className="sx-bootmark" aria-hidden="true">
        ✦ PrizeCheck
      </div>
      <p className="sx-small sx-muted" role="status">
        {late ? "Loading…" : ""}
      </p>
    </div>
  );
}
function Gone({ kind }: { kind: "unavailable" | "notfound" }) {
  return (
    <div className="sx-root">
      <PublicHeader />
      <main className="sx-main sx-center">
        <section className="sx-card sx-gone" aria-labelledby="gone-h">
          <span className="sx-gonemark" aria-hidden="true">
            {kind === "unavailable" ? "⊘" : "?"}
          </span>
          <h1 id="gone-h" className="sx-h1">
            {kind === "unavailable" ? "This deck isn't published anymore" : "Page not found"}
          </h1>
          <p className="sx-small sx-muted">
            {kind === "unavailable"
              ? "Its owner stopped sharing it, or the link changed. Published decks are snapshots, so an old link can stop working."
              : "The link may be mistyped, or the page has moved."}
          </p>
          <div className="sx-row sx-row-center">
            <button type="button" className="sx-btn sx-btn-primary" onClick={() => showAuthScreen("off")}>
              Discover decks
            </button>
            <button type="button" className="sx-btn" onClick={() => showAuthScreen("signin")}>
              Sign in
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

/** Full-screen auth surfaces. Null when the shell should render. */
export function AuthScreens({ s }: { s: Shell }) {
  const a = useAuth();
  onSignedIn = () => s.setSignedIn(true);
  if (a.screen === "off") return null;
  if (a.screen === "loading") return <Loading />;
  if (a.screen === "unavailable" || a.screen === "notfound") return <Gone kind={a.screen} />;
  return a.variant === "A" ? <SignInA /> : a.variant === "B" ? <SignInB /> : <SignInC />;
}

// ---------- Sign-ins settings page (inside the shell) ----------
export function SignInsPage() {
  const a = useAuth();
  const [msg, dismiss] = useErrorParam("signins");
  const providers = methods(a).providers;
  const linkedCount = providers.filter((pr) => a.linked[pr.id]).length;
  return (
    <div className="sx-signins">
      <p className="sx-small sx-muted">
        Your account email: <strong className="sx-text">rycen618@gmail.com</strong>
      </p>
      {msg && <Alert g={msg.g} provider={msg.provider} onDismiss={dismiss} />}
      <ul className="sx-list">
        {providers.map((pr) => {
          const b = BRANDED[pr.id];
          const when = a.linked[pr.id];
          return (
            <li key={pr.id}>
              <span className={`sx-chipmark ${b?.cls ?? "sx-generic"}`} aria-hidden="true">
                {b ? b.mark() : <span className="sx-letter">{pr.name[0]}</span>}
              </span>
              <span className="sx-listname">
                <strong>{pr.name}</strong>
                <span className="sx-small sx-muted">{when ? `Connected ${when}` : "Not connected"}</span>
              </span>
              {when ? (
                linkedCount > 1 && (
                  <button type="button" className="sx-btn" onClick={() => set((s) => ({ linked: { ...s.linked, [pr.id]: null } }))}>
                    Remove
                  </button>
                )
              ) : (
                <a className="sx-btn" href={`/auth/link/${pr.id}`} onClick={(e) => (e.preventDefault(), set((s) => ({ linked: { ...s.linked, [pr.id]: "2026-10-12" } })))}>
                  Connect
                </a>
              )}
            </li>
          );
        })}
      </ul>
      <p className="sx-small sx-muted">You can sign in with any connected account. Your last sign-in can't be removed.</p>
    </div>
  );
}

// ---------- switcher controls ----------
export function AuthPicker() {
  const a = useAuth();
  return (
    <>
      <label>
        auth{" "}
        <select value={a.variant} onChange={(e) => setAuthVariant(e.target.value as AuthVariant)}>
          {AUTH_VARIANTS.map((v) => (
            <option key={v.key} value={v.key}>
              {v.key} ({v.name})
            </option>
          ))}
        </select>
      </label>
      <label>
        screen{" "}
        <select value={a.screen} onChange={(e) => showAuthScreen(e.target.value as AuthScreen)}>
          {["off", "signin", "loading", "unavailable", "notfound"].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </label>
      <label>
        providers{" "}
        <select value={a.providers} onChange={(e) => set({ providers: Number(e.target.value) as 1 | 2 | 3 })}>
          <option value={1}>1 (Google)</option>
          <option value={2}>2 (+ Discord)</option>
          <option value={3}>3 (+ unbranded)</option>
        </select>
      </label>
      <label>
        <input type="checkbox" checked={a.email} onChange={(e) => (setParam("email", e.target.checked ? "on" : null), set({ email: e.target.checked }))} /> email on
      </label>
      <label>
        error{" "}
        <select value="" onChange={(e) => e.target.value && arriveWithError(e.target.value)}>
          <option value="">arrive with…</option>
          {ERROR_CHOICES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
    </>
  );
}
