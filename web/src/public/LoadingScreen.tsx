import { useEffect, useState } from "react";
import "./public.css";

/** How long the loading screen shows only the wordmark before it says "Loading…", so a quick load shows no text. */
const LOADING_TEXT_DELAY_MS = 600;

/**
 * While the session resolves (spec "Loading"): the dark page with a muted wordmark, and "Loading…" only after
 * 600 ms. No placeholder tiles and no skeleton of the shell, so nothing flashes or resizes when the page arrives.
 */
export function LoadingScreen({ message }: { message: string }) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setLate(true), LOADING_TEXT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div
      data-signed-out-screen=""
      className="flex min-h-dvh items-center justify-center bg-bg font-sans text-text scheme-dark"
    >
      <main className="flex flex-col items-center gap-2 px-5 text-center">
        <p className="m-0 text-heading font-bold text-text-muted">
          <span aria-hidden="true">✦ </span>PrizeCheck
        </p>
        <p role="status" className="m-0 text-meta text-text-muted">
          {late && !message ? "Loading…" : ""}
        </p>
        <p role="alert" className="m-0 text-meta text-danger">
          {message}
        </p>
      </main>
    </div>
  );
}
