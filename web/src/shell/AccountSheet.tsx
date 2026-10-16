import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  CircleUser,
  Flag,
  KeyRound,
  LogOut,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";

/**
 * The phone account sheet (social network #246, spec "Web screens"): the avatar button in the phone header opens a
 * sheet with Settings, Sign-ins, Missing cards, Owner controls (the owner only) and Sign out: the account items the
 * desktop avatar menu has, and Missing cards, whose desktop tab has no phone tab since Loans took the More slot (#252).
 * The shell provides it; the phone headers (the shell's and Collection's own) draw the button through
 * PhoneHeaderActions.
 */
type AccountSheetApi = {
  open: (opener: RefObject<HTMLElement | null>) => void;
  isOpen: boolean;
  email: string | null;
  image: string | null;
};

const AccountSheetContext = createContext<AccountSheetApi | null>(null);

type ProviderProps = {
  email: string | null;
  /** The name from the latest provider sign-in, shown above the email, as in the desktop menu. */
  name: string | null;
  image: string | null;
  owner: boolean;
  onSettings: () => void;
  onSignIns: () => void;
  onOwner: () => void;
  /** Opens Missing cards (/reports). */
  onReports: () => void;
  /** The page shown, so the sheet marks Settings, Missing cards or Owner controls when it is one of them. */
  current: string | null;
  onSignOut: () => void;
  children: ReactNode;
};

export function AccountSheetProvider({
  email,
  name,
  image,
  owner,
  onSettings,
  onSignIns,
  onOwner,
  onReports,
  current,
  onSignOut,
  children,
}: ProviderProps) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const items: {
    label: string;
    icon: typeof Settings;
    onSelect: () => void;
    current?: boolean;
  }[] = [
    {
      label: "Settings",
      icon: Settings,
      onSelect: choose(onSettings),
      current: current === "settings",
    },
    { label: "Sign-ins", icon: KeyRound, onSelect: choose(onSignIns) },
    {
      label: "Missing cards",
      icon: Flag,
      onSelect: choose(onReports),
      current: current === "reports",
    },
    ...(owner
      ? [
          {
            label: "Owner controls",
            icon: ShieldCheck,
            onSelect: choose(onOwner),
            current: current === "owner",
          },
        ]
      : []),
  ];
  return (
    <AccountSheetContext.Provider
      value={{
        open: (from) => {
          opener.current = from.current;
          setOpen(true);
        },
        isOpen: open,
        email,
        image,
      }}
    >
      {children}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Account"
        closeLabel="Close account"
        returnFocus={opener}
      >
        {/* Drawn only while open: the desktop avatar menu shows the same name and email. */}
        {open && (name || email) && (
          <div className="mb-2 border-b border-border pb-2 text-meta">
            {name && <p className="m-0 font-semibold text-text">{name}</p>}
            {email && <p className="m-0 text-text-muted">{email}</p>}
          </div>
        )}
        {open && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {items.map((item) => (
              <li key={item.label}>
                <button
                  type="button"
                  aria-current={item.current ? "page" : undefined}
                  onClick={item.onSelect}
                  className={SHEET_BUTTON}
                >
                  <Icon icon={item.icon} size={20} />
                  {item.label}
                </button>
              </li>
            ))}
            <li className="mt-2 border-t border-border pt-2">
              <button
                type="button"
                onClick={choose(onSignOut)}
                className={SHEET_BUTTON}
              >
                <Icon icon={LogOut} size={20} />
                Sign out
              </button>
            </li>
          </ul>
        )}
      </Dialog>
    </AccountSheetContext.Provider>
  );
}

/** The phone header's avatar button, which opens the account sheet. Nothing outside the shell, or on desktop. */
export function PhoneAccountButton() {
  const sheet = useContext(AccountSheetContext);
  const ref = useRef<HTMLButtonElement>(null);
  if (!sheet) return null;
  return (
    <button
      ref={ref}
      type="button"
      aria-label="Account"
      aria-haspopup="dialog"
      aria-expanded={sheet.isOpen}
      onClick={() => sheet.open(ref)}
      className="hidden size-tap shrink-0 cursor-pointer items-center justify-center rounded-round border-0 bg-transparent p-0 phone:inline-flex"
    >
      <span className="inline-flex size-8 items-center justify-center overflow-hidden rounded-round border border-accent-border bg-accent-fill text-control font-semibold text-accent-strong">
        <Avatar email={sheet.email} image={sheet.image} />
      </span>
    </button>
  );
}

export const SHEET_BUTTON =
  "box-border flex min-h-tap w-full cursor-pointer items-center gap-3 rounded-control border-0 bg-transparent px-3 text-left text-body text-text hover:bg-surface-raised aria-[current=page]:bg-surface-selected aria-[current=page]:text-accent-strong";

/**
 * The avatar (OAuth spec): the provider picture, loaded with no referrer, or the first letter of the email when
 * there is none or it fails to load.
 */
export function Avatar({
  email,
  image,
}: {
  email: string | null;
  image: string | null;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (image && failed !== image)
    return (
      <img
        src={image}
        alt=""
        width={32}
        height={32}
        referrerPolicy="no-referrer"
        onError={() => setFailed(image)}
        data-testid="profile-picture"
        className="size-full rounded-round object-cover"
      />
    );
  if (email)
    return (
      <span aria-hidden="true" data-testid="profile-initial">
        {email.trim().charAt(0).toUpperCase() || "?"}
      </span>
    );
  return <Icon icon={CircleUser} size={18} />;
}
