import { useEffect, useRef, useState } from "react";
import { useProfile } from "./profile";
import {
  clearFailureFromAddress,
  failureInAddress,
  signInMessage,
  type SignInMessage,
} from "./signInMessages";

// The Sign-ins settings page (/settings/sign-ins, #156). It lists every configured provider from GET /auth/methods, so
// a new provider appears with no change here, with the date it was linked or a Connect link, and offers Remove only
// while more than one sign-in is linked. Every failure message comes from the allowlist in signInMessages.ts, naming a
// provider only by its configured display name. The layout belongs to the app-redesign map.

type Provider = { id: string; name: string };
type LinkedSignIn = { provider: string; linkedAt: string };

/** Where a stale session goes: sign in again, then come back here. */
const SIGN_IN_AGAIN = `/sign-in?next=${encodeURIComponent("/settings/sign-ins")}`;

export function SignIns() {
  const profile = useProfile();
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
    <section aria-label="Your sign-ins" className="sign-ins">
      {failure && (
        <div
          className="sign-ins-failure"
          role="alert"
          tabIndex={-1}
          ref={failureRef}
        >
          <p>{failure.text}</p>
          {failure.next && <p>{failure.next}</p>}
          {failure.group === "sign-in-again" && (
            <button type="button" onClick={() => void signInAgain()}>
              Sign in again
            </button>
          )}
        </div>
      )}
      {profile?.email && <p>Signed in as {profile.email}</p>}
      {unavailable && (
        <p role="alert">Sign-ins are temporarily unavailable. Please retry.</p>
      )}
      {providers && linked && (
        <ul className="sign-ins-list">
          {providers.map((provider) => {
            const entry = linked.find((item) => item.provider === provider.id);
            return (
              <li key={provider.id}>
                <span>{provider.name}</span>{" "}
                {entry ? (
                  <>
                    <span>
                      Connected {new Date(entry.linkedAt).toLocaleDateString()}
                    </span>{" "}
                    {linked.length > 1 && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void remove(provider)}
                      >
                        Remove {provider.name}
                      </button>
                    )}
                  </>
                ) : (
                  <a href={`/auth/link/${encodeURIComponent(provider.id)}`}>
                    Connect {provider.name}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p role="status">{notice}</p>
    </section>
  );
}
