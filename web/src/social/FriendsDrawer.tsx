import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Ellipsis, Smile } from "lucide-react";
import { getProfile } from "../profile_generated";
import { inviteUrl } from "../settings/PrivacySection";
import {
  acceptFriendRequest,
  blockCollector,
  declineFriendRequest,
  getFriends,
  lookupHandle,
  removeFriend,
  sendFriendRequest,
  withdrawFriendRequest,
  type Collector,
  type CollectorLookup,
  type FriendCommandResult,
  type FriendsView,
  unblockCollector,
} from "../social_generated";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { Menu, type MenuItem } from "../ui/Menu";
import { TextField } from "../ui/TextField";
import { commandMessage, lookupMessage } from "./socialMessages";

/**
 * The Friends drawer (social network #247, spec "Web screens", variant E): the ☺ button in the header, with a badge
 * counting Friend Requests received, opens it from any page. Requests received come first with Accept and Decline and
 * Block (#248) behind a ⋯, then the Friends, each with Remove Friend and Block behind its ⋯, then requests sent with
 * Withdraw. Add opens a Handle search and Copy link for the Invite Link; Privacy and blocked leads to Settings, where
 * Unblock is.
 *
 * The shell provides it; the desktop header and the phone headers (the shell's and Collection's own) draw the button.
 * The badge is read when the shell starts, when the drawer opens, after each change and when the window regains focus;
 * nothing polls.
 *
 * Focus: choosing Remove Friend or Block from a ⋯ swaps the row for its confirmation and focuses the confirming
 * button, and Cancel returns focus to that row's ⋯. A command that removes its own row moves focus to the "Your
 * Friends" heading, which is always there; the drawer's status line announces what happened.
 */
type FriendsApi = {
  open: (opener: RefObject<HTMLElement | null>) => void;
  isOpen: boolean;
  /** Requests received, for the badge; 0 until the first read. */
  received: number;
  /** Reads the Friends list again (after a change made elsewhere, such as the Invite Link page). */
  refresh: () => void;
};

const FriendsContext = createContext<FriendsApi | null>(null);

/** The shell's refresh of the Friends badge and drawer, for a page that changes a friendship; nothing outside it. */
export function useFriendsRefresh(): () => void {
  return useContext(FriendsContext)?.refresh ?? (() => {});
}

type Load =
  | { kind: "loading" }
  | { kind: "ready"; view: FriendsView }
  | { kind: "failed" };

