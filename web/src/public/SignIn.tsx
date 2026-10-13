import type { FormEvent, ReactNode } from "react";
import {
  CARD,
  CENTRED_MAIN,
  FIELD,
  FIELD_LABEL,
  PRIMARY,
  SECONDARY,
} from "./controls";

type CardProps = {
  /** Signing in returns to a page the collector asked for (a protected page, or a `next`), not the default. */
  continuing: boolean;
  /** The ways to sign in. Today that is the email-code forms; OAuth (#150, #151) puts its failure message and
   * provider links here, above the email form. */
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

type EmailCodeProps = {
  email: string;
  code: string;
  /** A code was requested, so the code form shows. */
  sent: boolean;
  onEmail: (email: string) => void;
  onCode: (code: string) => void;
  onRequestCode: (event: FormEvent) => void;
  onVerifyCode: (event: FormEvent) => void;
};

/** Today's sign-in, unchanged: an emailed six-digit code. The email form stays after a code is sent, so a new
 * code can be requested; Sign in then becomes the main action. */
export function EmailCodeForms({
  email,
  code,
  sent,
  onEmail,
  onCode,
  onRequestCode,
  onVerifyCode,
}: EmailCodeProps) {
  return (
    <>
      <form onSubmit={onRequestCode} className="m-0 flex flex-col gap-3">
        <label className={FIELD_LABEL}>
          Email
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => onEmail(e.target.value)}
            className={FIELD}
          />
        </label>
        <button type="submit" className={sent ? SECONDARY : PRIMARY}>
          Send code
        </button>
      </form>
      {sent && (
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
        </form>
      )}
    </>
  );
}
