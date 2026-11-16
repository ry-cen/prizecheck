import React, { useEffect, useRef, useState } from "react";
import { App } from "@capacitor/app";
import { AppLauncher } from "@capacitor/app-launcher";
import { Button } from "../../ui/Button";
import { CopyTile } from "../../ui/CopyTile";
import { variantLabel } from "../../ui/variantLabel";
import type { CollectionEntry } from "../../collection_generated";
import {
  fixtureCollectionSource,
  type CollectionSource,
} from "./collectionSource";
import { FixtureSession } from "./fixtureSession";
import {
  NativeSignIn,
  nativeCollectionSource,
  nativeStatus,
  type NativeSignInPlugin,
} from "./nativeSignIn";
import "../../tokens.css";
import "../../tailwind.css";

const ENDED = "Your session ended. Sign in again.";
type Mode = "first" | "refresh" | "more";
type Reads = {
  entries: CollectionEntry[];
  next: string | null;
  /** The read in flight, if any. */
  busy: Mode | null;
  /** The read that failed and can be retried. */
  failed: { mode: Mode; cursor?: string } | null;
  loaded: boolean;
};
const NONE: Reads = {
  entries: [],
  next: null,
  busy: null,
  failed: null,
  loaded: false,
};

/** The loading, error, empty, list and Show more states, shared by both modes. */
function CollectionBody(props: {
  reads: Reads;
  onRetry: () => void;
  onMore: (cursor: string) => void;
}) {
  const { reads, onRetry, onMore } = props;
  const { entries, next, busy, failed, loaded } = reads;
  return (
    <>
      {busy === "first" && (
        <p role="status" className="mt-4">
          Loading your Collection…
        </p>
      )}
      {busy === "refresh" && (
        <p role="status" className="mt-4">
          Refreshing…
        </p>
      )}
      {failed && (
        <div className="mt-4">
          <p role="status" className="mb-2">
            Couldn't load your Collection. Try again.
          </p>
          <Button onClick={onRetry}>Try again</Button>
        </div>
      )}
      {loaded && entries.length === 0 && !failed && busy === null && (
        <p className="mt-4">No cards in your Collection yet.</p>
      )}
      <ul className="mt-6 grid grid-cols-2 gap-4">
        {entries.map((entry) => (
          <li key={entry.edition_id}>
            <CopyTile
              disabled
              label={`${entry.printing_name}, ${variantLabel(entry.descriptor)}`}
              title={entry.printing_name}
              name={entry.printing_name}
              setName={entry.set_name}
              collectorNumber={entry.collector_number}
              variant={variantLabel(entry.descriptor)}
              imageUrl={entry.image_url}
              names
              caption={`${entry.quantity} copies`}
            />
          </li>
        ))}
      </ul>
      {next && !failed && (
        <Button
          className="mt-6"
          disabled={busy !== null}
          onClick={() => onMore(next)}
        >
          {busy === "more" ? "Loading…" : "Show more"}
        </Button>
      )}
    </>
  );
}

