import React, { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { getOwnerCatalogStatus, type OwnerCatalogStatus } from "./generated";
import { Decks } from "./Decks";
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
import { DeadEnd } from "./public/DeadEnd";
import { LoadingScreen } from "./public/LoadingScreen";
import { PublicLayout } from "./public/PublicLayout";
import { PublicPageView } from "./public/PublicPageView";
import {
  publicPageAt,
  publicPageLabel,
  SIGN_IN_PATH,
} from "./public/publicRoutes";
import { EmailCodeForms, SignInCard } from "./public/SignIn";
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

  // Signed in, an address that is no page lands on Collection, except the public pages (Discover, a Published
  // Deck), which open inside the shell (#163). Owner controls opened by someone else shows its heading and
  // nothing else, as before.
  const signedIn = session?.signedIn === true;
  const publicPage = useMemo(() => publicPageAt(path), [path]);
  const isPublic = publicPage !== null;
  const def = pageAt(path);
  const page: PageId = def ? def.id : "collection";
  useLayoutEffect(() => {
    if (signedIn && !isPublic && path !== pageDef(page).path)
      navigate(pageDef(page).path, { replace: true });
  }, [signedIn, isPublic, page, path, navigate]);

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

  // The signed-out screens (#163). A public page whose session read failed is shown signed out: it never
  // needed the session before #163.
  const go = (to: string) => navigate(to);
  if (session === null && !(isPublic && message))
    return <LoadingScreen message={message} />;
  if (!signedIn) {
    if (publicPage)
      return (
        <PublicLayout
          current={publicPage.kind === "discover" ? "discover" : undefined}
          onNavigate={go}
        >
          <PublicPageView page={publicPage} signedIn={false} onNavigate={go} />
        </PublicLayout>
      );
    if (!def && path !== SIGN_IN_PATH)
      return (
        <PublicLayout onNavigate={go}>
          <DeadEnd kind="not-found" signedIn={false} onNavigate={go} />
        </PublicLayout>
      );
    // At /sign-in, or in place of the protected page asked for, which signing in then opens.
    return (
      <PublicLayout current="sign-in" onNavigate={go}>
        <SignInCard
          continuing={safeDestination() !== DEFAULT_PATH}
          status={message}
        >
          <EmailCodeForms
            email={email}
            code={code}
            sent={sent}
            onEmail={setEmail}
            onCode={setCode}
            onRequestCode={requestCode}
            onVerifyCode={verifyCode}
          />
        </SignInCard>
      </PublicLayout>
    );
  }

  const userId = session?.userId ?? "";
  const accountEmail = session?.email ?? null;
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
      other={
        publicPage && {
          key: path,
          label: publicPageLabel(publicPage),
          content: (
            <PublicPageView page={publicPage} signedIn onNavigate={go} />
          ),
        }
      }
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

createRoot(document.getElementById("root")!).render(<App />);
