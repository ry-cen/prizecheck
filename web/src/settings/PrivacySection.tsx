import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  getProfile,
  newInviteLink,
  setDisplayName,
  setHandle,
  type CollectorProfile,
} from "../profile_generated";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { TextField } from "../ui/TextField";
import { profileDate, profileMessage, retryable } from "./profileMessages";

type Load =
  | { kind: "loading" }
  | { kind: "ready"; profile: CollectorProfile }
  | { kind: "failed" };

type Pending = { action: string; value: string; key: string };

/** The Invite Link's address on this site. */
export function inviteUrl(token: string): string {
  return `${location.origin}/invite/${token}`;
}

/**
 * Settings › Privacy (social network #246): Blocked collectors (#248, the `blocked` slot), then the Display Name,
 * the Handle and the Invite Link, then the children (Hidden Locations, #249), as the spec orders them. Each change is an idempotent owner
 * command; a change that failed for a reason other than a refusal is sent again with the same key when the collector
 * retries the same value, so a change that was saved isn't made twice.
 */
export function PrivacySection({
  blocked,
  children,
}: {
  /** Blocked collectors (#248), first in the section. */
  blocked?: ReactNode;
  children?: ReactNode;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [name, setName] = useState("");
  const [handle, setHandleText] = useState("");
  const [busy, setBusy] = useState(false);
  const [nameNotice, setNameNotice] = useState("");
  const [handleNotice, setHandleNotice] = useState("");
  const [linkNotice, setLinkNotice] = useState("");
  const [status, setStatus] = useState("");
  const [confirming, setConfirming] = useState(false);
  const pending = useRef<Pending | null>(null);
  const newLinkButton = useRef<HTMLButtonElement>(null);
  const base = useId();

  function show(profile: CollectorProfile) {
    setLoad({ kind: "ready", profile });
    setName(profile.display_name);
    setHandleText(profile.handle);
  }
  useEffect(() => {
    getProfile()
      .then(show)
      .catch(() => setLoad({ kind: "failed" }));
  }, []);

  /** Runs one change; `value` names what is sent, so a retry of the same value reuses its key. */
  async function change(
    action: string,
    value: string,
    send: (key: string) => Promise<CollectorProfile>,
    notice: (text: string) => void,
    saved: string
  ) {
    if (busy) return;
    const previous = pending.current;
    const key =
      previous && previous.action === action && previous.value === value
        ? previous.key
        : crypto.randomUUID();
    pending.current = { action, value, key };
    setBusy(true);
    // One notice at a time: a new change clears every earlier one.
    setNameNotice("");
    setHandleNotice("");
    setLinkNotice("");
    setStatus("");
    try {
      show(await send(key));
      pending.current = null;
      setStatus(saved);
    } catch (cause) {
      if (!retryable(cause)) pending.current = null;
      notice(profileMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(token: string) {
    setLinkNotice("");
    try {
      await navigator.clipboard.writeText(inviteUrl(token));
      setStatus("Invite Link copied.");
    } catch {
      setLinkNotice("Couldn't copy. Select the link and copy it yourself.");
    }
  }

  const headingId = `${base}-heading`;
  const profile = load.kind === "ready" ? load.profile : null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="m-0 text-heading font-semibold">
        Privacy
      </h2>
      {load.kind === "loading" && (
        <p className="m-0 text-meta text-text-muted">Loading…</p>
      )}
      {load.kind === "failed" && (
        <p role="alert" className="m-0 text-danger">
          Your Privacy settings are temporarily unavailable. Please retry.
        </p>
      )}
      {blocked}
      {profile && (
        <>
          <section
            aria-labelledby={`${base}-names`}
            className="flex flex-col gap-3"
          >
            <h3 id={`${base}-names`} className="m-0 text-body font-semibold">
              Your name
            </h3>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void change(
                  "display_name",
                  name,
                  (key) =>
                    setDisplayName({
                      display_name: name,
                      idempotency_key: key,
                    }),
                  setNameNotice,
                  "Display Name saved."
                );
              }}
            >
              <div className="min-w-0 flex-[1_1_16rem]">
                <TextField
                  label="Display Name"
                  value={name}
                  maxLength={40}
                  autoComplete="nickname"
                  aria-describedby={`${base}-name-help`}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <Button
                type="submit"
                disabled={busy || name === profile.display_name}
              >
                Save name
              </Button>
              <p
                id={`${base}-name-help`}
                className="m-0 basis-full text-meta text-text-muted"
              >
                Friends see this name, and so does anyone you send your Invite
                Link.
              </p>
              {nameNotice && (
                <p
                  role="alert"
                  className="m-0 basis-full text-meta text-danger"
                >
                  {nameNotice}
                </p>
              )}
            </form>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void change(
                  "handle",
                  handle,
                  (key) => setHandle({ handle, idempotency_key: key }),
                  setHandleNotice,
                  "Handle saved."
                );
              }}
            >
              <div className="min-w-0 flex-[1_1_16rem]">
                <TextField
                  label="Handle"
                  value={handle}
                  maxLength={20}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-describedby={`${base}-handle-help`}
                  onChange={(event) => setHandleText(event.target.value)}
                />
              </div>
              <Button
                type="submit"
                disabled={busy || handle === profile.handle}
              >
                Save Handle
              </Button>
              <p
                id={`${base}-handle-help`}
                className="m-0 basis-full text-meta text-text-muted"
              >
                Friends can find you by typing your Handle exactly. 3 to 20
                letters, digits and underscores.
                {profile.handle_change_available_at &&
                  ` You can change your Handle again on ${profileDate(profile.handle_change_available_at)}.`}
              </p>
              {handleNotice && (
                <p
                  role="alert"
                  className="m-0 basis-full text-meta text-danger"
                >
                  {handleNotice}
                </p>
              )}
            </form>
          </section>
          <section
            aria-labelledby={`${base}-invite`}
            className="flex flex-col gap-2"
          >
            <h3 id={`${base}-invite`} className="m-0 text-body font-semibold">
              Invite Link
            </h3>
            <p className="m-0 text-meta text-text-muted">
              Send it to people you know. Anyone with the link sees your Display
              Name.
            </p>
            <TextField
              label="Your Invite Link"
              value={inviteUrl(profile.invite_token)}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                onClick={() => void copyLink(profile.invite_token)}
              >
                Copy link
              </Button>
              <Button
                ref={newLinkButton}
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                Make a new link
              </Button>
            </div>
            {linkNotice && (
              <p role="alert" className="m-0 text-meta text-danger">
                {linkNotice}
              </p>
            )}
          </section>
        </>
      )}
      {children}
      <p role="status" className="m-0 text-meta text-text-muted">
        {status}
      </p>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Make a new Invite Link?"
        closeLabel="Close"
        size="card"
        returnFocus={newLinkButton}
      >
        <p className="m-0 text-body">
          Your current link stops working straight away. Anyone you sent it to
          will need the new one.
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button onClick={() => setConfirming(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              void change(
                "invite_link",
                profile?.invite_token ?? "",
                (key) => newInviteLink({ idempotency_key: key }),
                setLinkNotice,
                "New Invite Link made. The old one no longer works."
              );
            }}
          >
            Make a new link
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