function FixtureDemo(props: {
  source?: CollectionSource;
  session?: FixtureSession;
}) {
  const [ownSession] = useState(
    () => props.session ?? new FixtureSession(window.localStorage)
  );
  const session = props.session ?? ownSession;
  const [ownSource] = useState(() => fixtureCollectionSource(session));
  const source = props.source ?? ownSource;
  const [, redraw] = useState(0);
  const [message, setMessage] = useState("");
  const [reads, setReads] = useState<Reads>(NONE);
  const update = () => redraw((value) => value + 1);
  // Each read takes a generation; a result from an older one is ignored.
  const generation = useRef(0);
  // True once this mount has shown a signed-in Collection and not yet left it.
  const wasSignedIn = useRef(false);
  const latest = useRef({ source });
  latest.current = { source };
  function endSession() {
    generation.current += 1;
    wasSignedIn.current = false;
    session.cancel();
    setReads(NONE);
    setMessage(ENDED);
    update();
  }
  async function load(mode: Mode, cursor?: string) {
    const mine = ++generation.current;
    setReads((prev) =>
      mode === "first"
        ? { ...NONE, busy: mode }
        : { ...prev, busy: mode, failed: null }
    );
    const result = await latest.current.source.read(cursor);
    if (mine !== generation.current) return;
    if (result.kind === "signed-out" || !session.signedIn())
      return endSession();
    if (result.kind === "unavailable") {
      setReads((prev) => ({
        ...prev,
        busy: null,
        failed: { mode, cursor },
        loaded: mode === "first" ? false : prev.loaded,
      }));
      return;
    }
    const { entries, next_cursor } = result.page;
    setReads((prev) => ({
      entries: mode === "more" ? [...prev.entries, ...entries] : entries,
      next: next_cursor ?? null,
      busy: null,
      failed: null,
      loaded: true,
    }));
  }
  useEffect(() => {
    let disposed = false;
    const receive = (url: string) => {
      if (disposed) return;
      const result = session.returnFromBrowser(url);
      if (result !== "ignored") {
        setMessage(
          result === "success"
            ? ""
            : result === "cancelled"
              ? "Sign-in cancelled."
              : "Unable to sign in. Please try again."
        );
        update();
      }
    };
    const listener = App.addListener("appUrlOpen", (event) =>
      receive(event.url)
    );
    void App.getLaunchUrl()
      .then((value) => {
        if (value) receive(value.url);
      })
      .catch(() => {});
    // A render notices an expired session; the effect below handles the change.
    const resume = () => {
      if (!session.signedIn()) update();
    };
    const active = App.addListener("appStateChange", resume);
    // Clear the displayed Collection at expiry even when the app stays in the foreground.
    const timer = window.setInterval(resume, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
      void listener.then((handle) => handle.remove());
      void active.then((handle) => handle.remove());
    };
  }, []);
  const signedIn = session.signedIn();
  useEffect(() => {
    if (signedIn) {
      wasSignedIn.current = true;
      void load("first");
    } else {
      generation.current += 1;
      setReads(NONE);
      // Leaving the signed-in screen by any route but Sign out ends the session.
      if (wasSignedIn.current) {
        wasSignedIn.current = false;
        setMessage(ENDED);
      }
    }
  }, [signedIn, source]);
  async function signIn() {
    setMessage("");
    const url = session.begin();
    update();
    try {
      const result = await AppLauncher.openUrl({ url });
      if (!result.completed) throw new Error("Browser unavailable");
    } catch {
      session.cancel();
      setMessage("Unable to open sign-in. Please try again.");
      update();
    }
  }
  const { busy, failed } = reads;
  const retry = () => {
    if (!failed) return;
    if (failed.mode === "more") void load("more", failed.cursor);
    else void load(failed.mode);
  };
  return (
    <main className="mx-auto max-w-3xl px-6 py-8 text-text [padding-top:max(2rem,env(safe-area-inset-top))] [padding-bottom:max(2rem,env(safe-area-inset-bottom))]">
      <p className="mb-6 text-text-subtle">
        {source.sample ? "Prizecheck · Demo with sample cards" : "Prizecheck"}
      </p>
      <h1 className="mb-6 text-2xl font-semibold">
        {signedIn ? "Collection" : "Your Collection, with you"}
      </h1>
      {message && (
        <p role="status" className="mb-4">
          {message}
        </p>
      )}
      {signedIn ? (
        <>
          <Button
            onClick={() => {
              generation.current += 1;
              wasSignedIn.current = false;
              session.cancel();
              setReads(NONE);
              setMessage("Signed out.");
              update();
            }}
          >
            Sign out
          </Button>{" "}
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void load("refresh")}
          >
            Refresh
          </Button>
          <CollectionBody
            reads={reads}
            onRetry={retry}
            onMore={(cursor) => void load("more", cursor)}
          />
        </>
      ) : (
        <>
          <p className="mb-4">
            {session.waiting()
              ? "Finish sign-in in your browser, then return here."
              : "Sign in to open your Collection. If your session ended, sign in again."}
          </p>
          {session.waiting() ? (
            <Button
              onClick={() => {
                session.cancel();
                setMessage("Sign-in cancelled.");
                update();
              }}
            >
              Cancel sign-in
            </Button>
          ) : (
            <Button onClick={() => void signIn()}>Sign in with browser</Button>
          )}
        </>
      )}
    </main>
  );
}

const SIGNED_OUT_MESSAGE = "Signed out.";

