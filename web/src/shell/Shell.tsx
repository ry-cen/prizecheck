import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  BookOpen,
  CircleUser,
  Ellipsis,
  Flag,
  KeyRound,
  Layers,
  LayoutGrid,
  LogOut,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { Menu, type MenuItem } from "../ui/Menu";
import { ToastProvider, useToast } from "../ui/Toast";
import {
  ACCOUNT_PAGES,
  DESKTOP_TABS,
  MORE_PAGES,
  PAGES,
  PHONE_TABS,
  pageDef,
  type PageId,
} from "./routes";

const ICONS: Record<PageId, LucideIcon> = {
  collection: LayoutGrid,
  decks: Layers,
  catalog: BookOpen,
  reports: Flag,
  "sign-ins": KeyRound,
  owner: ShieldCheck,
  "old-collection": LayoutGrid,
};

type Props = {
  /** The page to show. App has already sent addresses that are no page to Collection. */
  page: PageId;
  /** The signed-in email, when the session gave one. */
  email: string | null;
  owner: boolean;
  onNavigate: (page: PageId) => void;
  /** Resolves false when sign-out failed; the shell then says so in a toast. */
  onSignOut: () => Promise<boolean>;
  /** The scroll position the page at a path had when it was last left (useRoute). */
  scrollFor: (path: string) => number;
  /** Renders a page; `active` is false while a kept-mounted page is hidden. */
  renderPage: (page: PageId, active: boolean) => ReactNode;
};

/**
 * The persistent app shell (#162): desktop header with tabs and the avatar menu, the phone header, bottom
 * tab bar and More sheet, and the page area. Switching pages swaps only the page area. A kept-mounted
 * page stays in the document, hidden, after its first visit, and is shown again with its scroll position;
 * other pages mount on each visit. A reload starts fresh.
 */
export function Shell(props: Props) {
  return (
    <ToastProvider>
      <ShellFrame {...props} />
    </ToastProvider>
  );
}

