import { useEffect, useState } from "react";
import { getPublicInvite, ProfileError } from "../profile_generated";
import { CARD, CENTRED_MAIN, PRIMARY } from "./controls";
import { DeadEnd } from "./DeadEnd";
import { followLink, SIGN_IN_PATH } from "./publicRoutes";

type Props = {
  token: string;
  signedIn: boolean;
  onNavigate: (to: string) => void;
};

type Load =
  | { kind: "loading" }
  | { kind: "ready"; name: string }
  | { kind: "gone" }
  | { kind: "failed" };

/**
 * The Invite Link page, /invite/<token> (social network #246, spec "Handles, Invite Links and lookup"): "<Display
 * Name> invited you to PrizeCheck" and nothing else about the collector. Signed out it offers Sign in, which comes back
 * here; signed in, sending a Friend Request from here arrives in #247. A replaced or unknown link is a dead end.
 * Search engines never index it.
 */
export function InvitePage({ token, signedIn, onNavigate }: Props) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  useEffect(() => {
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex, nofollow";
    document.head.append(robots);
    return () => robots.remove();
  }, []);
  useEffect(() => {
    let live = true;
    getPublicInvite(token)
      .then(
        (invite) =>
          live && setLoad({ kind: "ready", name: invite.display_name })
      )
      .catch((cause) => {
        if (!live) return;
        setLoad(
          cause instanceof ProfileError && cause.status === 404
            ? { kind: "gone" }
            : { kind: "failed" }
        );
      });
    return () => {
      live = false;
    };
  }, [token]);
  if (load.kind === "gone")
    return (
      <DeadEnd kind="invite" signedIn={signedIn} onNavigate={onNavigate} />
    );
  const follow = followLink(onNavigate);
  const signIn = `${SIGN_IN_PATH}?next=${encodeURIComponent(`/invite/${token}`)}`;
  return (
    <main className={CENTRED_MAIN}>
      <section
        aria-labelledby="invite-heading"
        className={`${CARD} items-center text-center`}
      >
        {load.kind === "loading" && (
          <p className="m-0 text-meta text-text-muted">Loading…</p>
        )}
        {load.kind === "failed" && (
          <p role="alert" className="m-0 text-danger">
            This invite is temporarily unavailable. Please retry.
          </p>
        )}
        {load.kind === "ready" && (
          <>
            <h1 id="invite-heading" className="m-0 text-display font-semibold">
              {load.name} invited you to PrizeCheck
            </h1>
            {!signedIn && (
              <a href={signIn} onClick={follow} className={PRIMARY}>
                Sign in
              </a>
            )}
          </>
        )}
      </section>
    </main>
  );
}