/** Native mode: the gateway is configured, and the plugin holds the credential. */
function NativeMode(props: {
  plugin: NativeSignInPlugin;
  signedInAtStart: boolean;
}) {
  const { plugin } = props;
  const [source] = useState(() => nativeCollectionSource(plugin));
  const [signedIn, setSignedIn] = useState(props.signedInAtStart);
  const [signingIn, setSigningIn] = useState(false);
  const [message, setMessage] = useState("");
  const [reads, setReads] = useState<Reads>(NONE);
  // Each read takes a generation; a result from an older one is ignored.
  const generation = useRef(0);
  async function load(mode: Mode, cursor?: string) {
    const mine = ++generation.current;
    setReads((prev) =>
      mode === "first"
        ? { ...NONE, busy: mode }
        : { ...prev, busy: mode, failed: null }
    );
    const result = await source.read(cursor);
    if (mine !== generation.current) return;
    if (result.kind === "signed-out") {
      generation.current += 1;
      setReads(NONE);
      setSignedIn(false);
      setMessage(ENDED);
      return;
    }
    if (result.kind === "unavailable") {
      setReads((prev) => ({
        ...prev,
        busy: null,
        failed: { mode, cursor },
        loaded: mode === "first" ? false : prev.loaded,
      }));
      return;
    }
    const { entries, next_cursor } = result.page;
    setReads((prev) => ({
      entries: mode === "more" ? [...prev.entries, ...entries] : entries,
      next: next_cursor ?? null,
      busy: null,
      failed: null,
      loaded: true,
    }));
  }
  useEffect(() => {
    if (signedIn) void load("first");
    else {
      generation.current += 1;
      setReads(NONE);
    }
  }, [signedIn]);
  async function signIn() {
    if (signingIn) return;
    setSigningIn(true);
    setMessage("");
    let result: string;
    try {
      result = (await plugin.signIn()).result;
    } catch {
      result = "error";
    }
    setSigningIn(false);
    if (result === "signed-in") setSignedIn(true);
    else
      setMessage(
        result === "cancelled"
          ? "Sign-in cancelled."
          : "Unable to sign in. Please try again."
      );
  }
  async function signOut() {
    generation.current += 1;
    setReads(NONE);
    setSignedIn(false);
    setMessage(SIGNED_OUT_MESSAGE);
    try {
      await plugin.signOut();
    } catch {
      // The plugin removes the credential on this device even when the server is unreachable.
    }
  }
  const { busy, failed } = reads;
  const retry = () => {
    if (!failed) return;
    if (failed.mode === "more") void load("more", failed.cursor);
    else void load(failed.mode);
  };
  return (
    <main className="mx-auto max-w-3xl px-6 py-8 text-text [padding-top:max(2rem,env(safe-area-inset-top))] [padding-bottom:max(2rem,env(safe-area-inset-bottom))]">
      <p className="mb-6 text-text-subtle">Prizecheck</p>
      <h1 className="mb-6 text-2xl font-semibold">
        {signedIn ? "Collection" : "Your Collection, with you"}
      </h1>
      {message && (
        <p role="status" className="mb-4">
          {message}
        </p>
      )}
      {signedIn ? (
        <>
          <Button onClick={() => void signOut()}>Sign out</Button>{" "}
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void load("refresh")}
          >
            Refresh
          </Button>
          <CollectionBody
            reads={reads}
            onRetry={retry}
            onMore={(cursor) => void load("more", cursor)}
          />
        </>
      ) : (
        <>
          <p className="mb-4">Sign in to see your Collection.</p>
          <Button disabled={signingIn} onClick={() => void signIn()}>
            Sign in
          </Button>
        </>
      )}
    </main>
  );
}

type Probe =
  | { state: "pending" }
  | { state: "fixture" }
  | { state: "native"; signedIn: boolean };

/**
 * The packaged entry. With no gateway configured (the default build, and every web
 * build) it is the fixture demo; with one, it signs in through the native plugin.
 */
export function IosPrototype(props: {
  source?: CollectionSource;
  session?: FixtureSession;
  plugin?: NativeSignInPlugin;
}) {
  const { plugin = NativeSignIn, ...demo } = props;
  const [probe, setProbe] = useState<Probe>({ state: "pending" });
  useEffect(() => {
    let disposed = false;
    void nativeStatus(plugin).then((status) => {
      if (disposed) return;
      setProbe(
        status.configured
          ? { state: "native", signedIn: status.signedIn }
          : { state: "fixture" }
      );
    });
    return () => {
      disposed = true;
    };
  }, [plugin]);
  if (probe.state === "pending") return null;
  if (probe.state === "native")
    return <NativeMode plugin={plugin} signedInAtStart={probe.signedIn} />;
  return <FixtureDemo {...demo} />;
}
