import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type Ref,
} from "react";
import { canonicalPath, pageAt } from "../shell/routes";
import {
  clearFailureFromAddress,
  failureInAddress,
  signInMessage,
  withoutFailure,
  type SignInMessage,
} from "../signInMessages";
import {
  CARD,
  CENTRED_MAIN,
  FIELD,
  FIELD_LABEL,
  PRIMARY,
  SECONDARY,
} from "./controls";
import { DISCOVER_PATH, followLink } from "./publicRoutes";

type CardProps = {
  /** Signing in returns to a page the collector asked for (a protected page, or a `next`), not the default. */
  continuing: boolean;
  /** The ways to sign in: the failure message, the provider buttons and the email form when it is on. */
  children: ReactNode;
  /** The sign-in service message (code sent, invalid code), in the card's one status region. */
  status: string;
};

/**
 * The sign-in card (spec "The sign-in card"), centred under the public header: 400 px on desktop and the full
 * width on a phone. The heading and subtitle, the ways to sign in, the status line and the terms line.
 */
export function SignInCard({ continuing, children, status }: CardProps) {
  return (
    <main className={CENTRED_MAIN}>
      <section aria-labelledby="sign-in-heading" className={CARD}>
        <div className="flex flex-col gap-1">
          <h1 id="sign-in-heading" className="m-0 text-display font-semibold">
            Sign in to PrizeCheck
          </h1>
          <p className="m-0 text-body text-text-muted">
            {continuing
              ? "Sign in to continue where you left off."
              : "Know every card you own, and where it is."}
          </p>
        </div>
        {children}
        <p role="status" className="m-0 text-meta text-text-muted">
          {status}
        </p>
        {/* Plain text until the terms and privacy pages exist (spec "Further Notes"). */}
        <p className="m-0 text-caption text-text-subtle">
          By continuing you agree to PrizeCheck's terms and privacy notice.
        </p>
      </section>
    </main>
  );
}

/** GET /auth/methods: the configured providers and whether email-code sign-in is on. */
export type SignInMethods = {
  providers: { id: string; name: string }[];
  emailSignIn: boolean;
};

/** How often GET /auth/methods is retried after a failed read: three more attempts, 1 s, 2 s and 4 s apart. */
const METHODS_RETRY_MS = [1000, 2000, 4000];

/**
 * Reads GET /auth/methods once, retrying a failed read three times. `unavailable` is true while the last read
 * failed and none has succeeded yet.
 */