export function FriendsProvider({
  onPrivacy,
  children,
}: {
  /** Opens Settings, whose Privacy section lists Blocked collectors (#248). */
  onPrivacy: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const opener = useRef<HTMLElement | null>(null);
  const reads = useRef(0);

  const refresh = useCallback(() => {
    const read = ++reads.current;
    getFriends()
      .then((view) => {
        if (read === reads.current) setLoad({ kind: "ready", view });
      })
      .catch(() => {
        if (read === reads.current)
          setLoad((current) =>
            current.kind === "ready" ? current : { kind: "failed" }
          );
      });
  }, []);

  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const received = load.kind === "ready" ? load.view.received.length : 0;
  return (
    <FriendsContext.Provider
      value={{
        open: (from) => {
          opener.current = from.current;
          setOpen(true);
          refresh();
        },
        isOpen: open,
        received,
        refresh,
      }}
    >
      {children}
      {/* Drawn only while open, so its names and buttons appear once on the page. */}
      <FriendsDialog
        open={open}
        load={load}
        opener={opener}
        onClose={() => setOpen(false)}
        onChanged={refresh}
        onPrivacy={onPrivacy}
      />
    </FriendsContext.Provider>
  );
}

/** "Friends", or "Friends, 2 requests" when requests are waiting. */
function friendsName(received: number): string {
  if (!received) return "Friends";
  return `Friends, ${received} ${received === 1 ? "request" : "requests"}`;
}

/** The header's Friends button: 32 px on desktop, a 44 px tap area on a phone. Nothing outside the shell. */
export function FriendsButton({ phone = false }: { phone?: boolean }) {
  const friends = useContext(FriendsContext);
  const ref = useRef<HTMLButtonElement>(null);
  if (!friends) return null;
  return (
    <button
      ref={ref}
      type="button"
      aria-label={friendsName(friends.received)}
      aria-haspopup="dialog"
      aria-expanded={friends.isOpen}
      onClick={() => friends.open(ref)}
      className={`relative shrink-0 cursor-pointer items-center justify-center rounded-round border-0 bg-transparent p-0 text-text-muted hover:text-text ${
        phone ? "hidden size-tap phone:inline-flex" : "inline-flex size-8"
      }`}
    >
      <Icon icon={Smile} size={20} />
      {friends.received > 0 && (
        <span
          aria-hidden="true"
          className="absolute top-0 right-0 box-border inline-block h-4.5 min-w-4.5 rounded-round bg-accent px-1 text-center text-micro leading-4.5 font-bold text-on-accent tabular-nums"
        >
          {friends.received}
        </span>
      )}
    </button>
  );
}

const ROW = "flex min-h-tap items-center gap-2 py-1";
const NAME = "min-w-0 flex-1";

function Person({ person, after }: { person: Collector; after?: string }) {
  return (
    <span className={NAME}>
      <span className="font-semibold text-text">{person.display_name}</span>{" "}
      <span className="text-meta text-text-muted">
        @{person.handle}
        {after}
      </span>
    </span>
  );
}

/** A row's question with its confirming button, which takes focus when the row swaps in; Cancel is beside it. */
function Confirmation({
  question,
  confirm,
  busy,
  onConfirm,
  onCancel,
}: {
  question: string;
  confirm: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    primary.current?.focus();
  }, []);
  return (
    <>
      <span className={`${NAME} text-body`}>{question}</span>
      <Button
        ref={primary}
        variant="danger"
        disabled={busy}
        onClick={onConfirm}
      >
        {confirm}
      </Button>
      <Button onClick={onCancel}>Cancel</Button>
    </>
  );
}

