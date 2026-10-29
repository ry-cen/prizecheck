import React, { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { getOwnerCatalogStatus, type OwnerCatalogStatus } from "./generated";
import { replacedDeckAt, replacePath } from "./decks/import/replaceList";
import { WANT_LIST_SEGMENT } from "./decks/wantListModel";
import { ownerSection, ownerSectionPath } from "./owner/sections";
import { SettingsPage } from "./settings/SettingsPage";
import {
  CatalogPage,
  CollectionImportPage,
  DeckBuilderPage,
  DecksPage,
  FriendTradeListPage,
  ImportPage,
  LoansPage,
  MissingCardsPage,
  OwnerControlsPage,
  preloadInitialPage,
  ReplaceListPage,
  TradesPage,
  Workspace,
} from "./shell/lazyPages";
import { PageFrame } from "./shell/PageFrame";
import { Shell } from "./shell/Shell";
import { DocumentScrollbar } from "./ui/ScrollArea";
import {
  canonicalPath,
  DEFAULT_PATH,
  pageAt,
  pageDef,
  sectionAt,
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
import { EmailCodeForms, SignInScreen } from "./public/SignIn";
import { clearFailureFromAddress, failureInAddress } from "./signInMessages";
import { COLLECTION_IMPORT_PATH } from "./collectionImport/route";
import { forgetBorrowDrafts } from "./loans/BorrowDrafts";
import { OpenProposalProvider } from "./trades/openProposal";
import { loanPath } from "./loans/loanText";
import { FriendCollectionPage } from "./social/FriendCollectionPage";
import { friendCollectionPath, friendHandleAt } from "./social/friendCards";
import { friendTradeListHandleAt, tradePath } from "./trades/tradeListModel";
import { workspaceHref } from "./workspace/workspaceLink";
import "./tokens.css";
import "./tailwind.css";

type Session = {
  signedIn: boolean;
  userId: string | null;
  /** The signed-in email (#162); absent from older or test sessions. */
  email?: string | null;
  /** The name and picture from the latest provider sign-in (OAuth spec), for the avatar menu. */
  name?: string | null;
  image?: string | null;
};

/** The provider picture, only as an https URL. The gateway checks its host too (auth/src/sessionView.ts); this
 * second check keeps anything else out of the avatar's <img>, as dev's ProfileBadge did. */
function avatarImage(image: unknown): string | null {
  return typeof image === "string" && image.startsWith("https://")
    ? image
    : null;
}

/** Where signing in lands: a same-origin `next`, else the signed-in page being visited (a Friend's Collection or
 * Trade List included), else Collection. */
function safeDestination(): string {
  const value = new URLSearchParams(location.search).get("next");
  if (!value)
    return pageAt(canonicalPath(location.pathname)) ||
      friendHandleAt(location.pathname) !== null ||
      friendTradeListHandleAt(location.pathname) !== null
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

  // Signed in, an address that is no page (or section of one) lands on Collection, except the public pages
  // (Discover, a Published Deck), which open inside the shell (#163), and a Friend's Collection (#250), which does
  // too. Owner controls opened by someone else shows its heading and nothing else, as before.
  const signedIn = session?.signedIn === true;
  const publicPage = useMemo(() => publicPageAt(path), [path]);
  const isPublic = publicPage !== null;
  const friendHandle = friendHandleAt(path);
  const friendTradeHandle = friendTradeListHandleAt(path);
  const def = pageAt(path);
  const page: PageId = def ? def.id : "collection";
  useLayoutEffect(() => {
    if (
      signedIn &&
      !isPublic &&
      !def &&
      friendHandle === null &&
      friendTradeHandle === null
    )
      navigate(pageDef(page).path, { replace: true });
  }, [
    signedIn,
    isPublic,
    def,
    friendHandle,
    friendTradeHandle,
    page,
    navigate,
  ]);
  // A failure code in the address belongs to the sign-in page: signed in, it is never shown, only removed. The
  // Settings page's Sign-ins section reads and removes its own.
  useEffect(() => {
    if (signedIn && page !== "settings" && failureInAddress())
      clearFailureFromAddress();
  }, [signedIn, page]);

  async function requestCode(event?: React.FormEvent, again = false) {
    event?.preventDefault();
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
    setMessage(
      again
        ? `We sent a new six-digit code to ${email}.`
        : `We sent a six-digit code to ${email}.`
    );
  }

  /** Back to the email step with the code cleared. */
  function useDifferentEmail() {
    setSent(false);
    setCode("");
    setMessage("");
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
    // Borrow Request drafts (#252) are the account's: none stay in this tab for whoever signs in next.
    forgetBorrowDrafts();
    setSession({ signedIn: false, userId: null });
    setOwnerCatalog(null);
    // An unsent proposal is lost with the session: sign-out never asks.
    navigate(DEFAULT_PATH, { replace: true, force: true });
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
          <PageFrame resetKey={path}>
            <PublicPageView
              page={publicPage}
              signedIn={false}
              onNavigate={go}
            />
          </PageFrame>
        </PublicLayout>
      );
    if (
      !def &&
      friendHandle === null &&
      friendTradeHandle === null &&
      path !== SIGN_IN_PATH
    )
      return (
        <PublicLayout onNavigate={go}>
          <DeadEnd kind="not-found" signedIn={false} onNavigate={go} />
        </PublicLayout>
      );
    // At /sign-in, or in place of the protected page asked for, which signing in then opens.
    return (
      <PublicLayout current="sign-in" onNavigate={go}>
        <SignInScreen
          continuing={safeDestination() !== DEFAULT_PATH}
          status={message}
          onNavigate={go}
          emailForms={
            <EmailCodeForms
              email={email}
              code={code}
              sent={sent}
              onEmail={setEmail}
              onCode={setCode}
              onRequestCode={requestCode}
              onVerifyCode={verifyCode}
              onUseDifferentEmail={useDifferentEmail}
              onResend={() => void requestCode(undefined, true)}
            />
          }
        />
      </PublicLayout>
    );
  }

  const userId = session?.userId ?? "";
  const accountEmail = session?.email ?? null;
  function renderPage(id: PageId, active: boolean) {
    return (
      <PageFrame resetKey={active ? path : id}>
        {pageContent(id, active)}
      </PageFrame>
    );
  }
  function pageContent(id: PageId, active: boolean) {
    switch (id) {
      case "collection":
        // Collection Import (#226) shows in Collection's place; saving lands on its Storage Leaf in a new Workspace.
        if (path === COLLECTION_IMPORT_PATH)
          return (
            <CollectionImportPage
              onCancel={() => navigate(pageDef("collection").path)}
              onLanded={(id) => navigate(workspaceHref(id), { replace: true })}
            />
          );
        return (
          <Workspace
            userId={userId}
            active={active}
            onImport={() => navigate(COLLECTION_IMPORT_PATH)}
            onOpenDeck={(id) =>
              navigate(`${pageDef("decks").path}/${encodeURIComponent(id)}`)
            }
            onOpenLoan={(id) => navigate(loanPath(id))}
          />
        );
      case "decks": {
        // /decks is the index (My Decks) and /decks/want-list the Want List (#209), one page with a switch between
        // them; /decks/import imports a list (#212); /decks/<id> opens that Deck in the deck builder (#176), and
        // /decks/<id>/replace its Replace list… (#215).
        const deckId = sectionAt(path);
        if (deckId === "import")
          return (
            <ImportPage
              onOpenDeck={(id) =>
                navigate(`${pageDef("decks").path}/${encodeURIComponent(id)}`)
              }
              onAllDecks={() => navigate(pageDef("decks").path)}
            />
          );
        const replacing = replacedDeckAt(deckId);
        if (replacing)
          return (
            <ReplaceListPage
              key={replacing}
              deckId={replacing}
              onOpenDeck={(id) =>
                navigate(`${pageDef("decks").path}/${encodeURIComponent(id)}`)
              }
              onAllDecks={() => navigate(pageDef("decks").path)}
            />
          );
        return deckId && deckId !== WANT_LIST_SEGMENT ? (
          <DeckBuilderPage
            key={deckId}
            deckId={deckId}
            onAllDecks={() => navigate(pageDef("decks").path)}
            onReplaceList={() => navigate(replacePath(deckId))}
          />
        ) : (
          <DecksPage
            view={deckId === WANT_LIST_SEGMENT ? "want-list" : "decks"}
            onOpenDeck={(id) =>
              navigate(`${pageDef("decks").path}/${encodeURIComponent(id)}`)
            }
            onNavigate={navigate}
            message={message}
          />
        );
      }
      case "catalog":
        return <CatalogPage active={active} message={message} />;
      case "loans":
        // /loans lists the Loans; /loans/<id> is one Loan (#252).
        return (
          <LoansPage
            loanId={sectionAt(path)}
            onOpenLoan={(id) => navigate(loanPath(id))}
            onAllLoans={() => navigate(pageDef("loans").path)}
          />
        );
      case "trades":
        // /trades is the Trades list, /trades/list My Trade List (Trading #269), /trades/new/<Handle> the proposal
        // builder for that Friend (#284) and /trades/<id> one Trade (#270).
        return <TradesPage section={sectionAt(path)} onNavigate={navigate} />;
      case "reports":
        return <MissingCardsPage active={active} message={message} />;
      case "owner":
        return (
          <OwnerControlsPage
            status={ownerCatalog}
            section={ownerSection(sectionAt(path))}
            onSection={(next) => navigate(ownerSectionPath(next))}
            onStatus={setOwnerCatalog}
            message={message}
            onMessage={setMessage}
          />
        );
      case "settings":
        return <SettingsPage email={accountEmail} />;
    }
  }
  return (
    <OpenProposalProvider onNavigate={go}>
      <Shell
        page={page}
        email={accountEmail}
        name={session?.name ?? null}
        image={avatarImage(session?.image)}
        owner={ownerCatalog !== null}
        userId={userId}
        onOpenLoan={(id) => {
          if (loanPath(id) !== path) navigate(loanPath(id));
        }}
        onOpenTrade={(id) => {
          if (tradePath(id) !== path) navigate(tradePath(id));
        }}
        onNavigate={(next) => {
          if (pageDef(next).path !== path) navigate(pageDef(next).path);
        }}
        onOpenFriend={(handle) => {
          if (friendCollectionPath(handle) !== path)
            navigate(friendCollectionPath(handle));
        }}
        onSignOut={signOut}
        scrollFor={scrollFor}
        renderPage={renderPage}
        other={
          publicPage
            ? {
                key: path,
                label: publicPageLabel(publicPage),
                content: (
                  <PageFrame resetKey={path}>
                    <PublicPageView
                      page={publicPage}
                      signedIn
                      onNavigate={go}
                    />
                  </PageFrame>
                ),
              }
            : friendHandle !== null
              ? {
                  key: path,
                  label: "Friend's Collection",
                  content: (
                    <PageFrame resetKey={path}>
                      <FriendCollectionPage
                        key={friendHandle}
                        handle={friendHandle}
                        onNavigate={go}
                      />
                    </PageFrame>
                  ),
                }
              : friendTradeHandle !== null
                ? {
                    key: path,
                    label: "Friend's Trade List",
                    content: (
                      <PageFrame resetKey={path}>
                        <FriendTradeListPage
                          key={friendTradeHandle}
                          handle={friendTradeHandle}
                          onNavigate={go}
                        />
                      </PageFrame>
                    ),
                  }
                : null
        }
      />
    </OpenProposalProvider>
  );
}

// Old addresses (/, /workspace and /locations for Collection, /settings/sign-ins for Settings) are rewritten before
// anything renders, keeping the query, so /workspace?location=<id> still opens that Location and a sign-in link
// failure returned to /settings/sign-ins still reaches the Sign-ins section.
if (canonicalPath(location.pathname) !== location.pathname)
  history.replaceState(
    null,
    "",
    `${canonicalPath(location.pathname)}${location.search}${location.hash}`
  );

// Starts the first page's code alongside the session read.
preloadInitialPage(location.pathname);

createRoot(document.getElementById("root")!).render(
  <>
    <App />
    <DocumentScrollbar />
  </>
);
