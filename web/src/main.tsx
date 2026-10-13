import { OperationsHealth } from "./OperationsHealth";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  getOwnerCatalogStatus,
  startCatalogRun,
  type OwnerCatalogStatus,
} from "./generated";
import { Collection } from "./Collection";
import { Decks } from "./Decks";
import { PublishedDeck } from "./PublishedDeck";
import { Discovery } from "./Discovery";
import { CatalogReview } from "./CatalogReview";
import { CatalogSearch } from "./CatalogSearch";
import { MetadataReview } from "./MetadataReview";
import { SignIns } from "./SignIns";
import {
  MissingCardReports,
  OwnerMissingCardReview,
} from "./MissingCardReports";
import { Workspace } from "./workspace/Workspace";
import {
  clearFailureFromAddress,
  failureInAddress,
  signInMessage,
} from "./signInMessages";
import "./style.css";
import "./tokens.css";

// A view's path is `/${view}`: the Sign-ins page (#156) is the view "settings/sign-ins" at /settings/sign-ins.
type View =
  | "workspace"
  | "collection"
  | "decks"
  | "catalog"
  | "reports"
  | "owner"
  | "settings/sign-ins";
const protectedViews: View[] = [
  "workspace",
  "collection",
  "decks",
  "catalog",
  "reports",
  "owner",
  "settings/sign-ins",
];
/** The workspace replaced the old Locations page (ticket 114): old /locations links and the bare origin open it. */
function canonicalPath(path: string): string {
  return path === "/" || path === "/locations" ? "/workspace" : path;
}
function pathView(): View {
  const candidate = location.pathname.slice(1) as View;
  return protectedViews.includes(candidate) ? candidate : "workspace";
}

