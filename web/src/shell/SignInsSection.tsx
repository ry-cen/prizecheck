import { useEffect, useId, useRef, useState } from "react";
import { SECONDARY } from "../public/controls";
import { ProviderMark, SignInAlert } from "../public/SignIn";
import {
  clearFailureFromAddress,
  failureInAddress,
  signInMessage,
  type SignInMessage,
} from "../signInMessages";

// The Settings page's Sign-ins section (#207; the Sign-ins page of #156, sign-in decision "Sign-ins page", until the
// Settings page replaced it). It lists every configured provider from GET /auth/methods, so a new provider
// appears with no change here, with the date it was linked or a Connect link, and offers Remove only while more than
// one sign-in is linked. Every failure message comes from the allowlist in signInMessages.ts, naming a provider only
// by its configured display name.

type Provider = { id: string; name: string };
type LinkedSignIn = { provider: string; linkedAt: string };

/** Where a stale session goes: sign in again, then come back here. */
const SIGN_IN_AGAIN = `/sign-in?next=${encodeURIComponent("/settings")}`;

export function SignInsSection({ email }: { email: string | null }) {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [linked, setLinked] = useState<LinkedSignIn[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [failure, setFailure] = useState<SignInMessage | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  // A failed link returns here with ?error=<code>: read once, shown once, then removed from the address bar.
  const [arrived] = useState(failureInAddress);
  const arrivalShown = useRef(false);
  const failureRef = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();

  async function load() {
    try {
      const [methods, signIns] = await Promise.all([
        fetch("/auth/methods", { credentials: "same-origin" }),
        fetch("/auth/sign-ins", { credentials: "same-origin" }),
      ]);
      const methodsBody = methods.ok ? await methods.json() : null;
      const signInsBody = signIns.ok ? await signIns.json() : null;
      if (
        !Array.isArray(methodsBody?.providers) ||
        !Array.isArray(signInsBody?.signIns)
      )
        throw new Error("Sign-ins unavailable");
      setProviders(methodsBody.providers as Provider[]);
      setLinked(signInsBody.signIns as LinkedSignIn[]);
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (!arrived || arrivalShown.current || providers === null) return;
    arrivalShown.current = true;
    setFailure(
      signInMessage(
        arrived.code,
        providers.find((provider) => provider.id === arrived.provider)?.name ??
          null,
        "sign-ins"
      )
    );
    clearFailureFromAddress();
  }, [arrived, providers]);
  useEffect(() => {
    if (failure) failureRef.current?.focus();
  }, [failure]);

  async function remove(provider: Provider) {
    setBusy(true);
    setFailure(null);
    setNotice("");
    try {
      const response = await fetch(
        `/auth/unlink/${encodeURIComponent(provider.id)}`,
        { method: "POST", credentials: "same-origin" }
      );
      if (response.ok) {
        setNotice(`${provider.name} sign-in removed.`);
        await load();
        return;
      }
      const body = await response.json().catch(() => null);
      setFailure(
        signInMessage(
          typeof body?.code === "string" ? body.code : "unlink_failed",
          provider.name,
          "sign-ins"
        )
      );
      await load();
    } catch {
      setFailure(signInMessage("unlink_failed", provider.name, "sign-ins"));
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function signInAgain() {
    await fetch("/auth/sign-out", {
      method: "POST",
      credentials: "same-origin",
    }).catch(() => undefined);
    location.assign(SIGN_IN_AGAIN);
  }

  return (
    <section
      id="sign-ins"
      aria-labelledby={headingId}
      className="flex flex-col gap-3"
    >
      <h2
        id={headingId}
        ref={heading}
        tabIndex={-1}
        className="m-0 text-heading font-semibold"
      >
        Sign-ins
      </h2>
      <section
        aria-label="Your sign-ins"
        className="flex flex-col gap-4 text-body"
      >
        {email && <p className="m-0">Your account email: {email}</p>}
        {failure && (
          <SignInAlert
            message={failure}
            ref={failureRef}
            action={
              failure.group === "sign-in-again" ? (
                <button
                  type="button"
                  onClick={() => void signInAgain()}
                  className={`${SECONDARY} mt-1 self-start`}
                >
                  Sign in again
                </button>
              ) : failure.group === "other-account" ? (
                <button
                  type="button"
                  onClick={() => {
                    // The message (and this button) goes, so focus moves to the section's heading, not the page body.
                    heading.current?.focus();
                    setFailure(null);
                  }}
                  className={`${SECONDARY} mt-1 self-start`}
                >
                  Back to Sign-ins
                </button>
              ) : null
            }
          />
        )}
        {unavailable && (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="m-0 text-danger">
              Your sign-ins couldn't be loaded.
            </p>
            <button
              type="button"
              className={SECONDARY}
              onClick={() => void load()}
            >
              Retry
            </button>
          </div>
        )}
        {providers && linked && (
          <ul className="m-0 flex list-none flex-col rounded-panel border border-border bg-surface p-0">
            {providers.map((provider) => {
              const entry = linked.find(
                (item) => item.provider === provider.id
              );
              return (
                <li
                  key={provider.id}
                  className="box-content flex min-h-tap items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
                >
                  <ProviderMark name={provider.name} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-semibold">{provider.name}</span>
                    <span className="text-meta text-text-muted">
                      {entry
                        ? `Connected ${new Date(entry.linkedAt).toLocaleDateString()}`
                        : "Not connected"}
                    </span>
                  </span>
                  {entry ? (
                    linked.length > 1 && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void remove(provider)}
                        aria-label={`Remove ${provider.name}`}
                        className={SECONDARY}
                      >
                        Remove
                      </button>
                    )
                  ) : (
                    <a
                      href={`/auth/link/${encodeURIComponent(provider.id)}`}
                      aria-label={`Connect ${provider.name}`}
                      className={SECONDARY}
                    >
                      Connect
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="m-0 text-meta text-text-muted">
          You can sign in with any connected account. Your last sign-in can't be
          removed.
        </p>
        <p role="status" className="m-0 text-meta text-text-muted">
          {notice}
        </p>
      </section>
    </section>
  );
}
