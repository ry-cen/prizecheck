import { useEffect, useState } from "react";
import { getPublicInvite, ProfileError } from "../profile_generated";
import { useFriendsRefresh } from "../social/FriendsDrawer";
import { commandMessage } from "../social/socialMessages";
import {
  acceptFriendRequest,
  getInvite,
  sendFriendRequest,
  SocialError,
  type CollectorLookup,
  type FriendCommandResult,
  unblockCollector,
} from "../social_generated";
import { CARD, CENTRED_MAIN, PRIMARY, SECONDARY } from "./controls";
import { DeadEnd } from "./DeadEnd";
import { followLink, SIGN_IN_PATH } from "./publicRoutes";

type Props = {
  token: string;
  signedIn: boolean;
  onNavigate: (to: string) => void;
};

type Load =
  | { kind: "loading" }
  | { kind: "ready"; name: string; collector: CollectorLookup | null }
  | { kind: "gone" }
  | { kind: "failed" };

/**
 * The Invite Link page, /invite/<token> (social network #246, spec "Handles, Invite Links and lookup"): "<Display
 * Name> invited you to PrizeCheck" and nothing else about the collector. Signed out it reads the public record only
 * and offers Sign in, which comes back here. Signed in it reads the authenticated invite route instead (#247), never
 * the public record, and offers Send Friend Request, which is never sent by itself; when the two are already Friends,
 * a request is pending or the link is the collector's own, it says so, and a collector the visitor blocked comes with
 * Unblock (#248). A replaced or unknown link is a dead end, and so is the link of a collector who blocked the visitor.
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
    const read: Promise<Load> = signedIn
      ? getInvite(token).then((collector) => ({
          kind: "ready",
          name: collector.display_name,
          collector,
        }))
      : getPublicInvite(token).then((invite) => ({
          kind: "ready",
          name: invite.display_name,
          collector: null,
        }));
    read
      .then((next) => live && setLoad(next))
      .catch((cause) => {
        if (!live) return;
        const missing =
          (cause instanceof ProfileError || cause instanceof SocialError) &&
          cause.status === 404;
        setLoad(missing ? { kind: "gone" } : { kind: "failed" });
      });
    return () => {
      live = false;
    };
  }, [token, signedIn]);
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
            {load.collector && (
              <InviteActions
                collector={load.collector}
                onChange={(collector) =>
                  setLoad({ kind: "ready", name: load.name, collector })
                }
              />
            )}
          </>
        )}
      </section>
    </main>
  );
}

/** Signed in: Send Friend Request, Accept, Unblock, or how the two already stand. */
function InviteActions({
  collector,
  onChange,
}: {
  collector: CollectorLookup;
  onChange: (collector: CollectorLookup) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const refreshFriends = useFriendsRefresh();
  const name = collector.display_name;

  async function run(send: (key: string) => Promise<FriendCommandResult>) {
    if (busy) return;
    setBusy(true);
    setProblem("");
    try {
      const { relation } = await send(crypto.randomUUID());
      onChange({ ...collector, relation });
      refreshFriends();
    } catch (cause) {
      setProblem(commandMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const note = {
    self: "This is your own Invite Link.",
    none: "",
    friends: `You and ${name} are Friends.`,
    request_sent: `You've sent ${name} a Friend Request.`,
    request_received: `${name} has sent you a Friend Request.`,
    blocked: `You blocked ${name}.`,
  }[collector.relation];
  return (
    <>
      {collector.relation === "none" && (
        <button
          type="button"
          className={PRIMARY}
          disabled={busy}
          onClick={() =>
            void run((key) =>
              sendFriendRequest({
                collector_id: collector.collector_id,
                idempotency_key: key,
              })
            )
          }
        >
          Send Friend Request
        </button>
      )}
      {collector.relation === "request_received" && (
        <button
          type="button"
          className={PRIMARY}
          disabled={busy}
          onClick={() =>
            void run((key) =>
              acceptFriendRequest(collector.collector_id, {
                idempotency_key: key,
              })
            )
          }
        >
          Accept
        </button>
      )}
      {collector.relation === "blocked" && (
        <button
          type="button"
          className={SECONDARY}
          disabled={busy}
          onClick={() =>
            void run((key) =>
              unblockCollector(collector.collector_id, {
                idempotency_key: key,
              })
            )
          }
        >
          Unblock
        </button>
      )}
      <p role="status" className="m-0 text-body text-text-muted">
        {note}
      </p>
      {problem && (
        <p role="alert" className="m-0 text-meta text-danger">
          {problem}
        </p>
      )}
    </>
  );
}