type Session = { signedIn: boolean; userId: string | null };
/** GET /auth/methods: the configured providers and whether email-code sign-in is on. */
type SignInMethods = {
  providers: { id: string; name: string }[];
  emailSignIn: boolean;
};
/** The start link for a provider. `next` is sent only when the collector came here for a page; the gateway checks it. */
function providerStartHref(provider: string): string {
  const asked = new URLSearchParams(location.search).get("next");
  const page = protectedViews.includes(location.pathname.slice(1) as View)
    ? `${location.pathname}${location.search}${location.hash}`
    : null;
  const next = asked ?? page;
  return `/auth/sign-in/${encodeURIComponent(provider)}${next ? `?next=${encodeURIComponent(next)}` : ""}`;
}
function safeDestination(): string {
  const value = new URLSearchParams(location.search).get("next");
  if (!value)
    return protectedViews.includes(
      canonicalPath(location.pathname).slice(1) as View
    )
      ? `${canonicalPath(location.pathname)}${location.search}${location.hash}`
      : "/workspace";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    return "/workspace";
  const url = new URL(value, location.origin);
  return url.origin === location.origin
    ? `${canonicalPath(url.pathname)}${url.search}${url.hash}`
    : "/workspace";
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ownerCatalog, setOwnerCatalog] = useState<OwnerCatalogStatus | null>(
    null
  );
  const [view, setView] = useState<View>(pathView);
  const showOwner = view === "owner";
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState("");
  const [methods, setMethods] = useState<SignInMethods | null>(null);
  // A failed sign-in lands here with ?error=<code>: read once, shown once, then removed from the address bar. Once
  // signed in it is dropped, so a later sign-out never replays it.
  const [failure, setFailure] = useState(failureInAddress);
  const failureRef = useRef<HTMLDivElement>(null);
  const failureShown = useRef(false);

  async function refresh() {
    try {
      const response = await fetch("/auth/session", {
        credentials: "same-origin",
      });
      const result = (await response.json()) as Session;
      setSession(result);
      if (result.signedIn) {
        setOwnerCatalog(await getOwnerCatalogStatus());
      }
    } catch {
      setMessage("Service temporarily unavailable. Please retry.");
    }
  }
  useEffect(() => {
    if (session?.signedIn !== false || methods !== null) return;
    void (async () => {
      try {
        const response = await fetch("/auth/methods", {
          credentials: "same-origin",
        });
        const body = response.ok ? await response.json() : null;
        if (
          !Array.isArray(body?.providers) ||
          typeof body.emailSignIn !== "boolean"
        )
          throw new Error("Sign-in methods unavailable");
        setMethods(body as SignInMethods);
      } catch {
        setMessage("Sign-in is temporarily unavailable. Please retry.");
      }
    })();
  }, [session?.signedIn, methods]);
  useEffect(() => {
    if (!failure || session === null) return;
    // Signed in (another tab finished signing in, or the back button): never show the code; drop it from the address.
    if (session.signedIn) {
      setFailure(null);
      clearFailureFromAddress();
      return;
    }
    if (failureShown.current || methods === null) return;
    failureShown.current = true;
    failureRef.current?.focus();
    clearFailureFromAddress();
  }, [failure, session, methods]);
  useEffect(() => {
    void refresh();
    const onPop = () => setView(pathView());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  function navigate(next: View) {
    history.pushState(null, "", `/${next}`);
    setView(next);
  }
  useEffect(() => {
    if (!showOwner || !ownerCatalog?.run || ownerCatalog.run.outcome) return;
    const timer = window.setInterval(() => {
      void getOwnerCatalogStatus()
        .then((result) => {
          setOwnerCatalog(result);
        })
        .catch(() => setMessage("Catalog status temporarily unavailable."));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [showOwner, ownerCatalog?.run?.outcome]);

  async function beginCatalogRun() {
    setMessage("");
    try {
      setOwnerCatalog(await startCatalogRun());
    } catch {
      setMessage("Unable to start catalog pull. Please retry.");
    }
  }

  async function requestCode(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    const response = await fetch("/auth/request-code", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!response.ok) {
      setMessage("Unable to request a code. Please retry.");
      return;
    }
    setSent(true);
    setMessage("If this account can sign in, a code has been sent.");
  }

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    const response = await fetch("/auth/verify-code", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code }),
    });
    if (!response.ok) {
      setMessage("Invalid or expired code. Request a new code.");
      return;
    }
    history.replaceState(null, "", safeDestination());
    setView(pathView());
    await refresh();
  }

  async function signOut() {
    const response = await fetch("/auth/sign-out", {
      method: "POST",
      credentials: "same-origin",
    });
    if (response.ok) {
      setSession({ signedIn: false, userId: null });
      setOwnerCatalog(null);
      setView("workspace");
      history.replaceState(null, "", "/workspace");
    }
  }

  if (session === null)
    return view === "workspace" ? (
      // The workspace's dark page while the session loads, so /workspace never flashes the light screen.
      <div className="ws-root">
        <main className="ws-main ws-boot">
          <h1>PrizeCheck</h1>
          <p role="status">Loading…</p>
          <p role="alert">{message}</p>
        </main>
      </div>
    ) : (
      <main>
        <h1>PrizeCheck</h1>
        <p>Loading…</p>
        <p role="alert">{message}</p>
      </main>
    );
  if (!session.signedIn && methods === null)
    return (
      <main className="auth">
        <h1>PrizeCheck</h1>
        {!message && <p>Loading…</p>}
        <p role="alert">{message}</p>
      </main>
    );
  const failureMessage =
    failure && methods
      ? signInMessage(
          failure.code,
          methods.providers.find((provider) => provider.id === failure.provider)
            ?.name ?? null
        )
      : null;
  if (!session.signedIn)
    return (
      <main className="auth">
        <h1>PrizeCheck</h1>
        {failureMessage && (
          <div
            className="auth-failure"
            role="alert"
            tabIndex={-1}
            ref={failureRef}
          >
            <p>{failureMessage.text}</p>
            {failureMessage.next && <p>{failureMessage.next}</p>}
          </div>
        )}
        {methods!.providers.length > 0 && (
          <ul className="auth-providers">
            {methods!.providers.map((provider) => (
              <li key={provider.id}>
                <a href={providerStartHref(provider.id)}>
                  Sign in with {provider.name}
                </a>
              </li>
            ))}
          </ul>
        )}
        {methods!.emailSignIn && (
          <>
            <p>Sign in with a code sent to your email.</p>
            <form onSubmit={requestCode}>
              <label>
                Email{" "}
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <button>Send code</button>
            </form>
            {sent && (
              <form onSubmit={verifyCode}>
                <label>
                  Six-digit code{" "}
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
                <button>Sign in</button>
              </form>
            )}
          </>
        )}
        <p role="status">{message}</p>
      </main>
    );
  if (view === "workspace")
    return (
      <Workspace
        userId={session.userId ?? ""}
        onNavigate={navigate}
        ownerControls={ownerCatalog !== null}
        onSignOut={() => void signOut()}
      />
    );
  return (
    <main>
      <header>
        <h1>
          {
            {
              collection: "Collection",
              decks: "Decks",
              catalog: "Catalog",
              reports: "Missing cards",
              owner: "Owner controls",
              "settings/sign-ins": "Sign-ins",
            }[view]
          }
        </h1>
        <button onClick={signOut}>Sign out</button>
      </header>
      <nav aria-label="Main views">
        {(
          ["workspace", "collection", "decks", "catalog", "reports"] as const
        ).map((item) => (
          <button
            key={item}
            aria-current={view === item ? "page" : undefined}
            onClick={() => navigate(item)}
          >
            {
              {
                workspace: "Workspace",
                collection: "Collection",
                decks: "Decks",
                catalog: "Catalog",
                reports: "Missing cards",
              }[item]
            }
          </button>
        ))}
        {ownerCatalog && (
          <button
            aria-current={showOwner ? "page" : undefined}
            onClick={() => navigate("owner")}
          >
            Owner controls
          </button>
        )}
        <button
          aria-current={view === "settings/sign-ins" ? "page" : undefined}
          onClick={() => navigate("settings/sign-ins")}
        >
          Sign-ins
        </button>
      </nav>
      {showOwner && ownerCatalog ? (
        <section aria-label="Catalog pull">
          <h2>English catalog pull</h2>
          <p>
            {ownerCatalog.catalog.available
              ? `Last successful pull: ${new Date(ownerCatalog.catalog.last_success!).toLocaleString()}`
              : "Catalog unavailable until the first complete import."}
          </p>
          <button
            disabled={
              !!ownerCatalog.run &&
              !ownerCatalog.run.outcome &&
              !ownerCatalog.run.heartbeat_stale
            }
            onClick={() => void beginCatalogRun()}
          >
            Start full English pull
          </button>
          <button
            onClick={() =>
              void getOwnerCatalogStatus()
                .then((result) => {
                  setOwnerCatalog(result);
                })
                .catch(() =>
                  setMessage("Catalog status temporarily unavailable.")
                )
            }
          >
            Refresh status
          </button>
          {ownerCatalog.run && (
            <article>
              <h3>Run {ownerCatalog.run.id}</h3>
              <p>Phase: {ownerCatalog.run.phase}</p>
              <p>
                Enumerated: {ownerCatalog.run.enumerated_count} · Fetched:{" "}
                {ownerCatalog.run.fetched_count} · Validated:{" "}
                {ownerCatalog.run.validated_count}
              </p>
              <p>Result: {ownerCatalog.run.outcome ?? "In progress"}</p>
              {ownerCatalog.run.error && (
                <p role="alert">{ownerCatalog.run.error}</p>
              )}
            </article>
          )}
          {ownerCatalog.run?.heartbeat_stale && !ownerCatalog.run.outcome && (
            <p role="status">
              Progress is stale. Start a full pull to check the current runner
              and recover if interrupted.
            </p>
          )}
          <h3>Pending review ({ownerCatalog.pending_reviews.length})</h3>
          {ownerCatalog.pending_reviews.map((item) => (
            <article key={item.id}>
              <strong>{item.kind}</strong> · {item.source_id}
              <p>{item.detail}</p>
            </article>
          ))}
          <OperationsHealth />
          <CatalogReview />
          <MetadataReview />
          <OwnerMissingCardReview />
        </section>
      ) : view === "reports" ? (
        <MissingCardReports />
      ) : view === "catalog" ? (
        <CatalogSearch />
      ) : view === "collection" ? (
        <Collection />
      ) : view === "decks" ? (
        <Decks />
      ) : view === "settings/sign-ins" ? (
        <SignIns />
      ) : null}
      <p role="alert">{message}</p>
    </main>
  );
}

if (location.pathname === "/" || location.pathname === "/locations")
  history.replaceState(
    null,
    "",
    `/workspace${location.search}${location.hash}`
  );

const publishedRoute = /^\/published\/([^/]+)$/.exec(location.pathname);
createRoot(document.getElementById("root")!).render(
  publishedRoute ? (
    <PublishedDeck token={publishedRoute[1]} />
  ) : location.pathname === "/discover" ? (
    <Discovery />
  ) : (
    <App />
  )
);