function BlockConfirmation({
  person,
  busy,
  onConfirm,
  onCancel,
}: {
  person: Collector;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Confirmation
      question={`Block ${person.display_name}? They won't be told.`}
      confirm="Block"
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

/** The ⋯ beside a collector's row. */
function PersonMenu({
  person,
  items,
}: {
  person: Collector;
  items: MenuItem[];
}) {
  return (
    <Menu
      label={`More for ${person.display_name}`}
      triggerClassName="inline-flex size-control shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent p-0 text-text-muted hover:bg-surface-raised hover:text-text phone:size-tap"
      trigger={<Icon icon={Ellipsis} />}
      items={items}
    />
  );
}

function FriendsDialog({
  open,
  load,
  opener,
  onClose,
  onChanged,
  onPrivacy,
}: {
  open: boolean;
  load: Load;
  opener: RefObject<HTMLElement | null>;
  onClose: () => void;
  onChanged: () => void;
  onPrivacy: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  // The Friend whose Remove Friend or Block is waiting for a yes.
  const [confirming, setConfirming] = useState<{
    id: string;
    action: "remove" | "block";
  } | null>(null);
  const base = useId();
  const body = useRef<HTMLDivElement>(null);
  const friendsHeading = useRef<HTMLHeadingElement>(null);
  // The collector whose ⋯ gets focus back after Cancel.
  const backTo = useRef<string | null>(null);
  useEffect(() => {
    if (confirming || busy || !backTo.current) return;
    const id = backTo.current;
    backTo.current = null;
    const row = Array.from(
      body.current?.querySelectorAll<HTMLElement>("li[data-collector]") ?? []
    ).find((item) => item.dataset.collector === id);
    // The row's ⋯, or its first button when it has none (a request sent).
    (
      row?.querySelector<HTMLElement>('button[aria-haspopup="menu"]') ??
      row?.querySelector<HTMLElement>("button")
    )?.focus();
  }, [confirming, busy]);

  function cancel(person: Collector) {
    backTo.current = person.collector_id;
    setConfirming(null);
  }

  function close() {
    setAdding(false);
    setStatus("");
    setProblem("");
    setConfirming(null);
    onClose();
  }

  /** Runs one change and reads the list again; `done` says what happened. */
  async function run(
    send: (key: string) => Promise<FriendCommandResult>,
    done: (result: FriendCommandResult) => string,
    options: { rowGoes?: boolean; row?: string } = {}
  ): Promise<FriendCommandResult | null> {
    if (busy) return null;
    setBusy(true);
    setStatus("");
    setProblem("");
    try {
      const result = await send(crypto.randomUUID());
      setStatus(done(result));
      // The row the command was on is going: focus the list's heading, which stays.
      if (options.rowGoes) friendsHeading.current?.focus();
      return result;
    } catch (cause) {
      setProblem(commandMessage(cause));
      // The row stays: focus returns to it once the buttons are enabled again.
      if (options.row) backTo.current = options.row;
      return null;
    } finally {
      setBusy(false);
      setConfirming(null);
      onChanged();
    }
  }

  function block(person: Collector) {
    return run(
      (key) =>
        blockCollector({
          collector_id: person.collector_id,
          idempotency_key: key,
        }),
      () => `Blocked ${person.display_name}. They aren't told.`,
      { rowGoes: true, row: person.collector_id }
    );
  }

  const view = load.kind === "ready" ? load.view : null;
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Friends"
      closeLabel="Close Friends"
      side="right"
      returnFocus={opener}
      headerActions={
        open && (
          <Button
            variant={adding ? "secondary" : "primary"}
            aria-expanded={adding}
            onClick={() => setAdding(!adding)}
          >
            {adding ? "Done" : "Add"}
          </Button>
        )
      }
    >
      {open && (
        <div ref={body} className="flex flex-col gap-4">
          {adding && <AddFriend run={run} busy={busy} />}
          {load.kind === "loading" && (
            <p className="m-0 text-meta text-text-muted">Loading…</p>
          )}
          {load.kind === "failed" && (
            <p role="alert" className="m-0 text-meta text-danger">
              Your Friends are temporarily unavailable. Please retry.
            </p>
          )}
          {view && view.received.length > 0 && (
            <section
              aria-labelledby={`${base}-received`}
              className="flex flex-col"
            >
              <h3
                id={`${base}-received`}
                className="m-0 text-meta font-semibold text-text-muted"
              >
                Friend Requests
              </h3>
              <ul className="m-0 list-none p-0">
                {view.received.map((person) => (
                  <li
                    key={person.collector_id}
                    data-collector={person.collector_id}
                    className={ROW}
                  >
                    {confirming?.id === person.collector_id ? (
                      <BlockConfirmation
                        person={person}
                        busy={busy}
                        onConfirm={() => void block(person)}
                        onCancel={() => cancel(person)}
                      />
                    ) : (
                      <>
                        <Person
                          person={person}
                          after=" · wants to be Friends"
                        />
                        <Button
                          variant="primary"
                          disabled={busy}
                          aria-label={`Accept ${person.display_name}`}
                          onClick={() =>
                            void run(
                              (key) =>
                                acceptFriendRequest(person.collector_id, {
                                  idempotency_key: key,
                                }),
                              () =>
                                `You and ${person.display_name} are now Friends.`,
                              { rowGoes: true, row: person.collector_id }
                            )
                          }
                        >
                          Accept
                        </Button>
                        <Button
                          disabled={busy}
                          aria-label={`Decline ${person.display_name}`}
                          onClick={() =>
                            void run(
                              (key) =>
                                declineFriendRequest(person.collector_id, {
                                  idempotency_key: key,
                                }),
                              () => "Friend Request declined.",
                              { rowGoes: true, row: person.collector_id }
                            )
                          }
                        >
                          Decline
                        </Button>
                        <PersonMenu
                          person={person}
                          items={[
                            {
                              label: "Block",
                              onSelect: () =>
                                setConfirming({
                                  id: person.collector_id,
                                  action: "block",
                                }),
                            },
                          ]}
                        />
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {view && (
            <section
              aria-labelledby={`${base}-friends`}
              className="flex flex-col"
            >
              <h3
                id={`${base}-friends`}
                ref={friendsHeading}
                tabIndex={-1}
                className="m-0 text-meta font-semibold text-text-muted outline-none"
              >
                Your Friends
              </h3>
              {view.friends.length === 0 && (
                <p className="m-0 py-1 text-meta text-text-muted">
                  No Friends yet. Choose Add to find someone by their Handle or
                  to copy your Invite Link.
                </p>
              )}
              <ul className="m-0 list-none p-0">
                {view.friends.map((person) => (
                  <li
                    key={person.collector_id}
                    data-collector={person.collector_id}
                    className={ROW}
                  >
                    {confirming?.id === person.collector_id &&
                    confirming.action === "remove" ? (
                      <Confirmation
                        question={`Remove ${person.display_name} as a Friend?`}
                        confirm="Remove"
                        busy={busy}
                        onConfirm={() =>
                          void run(
                            (key) =>
                              removeFriend(person.collector_id, {
                                idempotency_key: key,
                              }),
                            () =>
                              `${person.display_name} is no longer a Friend.`,
                            { rowGoes: true, row: person.collector_id }
                          )
                        }
                        onCancel={() => cancel(person)}
                      />
                    ) : confirming?.id === person.collector_id ? (
                      <BlockConfirmation
                        person={person}
                        busy={busy}
                        onConfirm={() => void block(person)}
                        onCancel={() => cancel(person)}
                      />
                    ) : (
                      <>
                        <Person person={person} />
                        <PersonMenu
                          person={person}
                          items={[
                            {
                              label: "Remove Friend",
                              onSelect: () =>
                                setConfirming({
                                  id: person.collector_id,
                                  action: "remove",
                                }),
                            },
                            {
                              label: "Block",
                              onSelect: () =>
                                setConfirming({
                                  id: person.collector_id,
                                  action: "block",
                                }),
                            },
                          ]}
                        />
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {view && view.sent.length > 0 && (
            <section aria-labelledby={`${base}-sent`} className="flex flex-col">
              <h3
                id={`${base}-sent`}
                className="m-0 text-meta font-semibold text-text-muted"
              >
                Requests sent
              </h3>
              <ul className="m-0 list-none p-0">
                {view.sent.map((person) => (
                  <li
                    key={person.collector_id}
                    data-collector={person.collector_id}
                    className={ROW}
                  >
                    <Person person={person} after=" · request sent" />
                    <Button
                      variant="quiet"
                      disabled={busy}
                      aria-label={`Withdraw request to ${person.display_name}`}
                      onClick={() =>
                        void run(
                          (key) =>
                            withdrawFriendRequest(person.collector_id, {
                              idempotency_key: key,
                            }),
                          () => "Friend Request withdrawn.",
                          { rowGoes: true, row: person.collector_id }
                        )
                      }
                    >
                      Withdraw
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {problem && (
            <p role="alert" className="m-0 text-meta text-danger">
              {problem}
            </p>
          )}
          <p role="status" className="m-0 text-meta text-text-muted">
            {status}
          </p>
          <div>
            <Button
              variant="quiet"
              onClick={() => {
                close();
                onPrivacy();
              }}
            >
              Privacy and blocked
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

type Run = (
  send: (key: string) => Promise<FriendCommandResult>,
  done: (result: FriendCommandResult) => string,
  options?: { rowGoes?: boolean; row?: string }
) => Promise<FriendCommandResult | null>;

type Found =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "found"; collector: CollectorLookup }
  | { kind: "missed"; message: string };

/** Add: find a collector by their exact Handle, or copy the Invite Link. */
function AddFriend({ run, busy }: { run: Run; busy: boolean }) {
  const [handle, setHandle] = useState("");
  const [found, setFound] = useState<Found>({ kind: "idle" });
  const [copied, setCopied] = useState("");

  async function search() {
    if (!handle.trim() || found.kind === "searching") return;
    setFound({ kind: "searching" });
    try {
      setFound({
        kind: "found",
        collector: await lookupHandle({ handle }),
      });
    } catch (cause) {
      setFound({ kind: "missed", message: lookupMessage(cause) });
    }
  }

  async function copyLink() {
    setCopied("");
    try {
      const { invite_token } = await getProfile();
      await navigator.clipboard.writeText(inviteUrl(invite_token));
      setCopied("Invite Link copied.");
    } catch {
      setCopied(
        "Couldn't copy. Copy your Invite Link from Settings › Privacy."
      );
    }
  }

  async function act(
    collector: CollectorLookup,
    send: (key: string) => Promise<FriendCommandResult>,
    done: string
  ) {
    const result = await run(send, () => done);
    if (result) {
      moved.current = true;
      setFound({
        kind: "found",
        collector: { ...collector, relation: result.relation },
      });
    }
  }

  // After a change to the result, focus goes to its new button, or to the result itself when it has none.
  const moved = useRef(false);
  const result = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moved.current || busy) return;
    moved.current = false;
    (
      result.current?.querySelector<HTMLElement>("button") ?? result.current
    )?.focus();
  }, [found, busy]);

  return (
    <div className="flex flex-col gap-2 border-b border-border pb-4">
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <div className="min-w-0 flex-1">
          <TextField
            label="Their Handle"
            value={handle}
            maxLength={20}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setHandle(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={found.kind === "searching"}>
          Find
        </Button>
      </form>
      {found.kind === "missed" && (
        <p role="alert" className="m-0 text-meta text-text">
          {found.message}
        </p>
      )}
      {found.kind === "found" && (
        <LookupResult
          collector={found.collector}
          busy={busy}
          act={act}
          groupRef={result}
        />
      )}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-meta text-text-muted">
          Or share your Invite Link
        </span>
        <Button onClick={() => void copyLink()}>Copy link</Button>
      </div>
      {copied && <p className="m-0 text-meta text-text-muted">{copied}</p>}
    </div>
  );
}

function LookupResult({
  collector,
  busy,
  act,
  groupRef,
}: {
  groupRef: RefObject<HTMLDivElement | null>;
  collector: CollectorLookup;
  busy: boolean;
  act: (
    collector: CollectorLookup,
    send: (key: string) => Promise<FriendCommandResult>,
    done: string
  ) => Promise<void>;
}) {
  const name = collector.display_name;
  const line = (text: string) => (
    <p className="m-0 text-meta text-text-muted">{text}</p>
  );
  return (
    <div
      ref={groupRef}
      tabIndex={-1}
      className="flex flex-col gap-1 outline-none"
      aria-label="Search result"
      role="group"
    >
      <div className={ROW}>
        <Person person={collector} />
        {collector.relation === "none" && (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void act(
                collector,
                (key) =>
                  sendFriendRequest({
                    collector_id: collector.collector_id,
                    idempotency_key: key,
                  }),
                `Friend Request sent to ${name}.`
              )
            }
          >
            Send Friend Request
          </Button>
        )}
        {collector.relation === "blocked" && (
          <Button
            disabled={busy}
            onClick={() =>
              void act(
                collector,
                (key) =>
                  unblockCollector(collector.collector_id, {
                    idempotency_key: key,
                  }),
                `Unblocked ${name}.`
              )
            }
          >
            Unblock
          </Button>
        )}
        {collector.relation === "request_received" && (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void act(
                collector,
                (key) =>
                  acceptFriendRequest(collector.collector_id, {
                    idempotency_key: key,
                  }),
                `You and ${name} are now Friends.`
              )
            }
          >
            Accept
          </Button>
        )}
      </div>
      {collector.relation === "self" && line("That's your own Handle.")}
      {collector.relation === "blocked" && line(`You blocked ${name}.`)}
      {collector.relation === "friends" && line(`You and ${name} are Friends.`)}
      {collector.relation === "request_sent" &&
        line(`You've sent ${name} a Friend Request.`)}
      {collector.relation === "request_received" &&
        line(`${name} has sent you a Friend Request.`)}
    </div>
  );
}