function ShellFrame({
  page,
  email,
  owner,
  onNavigate,
  onSignOut,
  scrollFor,
  renderPage,
}: Props) {
  const toast = useToast();
  const [moreOpen, setMoreOpen] = useState(false);
  // Pages shown so far; a kept-mounted one stays mounted from its first visit.
  const [visited, setVisited] = useState<ReadonlySet<PageId>>(
    () => new Set([page])
  );
  if (!visited.has(page)) setVisited(new Set([...visited, page]));
  const shown = useRef(new Set<PageId>());
  const containers = useRef(new Map<PageId, HTMLDivElement>());
  const moreOpener = useRef<HTMLButtonElement>(null);
  const current = pageDef(page);

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
    const returning = current.keepMounted && shown.current.has(page);
    shown.current.add(page);
    // Browser Back or Forward can hide a kept-mounted page while one of its dialogs is open. Close them,
    // so no modal stays open (and no scroll lock stays on) over the page now shown. Their onClose keeps
    // each owner's state in step.
    containers.current.forEach((container, id) => {
      if (id !== page)
        container
          .querySelectorAll<HTMLDialogElement>("dialog[open]")
          .forEach((dialog) => dialog.close());
    });
    window.scrollTo(0, returning ? scrollFor(current.path) : 0);
  }, [page]);

  function go(next: PageId) {
    setMoreOpen(false);
    if (next !== page) onNavigate(next);
  }
  async function signOut() {
    setMoreOpen(false);
    if (!(await onSignOut()))
      toast.show({
        message: "Couldn't sign out. Check your connection and try again.",
      });
  }
  // The skip link moves focus to the shown page's heading.
  function skipToContent(event: React.MouseEvent) {
    event.preventDefault();
    const heading = containers.current.get(page)?.querySelector("h1");
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
    (def) => def.id === page || (def.keepMounted && visited.has(def.id))
  );

  return (
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

      {/* Desktop header: sticky, so the tabs are in reach wherever the page is scrolled. */}
      <header className="sticky top-0 z-(--layer-sticky) box-border flex h-header items-center gap-6 border-b border-border bg-bg px-7 compact:px-5 phone:hidden">
        <Wordmark />
        <nav aria-label="Main views" className="flex items-center gap-1">
          {DESKTOP_TABS.map((id) => (
            <button
              key={id}
              type="button"
              aria-current={page === id ? "page" : undefined}
              onClick={() => go(id)}
              className="inline-flex h-control cursor-pointer items-center whitespace-nowrap rounded-control border-0 bg-transparent px-3 text-control font-medium text-text-muted hover:text-text aria-[current=page]:bg-surface-selected aria-[current=page]:text-accent-strong"
            >
              {pageDef(id).label}
            </button>
          ))}
        </nav>
        <div className="ml-auto">
          <Menu
            label="Account"
            triggerClassName="inline-flex size-8 cursor-pointer items-center justify-center rounded-round border border-accent-border bg-accent-fill p-0 text-control font-semibold text-accent-strong"
            trigger={
              email ? (
                <span aria-hidden="true">{email[0].toUpperCase()}</span>
              ) : (
                <Icon icon={CircleUser} size={18} />
              )
            }
            header={
              email && (
                <p className="m-0 border-b border-border px-3 pb-2 pt-1 text-meta text-text-muted">
                  {email}
                </p>
              )
            }
            items={accountItems}
          />
        </div>
      </header>

      {/* Phone header for pages that don't draw their own (Collection draws its own: ☰, title, Search and
          Filters & display). Pages without side content show the wordmark instead of ☰. */}
      {page !== "collection" && (
        <header className="box-border hidden h-header items-center gap-3 border-b border-border px-3 phone:flex">
          <Wordmark />
          <span className="min-w-0 truncate text-body font-semibold">
            {current.label}
          </span>
        </header>
      )}

      {mounted.map((def) => (
        <div
          key={def.id}
          id={def.id === page ? "main-content" : undefined}
          hidden={def.id !== page}
          className="phone:pb-tabbar"
          ref={(element) => {
            if (element) containers.current.set(def.id, element);
            else containers.current.delete(def.id);
          }}
        >
          {renderPage(def.id, def.id === page)}
        </div>
      ))}

      {/* Phone bottom tab bar. */}
      <nav
        aria-label="Main views"
        className="fixed inset-x-0 bottom-0 z-(--layer-sticky) hidden h-tabbar border-t border-border bg-surface phone:flex"
      >
        {PHONE_TABS.map((id) => (
          <button
            key={id}
            type="button"
            aria-current={page === id ? "page" : undefined}
            onClick={() => go(id)}
            className={TAB_BAR_BUTTON}
          >
            <Icon icon={ICONS[id]} size={20} />
            {pageDef(id).label}
          </button>
        ))}
        <button
          ref={moreOpener}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          aria-current={MORE_PAGES.includes(page) ? "page" : undefined}
          onClick={() => setMoreOpen(true)}
          className={TAB_BAR_BUTTON}
        >
          <Icon icon={Ellipsis} size={20} />
          More
        </button>
      </nav>

      <Dialog
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        title="More"
        closeLabel="Close More"
        returnFocus={moreOpener}
      >
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {MORE_PAGES.filter(allowed).map((id) => (
            <li key={id}>
              <button
                type="button"
                aria-current={page === id ? "page" : undefined}
                onClick={() => go(id)}
                className={SHEET_BUTTON}
              >
                <Icon icon={ICONS[id]} size={20} />
                {pageDef(id).label}
              </button>
            </li>
          ))}
          <li className="mt-2 border-t border-border pt-2">
            <button
              type="button"
              onClick={() => void signOut()}
              className={SHEET_BUTTON}
            >
              <Icon icon={LogOut} size={20} />
              Sign out
            </button>
          </li>
        </ul>
      </Dialog>
    </div>
  );
}

const TAB_BAR_BUTTON =
  "flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1 border-0 bg-transparent p-0 text-caption font-medium text-text-muted aria-[current=page]:text-accent-strong";
const SHEET_BUTTON =
  "box-border flex min-h-tap w-full cursor-pointer items-center gap-3 rounded-control border-0 bg-transparent px-3 text-left text-body text-text hover:bg-surface-raised aria-[current=page]:bg-surface-selected aria-[current=page]:text-accent-strong";

function Wordmark() {
  return (
    <span className="whitespace-nowrap text-meta font-bold uppercase tracking-[2px]">
      <span aria-hidden="true" className="mr-2 text-accent">
        ✦
      </span>
      PrizeCheck
    </span>
  );
}