export function useSignInMethods(): {
  methods: SignInMethods | null;
  unavailable: boolean;
} {
  const [methods, setMethods] = useState<SignInMethods | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (let attempt = 0; ; attempt++) {
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
          if (cancelled) return;
          setUnavailable(false);
          setMethods(body as SignInMethods);
          return;
        } catch {
          if (cancelled) return;
          setUnavailable(true);
          if (attempt >= METHODS_RETRY_MS.length) return;
          await new Promise((resolve) =>
            setTimeout(resolve, METHODS_RETRY_MS[attempt])
          );
          if (cancelled) return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return { methods, unavailable };
}

/**
 * The `next` a provider button carries: the `next` asked for, else the signed-in page being visited. None at
 * /sign-in or any other address that is no page. Either way without a sign-in failure's parameters, so a failure
 * isn't replayed after signing in. The gateway checks it (auth/src/nextPath.ts).
 */
export function providerNext(): string | null {
  const asked = new URLSearchParams(location.search).get("next");
  if (asked) return withoutFailure(asked);
  const path = canonicalPath(location.pathname);
  return pageAt(path)
    ? withoutFailure(`${path}${location.search}${location.hash}`)
    : null;
}

/** The start link for a provider, with `next` when there is one. */
export function providerStartHref(provider: string, next: string | null) {
  return `/auth/sign-in/${encodeURIComponent(provider)}${next ? `?next=${encodeURIComponent(next)}` : ""}`;
}

const PROVIDER_BUTTON =
  "box-border m-0 flex h-10 w-full cursor-pointer items-center justify-center gap-2.5 rounded-control border px-4 font-sans text-body font-medium leading-none no-underline phone:h-11";

/** Each company's own button look (sign-in decision). A provider with no entry gets the generic kit button. */
const PROVIDER_LOOK: Record<string, { button: string; mark: string }> = {
  google: {
    button: "border-google-stroke bg-google text-on-google",
    mark: "bg-on-google text-google",
  },
  discord: {
    button: "border-discord bg-discord text-on-discord",
    mark: "bg-on-discord text-discord",
  },
};
const GENERIC_LOOK = {
  button:
    "border-border-strong bg-surface-raised text-text hover:border-control-outline",
  mark: "bg-surface-selected text-accent-strong",
};

/**
 * A provider's button: a plain link to its start route, stacked full width, 40 px tall on desktop and 44 px on a
 * phone. Its mark is the provider's initial until the companies' downloaded assets ship.
 */
export function ProviderButton({
  provider,
  next,
}: {
  provider: { id: string; name: string };
  next: string | null;
}) {
  const look = PROVIDER_LOOK[provider.id] ?? GENERIC_LOOK;
  return (
    <a
      href={providerStartHref(provider.id, next)}
      className={`${PROVIDER_BUTTON} ${look.button}`}
    >
      <ProviderMark name={provider.name} className={look.mark} />
      Continue with {provider.name}
    </a>
  );
}

/** A provider's mark: a round badge with its initial. */
export function ProviderMark({
  name,
  className = GENERIC_LOOK.mark,
}: {
  name: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-grid size-5 shrink-0 place-items-center rounded-round text-caption font-bold ${className}`}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

const ALERT =
  "flex flex-col gap-1 rounded-control border px-3 py-2.5 text-body text-text outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/**
 * A sign-in failure (spec "Failure messages"): a bold title and a follow-up line, then the message's own next
 * step. "Not open yet" is calm news in the gold accent; every other message uses the danger colours. The caller
 * focuses it once.
 */
export function SignInAlert({
  message,
  action,
  ref,
}: {
  message: SignInMessage;
  /** The next step, when the message has one beyond the buttons below it. */
  action?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}) {
  const calm = message.group === "not-open";
  return (
    <div
      role="alert"
      tabIndex={-1}
      ref={ref}
      className={`${ALERT} ${calm ? "border-accent-border bg-accent-wash" : "border-danger-border bg-danger-fill"}`}
    >
      <p className="m-0 font-semibold">{message.title}</p>
      <p className="m-0">{message.detail}</p>
      {action}
    </div>
  );
}

type ScreenProps = {
  continuing: boolean;
  status: string;
  /** The email-code forms, shown only when email sign-in is on. */
  emailForms: ReactNode;
  onNavigate: (to: string) => void;
};

/**
 * The sign-in card with OAuth sign-in (#150, #151): the failure message the gateway sent back, shown and focused
 * once and then removed from the address bar; one button per configured provider; and the email form below an
 * "or" divider when email sign-in is on.
 */
export function SignInScreen({
  continuing,
  status,
  emailForms,
  onNavigate,
}: ScreenProps) {
  const { methods, unavailable } = useSignInMethods();
  // A failed sign-in lands with ?error=<code>: read once on arrival, shown once, then removed from the address.
  const [failure] = useState(failureInAddress);
  const failureRef = useRef<HTMLDivElement>(null);
  const failureShown = useRef(false);
  useEffect(() => {
    if (!failure || failureShown.current || methods === null) return;
    failureShown.current = true;
    failureRef.current?.focus();
    clearFailureFromAddress();
  }, [failure, methods]);

  const message =
    failure && methods
      ? signInMessage(
          failure.code,
          methods.providers.find((provider) => provider.id === failure.provider)
            ?.name ?? null
        )
      : null;
  const next = providerNext();
  return (
    <SignInCard continuing={continuing} status={status}>
      {unavailable && !methods && (
        <p role="alert" className="m-0 text-body text-danger">
          Sign-in is temporarily unavailable. Please retry.
        </p>
      )}
      {message && (
        <SignInAlert
          message={message}
          ref={failureRef}
          action={
            message.group === "not-open" && (
              <a
                href={DISCOVER_PATH}
                onClick={followLink(onNavigate)}
                className={`${SECONDARY} mt-1 self-start`}
              >
                Browse public decks
              </a>
            )
          }
        />
      )}
      {methods && methods.providers.length > 0 && (
        <ul
          aria-label="Ways to sign in"
          className="m-0 flex list-none flex-col gap-2 p-0"
        >
          {methods.providers.map((provider) => (
            <li key={provider.id}>
              <ProviderButton provider={provider} next={next} />
            </li>
          ))}
        </ul>
      )}
      {methods?.emailSignIn && (
        <>
          {methods.providers.length > 0 && (
            <div
              aria-hidden="true"
              className="flex items-center gap-3 text-meta text-text-subtle"
            >
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
          )}
          {emailForms}
        </>
      )}
    </SignInCard>
  );
}

type EmailCodeProps = {
  email: string;
  code: string;
  /** A code was requested, so the code step shows in place of the email step. */
  sent: boolean;
  onEmail: (email: string) => void;
  onCode: (code: string) => void;
  onRequestCode: (event: FormEvent) => void;
  onVerifyCode: (event: FormEvent) => void;
  /** Back to the email step with the code cleared. */
  onUseDifferentEmail: () => void;
  /** Request a new code to the same email. */
  onResend: () => void;
};

/** Email-code sign-in, when it is on: two steps. Step 1 asks for the email and sends a code; once a code is sent,
 * step 2 replaces it with the six-digit code field and Sign in, and two secondary actions under the field. */
export function EmailCodeForms({
  email,
  code,
  sent,
  onEmail,
  onCode,
  onRequestCode,
  onVerifyCode,
  onUseDifferentEmail,
  onResend,
}: EmailCodeProps) {
  const emailRef = useRef<HTMLInputElement>(null);
  const refocusEmail = useRef(false);
  useEffect(() => {
    if (!sent && refocusEmail.current) {
      refocusEmail.current = false;
      emailRef.current?.focus();
    }
  }, [sent]);

  if (sent)
    return (
      <form onSubmit={onVerifyCode} className="m-0 flex flex-col gap-3">
        <label className={FIELD_LABEL}>
          Six-digit code
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            value={code}
            onChange={(e) => onCode(e.target.value)}
            className={FIELD}
          />
        </label>
        <button type="submit" className={PRIMARY}>
          Sign in
        </button>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className={SECONDARY}
            onClick={() => {
              refocusEmail.current = true;
              onUseDifferentEmail();
            }}
          >
            Use a different email
          </button>
          <button type="button" className={SECONDARY} onClick={onResend}>
            Send a new code
          </button>
        </div>
      </form>
    );
  return (
    <form onSubmit={onRequestCode} className="m-0 flex flex-col gap-3">
      <label className={FIELD_LABEL}>
        Email
        <input
          ref={emailRef}
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => onEmail(e.target.value)}
          className={FIELD}
        />
      </label>
      <button type="submit" className={PRIMARY}>
        Email me a code
      </button>
    </form>
  );
}
