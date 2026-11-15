import React, { useEffect, useState } from "react";
import { App } from "@capacitor/app";
import { AppLauncher } from "@capacitor/app-launcher";
import { Button } from "../../ui/Button";
import { CopyTile } from "../../ui/CopyTile";
import { variantLabel } from "../../ui/variantLabel";
import { collectionFixture } from "./collectionFixture";
import { FixtureSession } from "./fixtureSession";
import "../../tokens.css";
import "../../tailwind.css";

export function IosPrototype() {
  const [session] = useState(() => new FixtureSession(window.localStorage));
  const [, redraw] = useState(0);
  const [message, setMessage] = useState("");
  const update = () => redraw((value) => value + 1);
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
  const signedIn = session.signedIn();
  return (
    <main className="mx-auto max-w-3xl px-6 py-8 text-text [padding-top:max(2rem,env(safe-area-inset-top))] [padding-bottom:max(2rem,env(safe-area-inset-bottom))]">
      <p className="mb-6 text-text-subtle">
        Prizecheck · Demo with sample cards
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
              session.cancel();
              setMessage("Signed out.");
              update();
            }}
          >
            Sign out
          </Button>
          <ul className="mt-6 grid grid-cols-2 gap-4">
            {collectionFixture.entries.map((entry) => (
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
