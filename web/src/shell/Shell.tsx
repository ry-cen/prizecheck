import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeftRight,
  BookOpen,
  Flag,
  Handshake,
  Layers,
  LayoutGrid,
  LogOut,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { BorrowDraftsProvider } from "../loans/BorrowDrafts";
import { Icon } from "../ui/Icon";
import { Menu, type MenuItem } from "../ui/Menu";
import { ToastProvider, useToast } from "../ui/Toast";
import { FriendsButton, FriendsProvider } from "../social/FriendsDrawer";
import {
  Badge,
  InboxButton,
  InboxProvider,
  loansTabName,
  tradesTabName,
  useInboxTradesWaiting,
  useInboxWaiting,
} from "../inbox/Inbox";
import { AccountSheetProvider, Avatar } from "./AccountSheet";
import { PhoneHeaderActions } from "./HeaderActions";
import {
  ACCOUNT_PAGES,
  DESKTOP_TABS,
  PAGES,
  PHONE_TABS,
  pageDef,
  type PageId,
} from "./routes";

const ICONS: Record<PageId, LucideIcon> = {
  collection: LayoutGrid,
  decks: Layers,
  catalog: BookOpen,
  loans: ArrowLeftRight,
  trades: Handshake,
  reports: Flag,
  settings: Settings,
  owner: ShieldCheck,
};

type Props = {
  /** The page to show. App has already sent addresses that are no page to Collection. */
  page: PageId;
  /** The signed-in email, when the session gave one. */
  email: string | null;
  /** The name from the latest provider sign-in, shown above the email in the avatar menu. */
  name?: string | null;
  /** The provider picture (an https URL on a configured provider's image host, checked by the gateway). */
  image?: string | null;
  owner: boolean;
  /** The signed-in account id: Borrow Request drafts (#252) are kept per account. */
  userId: string;
  onNavigate: (page: PageId) => void;
  /** Opens one Loan (/loans/<id>, #252), from the toast after a Borrow Request is sent and from the inbox (#259). */
  onOpenLoan: (id: string) => void;
  /** Opens one Trade (/trades/<id>), from the inbox (Trading #273). */
  onOpenTrade: (id: string) => void;
  /** Opens a Friend's Collection (#250) from the Friends drawer, by their Handle. */
  onOpenFriend: (handle: string) => void;
  /** Resolves false when sign-out failed; the shell then says so in a toast. */
  onSignOut: () => Promise<boolean>;
  /** The scroll position the page at a path had when it was last left (useRoute). */
  scrollFor: (path: string) => number;
  /** Renders a page; `active` is false while a kept-mounted page is hidden. */
  renderPage: (page: PageId, active: boolean) => ReactNode;
  /** A page that isn't one of the app's pages: Discover or a Published Deck, signed in (#163), or a Friend's
   * Collection (#250). While it is set the shell shows it instead of `page`, with no tab current; kept-mounted pages
   * stay mounted, hidden. `key` changes when it is another such page. */
  other?: { key: string; label: string; content: ReactNode } | null;
};

/**
 * The persistent app shell (#162): desktop header with tabs, the inbox's bell (#259), the Friends button (#247) and the
 * avatar menu, the phone header with the bell, the Friends button and the account avatar (#246), the bottom tab bar
 * (Loans in the old More slot, #252, with the inbox's count of Loans waiting on the collector, and Trades with its count
 * of Trades waiting on them, Trading #273), the Borrow Request
 * drafts tray (#252) and the page area. Switching pages swaps only the page area. A kept-mounted
 * page stays in the document, hidden, after its first visit, and is shown again with its scroll position;
 * other pages mount on each visit. A reload starts fresh.
 */
export function Shell(props: Props) {
  return (
    <ToastProvider>
      <InboxProvider
        onOpenLoan={props.onOpenLoan}
        onOpenTrade={props.onOpenTrade}
      >
        <FriendsProvider
          onPrivacy={() => props.onNavigate("settings")}
          onOpenCollection={props.onOpenFriend}
        >
          <BorrowDraftsProvider
            userId={props.userId}
            onOpenLoan={props.onOpenLoan}
          >
            <ShellFrame {...props} />
          </BorrowDraftsProvider>
        </FriendsProvider>
      </InboxProvider>
    </ToastProvider>
  );
}

