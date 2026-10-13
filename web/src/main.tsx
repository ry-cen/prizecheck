import React, { useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getOwnerCatalogStatus, type OwnerCatalogStatus } from "./generated";
import { Collection } from "./Collection";
import { Decks } from "./Decks";
import { PublishedDeck } from "./PublishedDeck";
import { Discovery } from "./Discovery";
import { CatalogSearch } from "./CatalogSearch";
import { MissingCardReports } from "./MissingCardReports";
import { OwnerControls } from "./OwnerControls";
import { Workspace } from "./workspace/Workspace";
import { LegacyPage } from "./shell/LegacyPage";
import { Shell } from "./shell/Shell";
import { SignInsPage } from "./shell/SignInsPage";
import {
  canonicalPath,
  DEFAULT_PATH,
  pageAt,
  pageDef,
  type PageId,
} from "./shell/routes";
import { useRoute } from "./shell/useRoute";
import "./style.css";
import "./tokens.css";
import "./tailwind.css";

type Session = {
  signedIn: boolean;
  userId: string | null;
  /** The signed-in email (#162); absent from older or test sessions. */
  email?: string | null;
};

/** Where signing in lands: a same-origin `next`, else the signed-in page being visited, else Collection. */
function safeDestination(): string {
  const value = new URLSearchParams(location.search).get("next");
  if (!value)
    return pageAt(canonicalPath(location.pathname))
      ? `${canonicalPath(location.pathname)}${location.search}${location.hash}`
      : DEFAULT_PATH;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    return DEFAULT_PATH;
  const url = new URL(value, location.origin);
  return url.origin === location.origin
    ? `${canonicalPath(url.pathname)}${url.search}${url.hash}`
    : DEFAULT_PATH;
}

function App() {
  const { path, navigate, scrollFor } = useRoute();
  const [session, setSession] = useState<Session | null>(null);
  const [ownerCatalog, setOwnerCatalog] = useState<OwnerCatalogStatus | null>(
    null
  );
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState("");

  // The session and whether this user is the owner arrive together, so the shell never shows an owner-only
  // page or menu item before it knows.
  async function refresh() {
    try {
      const response = await fetch("/auth/session", {
        credentials: "same-origin",
      });
      const result = (await response.json()) as Session;
      let owner: OwnerCatalogStatus | null = null;
      if (result.signedIn) {
        try {
          owner = await getOwnerCatalogStatus();
        } catch {
          setMessage("Service temporarily unavailable. Please retry.");
        }
      }
      setOwnerCatalog(owner);
      setSession(result);
    } catch {
      setMessage("Service temporarily unavailable. Please retry.");
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  // Signed in, an address that is no page lands on Collection. Owner controls opened by someone else shows
  // its heading and nothing else, as before.
  const signedIn = session?.signedIn === true;
  const def = pageAt(path);
  const page: PageId = def ? def.id : "collection";
  useLayoutEffect(() => {
    if (signedIn && path !== pageDef(page).path)
      navigate(pageDef(page).path, { replace: true });
  }, [signedIn, page, path, navigate]);

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
    navigate(safeDestination(), { replace: true });
    await refresh();
  }

  async function signOut(): Promise<boolean> {
    try {
      const response = await fetch("/auth/sign-out", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) return false;
    } catch {
      return false;
    }
    setSession({ signedIn: false, userId: null });
    setOwnerCatalog(null);
    navigate(DEFAULT_PATH, { replace: true });
    return true;
  }

  if (session === null)
    return (
      <div className="legacy">
        {!def || def.id === "collection" ? (
          // Collection's dark page while the session loads, so /collection never flashes the light screen.
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
        )}
      </div>
    );
  if (!session.signedIn)
    return (
      <div className="legacy">
        <main className="auth">
          <h1>PrizeCheck</h1>
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
          <p role="status">{message}</p>
        </main>
      </div>
    );

  const userId = session.userId ?? "";
  const accountEmail = session.email ?? null;
  function renderPage(id: PageId, active: boolean) {
    switch (id) {
      case "collection":
        return (
          <div className="legacy">
            <Workspace userId={userId} active={active} />
          </div>
        );
      case "decks":
        return (
          <LegacyPage title="Decks" message={message}>
            <Decks />
          </LegacyPage>
        );
      case "catalog":
        return (
          <LegacyPage title="Catalog" message={message}>
            <CatalogSearch />
          </LegacyPage>
        );
      case "reports":
        return (
          <LegacyPage title="Missing cards" message={message}>
            <MissingCardReports />
          </LegacyPage>
        );
      case "owner":
        return (
          <LegacyPage title="Owner controls" message={message}>
            {ownerCatalog && (
              <OwnerControls
                status={ownerCatalog}
                onStatus={setOwnerCatalog}
                onMessage={setMessage}
              />
            )}
          </LegacyPage>
        );
      case "old-collection":
        return (
          <LegacyPage title="Old Collection" message={message}>
            <Collection />
          </LegacyPage>
        );
      case "sign-ins":
        return <SignInsPage email={accountEmail} />;
    }
  }
  return (
    <Shell
      page={page}
      email={accountEmail}
      owner={ownerCatalog !== null}
      onNavigate={(next) => navigate(pageDef(next).path)}
      onSignOut={signOut}
      scrollFor={scrollFor}
      renderPage={renderPage}
    />
  );
}

// Old addresses for Collection (/, /workspace, /locations) are rewritten before anything renders, keeping
// the query, so /workspace?location=<id> still opens that Location.
if (canonicalPath(location.pathname) !== location.pathname)
  history.replaceState(
    null,
    "",
    `${canonicalPath(location.pathname)}${location.search}${location.hash}`
  );

const publishedRoute = /^\/published\/([^/]+)$/.exec(location.pathname);
createRoot(document.getElementById("root")!).render(
  publishedRoute ? (
    <div className="legacy">
      <PublishedDeck token={publishedRoute[1]} />
    </div>
  ) : location.pathname === "/discover" ? (
    <div className="legacy">
      <Discovery />
    </div>
  ) : (
    <App />
  )
);