function ShellFrame({
  page,
  email,
  name = null,
  image = null,
  owner,
  onNavigate,
  onSignOut,
  scrollFor,
  renderPage,
  other = null,
}: Props) {
  const toast = useToast();
  // Loans waiting on the collector: the Loans tab's badge (#259); Trades waiting on them: the Trades tab's (#273).
  const waiting = useInboxWaiting();
  const tradesWaiting = useInboxTradesWaiting();
  const tabCount = (id: PageId) =>
    id === "loans" ? waiting : id === "trades" ? tradesWaiting : 0;
  const tabName = (id: PageId) =>
    id === "loans"
      ? loansTabName(waiting)
      : id === "trades"
        ? tradesTabName(tradesWaiting)
        : undefined;
  // Pages shown so far; a kept-mounted one stays mounted from its first visit.
  const [visited, setVisited] = useState<ReadonlySet<PageId>>(
    () => new Set(other ? [] : [page])
  );
  if (!other && !visited.has(page)) setVisited(new Set([...visited, page]));
  const shown = useRef(new Set<PageId>());
  const containers = useRef(new Map<PageId, HTMLDivElement>());
  const otherContainer = useRef<HTMLDivElement>(null);
  const current = pageDef(page);
  // The page whose tab is current: none while another page is shown.
  const showing = other ? null : page;
  const otherKey = other?.key ?? null;
  // Sign-ins in the account sheet opens Settings at its Sign-ins section (#246): the section's id, until it is shown.
  const [anchor, setAnchor] = useState<string | null>(null);

  // The shell restores scroll positions itself; the browser's own restoration would fight it.
  useEffect(() => {
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => {
      window.history.scrollRestoration = previous;
    };
  }, []);

  // Before paint: a kept-mounted page shown again returns to where it was; any other page starts at the top.
  useLayoutEffect(() => {
    // Browser Back or Forward can hide a kept-mounted page while one of its dialogs is open. Close them,
    // so no modal stays open (and no scroll lock stays on) over the page now shown, including a public
    // page shown through `other`. Their onClose keeps each owner's state in step.
    containers.current.forEach((container, id) => {
      if (id !== showing)
        container
          .querySelectorAll<HTMLDialogElement>("dialog[open]")
          .forEach((dialog) => dialog.close());
    });
    if (otherKey !== null) {
      window.scrollTo(0, 0);
      return;
    }
    const returning = current.keepMounted && shown.current.has(page);
    shown.current.add(page);
    window.scrollTo(0, returning ? scrollFor(current.path) : 0);
  }, [page, otherKey]);

  // After the page's own scroll reset (the layout effect above), bring the anchored section into view.
  useEffect(() => {
    if (!anchor || showing !== "settings") return;
    const target = document.getElementById(anchor);
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    target
      .querySelector<HTMLElement>("h2[tabindex]")
      ?.focus({ preventScroll: true });
    setAnchor(null);
  }, [anchor, showing]);

  function go(next: PageId) {
    // A page with item addresses (Decks: /decks/<id>) goes back to its own address when its tab is pressed
    // again; App ignores a press that would not change the address.
    if (next !== showing || pageDef(next).param) onNavigate(next);
  }
  async function signOut() {
    if (!(await onSignOut()))
      toast.show({
        message: "Couldn't sign out. Check your connection and try again.",
      });
  }
  // The skip link moves focus to the shown page's heading.
  function skipToContent(event: React.MouseEvent) {
    event.preventDefault();
    const heading = (
      other ? otherContainer.current : containers.current.get(page)
    )?.querySelector("h1");
    if (!heading) return;
    if (!heading.hasAttribute("tabindex"))
      heading.setAttribute("tabindex", "-1");
    heading.focus();
  }

  const allowed = (id: PageId) => id !== "owner" || owner;
  const accountItems: MenuItem[] = [
    ...ACCOUNT_PAGES.filter(allowed).map((id) => ({
      label: pageDef(id).label,
      icon: ICONS[id],
      onSelect: () => go(id),
    })),
    { label: "Sign out", icon: LogOut, onSelect: () => void signOut() },
  ];
  const mounted = PAGES.filter(
    (def) => def.id === showing || (def.keepMounted && visited.has(def.id))
  );

  return (
    <AccountSheetProvider
      email={email}
      name={name}
      image={image}
      owner={owner}
      onSettings={() => go("settings")}
      onSignIns={() => {
        setAnchor("sign-ins");
        go("settings");
      }}
      onOwner={() => go("owner")}
      onReports={() => go("reports")}
      current={showing}
      onSignOut={() => void signOut()}
    >
      <div
        data-app-shell=""
        className="min-h-dvh bg-bg font-sans text-text scheme-dark"
      >
        <a
          href="#main-content"
          onClick={skipToContent}
          className="fixed left-2 top-2 z-(--layer-modal) inline-flex min-h-tap -translate-y-[calc(100%+var(--space-4))] items-center rounded-control border border-control-outline bg-surface-raised px-3 text-body font-semibold text-text no-underline focus:translate-y-0"
        >
          Skip to main content
        </a>

        {/* Desktop header: sticky, so the tabs are in reach wherever the page is scrolled. At compact widths the gaps and
          the tabs' padding tighten so six tabs, two-digit Loans and Trades badges and the header actions fit down to 761 px
          (Trading #269 added Trades, #273 its badge). */}
        <header className="sticky top-0 z-(--layer-sticky) box-border flex h-header items-center gap-6 border-b border-border bg-bg px-7 compact:gap-3 compact:px-5 phone:hidden">
          <Wordmark />
          <nav aria-label="Main views" className="flex items-center gap-1">
            {DESKTOP_TABS.map((id) => (
              <button
                key={id}
                type="button"
                aria-current={showing === id ? "page" : undefined}
                aria-label={tabName(id)}
                onClick={() => go(id)}
                className="inline-flex h-control cursor-pointer items-center gap-2 whitespace-nowrap rounded-control border-0 bg-transparent px-3 text-control font-medium text-text-muted hover:text-text compact:gap-1.5 compact:px-1.5 aria-[current=page]:bg-surface-selected aria-[current=page]:text-accent-strong"
              >
                {pageDef(id).label}
                {tabCount(id) > 0 && (
                  <span
                    aria-hidden="true"
                    className="box-border inline-block h-4.5 min-w-4.5 rounded-round bg-accent px-1 text-center text-micro leading-4.5 font-bold text-on-accent tabular-nums"
                  >
                    {tabCount(id)}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <InboxButton />
            <FriendsButton />
            <Menu
              label="Account"
              triggerClassName="inline-flex size-8 cursor-pointer items-center justify-center rounded-round border border-accent-border bg-accent-fill p-0 text-control font-semibold text-accent-strong"
              trigger={<Avatar email={email} image={image} />}
              header={
                (name || email) && (
                  <div className="m-0 border-b border-border px-3 pb-2 pt-1 text-meta">
                    {name && (
                      <p className="m-0 font-semibold text-text">{name}</p>
                    )}
                    {email && <p className="m-0 text-text-muted">{email}</p>}
                  </div>
                )
              }
              items={accountItems}
            />
          </div>
        </header>

        {/* Phone header for pages that don't draw their own (Collection draws its own: ☰, title, Search,
          Filters & display and the same header actions): the wordmark, then the header actions (the account avatar,
          #246, and the bell, #259). The page's own heading sits right under it and the tab bar marks the section, so a title here would
          only repeat them. */}
        {showing !== "collection" && (
          <header className="box-border hidden h-header items-center gap-3 border-b border-border px-3 phone:flex">
            <Wordmark />
            <div className="ml-auto">
              <PhoneHeaderActions />
            </div>
          </header>
        )}

        {mounted.map((def) => (
          <div
            key={def.id}
            id={def.id === showing ? "main-content" : undefined}
            hidden={def.id !== showing}
            className="phone:pb-tabbar"
            ref={(element) => {
              if (element) containers.current.set(def.id, element);
              else containers.current.delete(def.id);
            }}
          >
            {renderPage(def.id, def.id === showing)}
          </div>
        ))}
        {other && (
          <div
            key={other.key}
            id="main-content"
            className="phone:pb-tabbar"
            ref={otherContainer}
          >
            {other.content}
          </div>
        )}

        {/* Phone bottom tab bar. */}
        <nav
          aria-label="Main views"
          className="fixed inset-x-0 bottom-0 z-(--layer-sticky) hidden h-tabbar border-t border-border bg-surface phone:flex"
        >
          {PHONE_TABS.map((id) => (
            <button
              key={id}
              type="button"
              aria-current={showing === id ? "page" : undefined}
              aria-label={tabName(id)}
              onClick={() => go(id)}
              className={TAB_BAR_BUTTON}
            >
              <span className="relative inline-flex px-2">
                <Icon icon={ICONS[id]} size={20} />
                <Badge count={tabCount(id)} />
              </span>
              {pageDef(id).label}
            </button>
          ))}
        </nav>
      </div>
    </AccountSheetProvider>
  );
}

const TAB_BAR_BUTTON =
  "flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1 border-0 bg-transparent p-0 text-caption font-medium text-text-muted aria-[current=page]:text-accent-strong";

/** The PrizeCheck wordmark, shared with the public header (#163). */
export function Wordmark() {
  return (
    <span className="whitespace-nowrap text-meta font-bold uppercase tracking-[2px]">
      <span aria-hidden="true" className="mr-2 text-accent">
        ✦
      </span>
      PrizeCheck
    </span>
  );
}
