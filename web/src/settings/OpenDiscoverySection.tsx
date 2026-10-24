import { useEffect, useId, useState } from "react";
import {
  getDiscovery,
  setDiscovery,
  SocialError,
  type DiscoverySettings,
  type SetDiscovery,
} from "../social_generated";
import { Button } from "../ui/Button";
import { TextField } from "../ui/TextField";
import {
  ACCOUNT_SUSPENDED_NOTE,
  changesLeft,
  DISCOVERY_CREDIT,
  DISCOVERY_HEADING,
  DISCOVERY_HELP,
  DISCOVERY_LOAD_FAILED,
  DISCOVERY_OFF,
  DISCOVERY_ON,
  DISCOVERY_REMOVED,
  discoveryMessage,
  ZIP_LABEL,
  ZIP_SAVE,
  ZIP_SAVED,
} from "./discoveryMessages";

type Load =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; settings: DiscoverySettings };

/**
 * Settings › Open discovery (Trading #297, Stage 2 spec "Open discovery switch"). The switch lets collectors who are
 * not Friends find the collector by zip code; the section holds the collector's own zip, how many zip changes are
 * left today, the sentence for a removed or suspended account, and the GeoNames credit. It shows nothing about other
 * collectors, no radius and no distances.
 */
export function OpenDiscoverySection() {
  const headingId = useId();
  const helpId = useId();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    getDiscovery(controller.signal).then(
      (settings) => {
        if (controller.signal.aborted) return;
        setLoad({ kind: "ready", settings });
        setDraft(settings.zip ?? "");
      },
      () => {
        if (!controller.signal.aborted) setLoad({ kind: "failed" });
      }
    );
    return () => controller.abort();
  }, [attempt]);

  async function save(body: SetDiscovery, done: string) {
    if (pending) return;
    setPending(true);
    setNotice("");
    setSaved("");
    try {
      const settings = await setDiscovery(body);
      setLoad({ kind: "ready", settings });
      setDraft(settings.zip ?? "");
      setSaved(done);
    } catch (cause) {
      if (
        cause instanceof SocialError &&
        (cause.code === "DISCOVERY_UNAVAILABLE" ||
          cause.code === "ACCOUNT_SUSPENDED")
      )
        setAttempt((n) => n + 1);
      else setNotice(discoveryMessage(cause));
    } finally {
      setPending(false);
    }
  }

  const heading = (
    <h2 id={headingId} className="m-0 text-heading font-semibold">
      {DISCOVERY_HEADING}
    </h2>
  );

  if (load.kind === "loading")
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        {heading}
      </section>
    );
  if (load.kind === "failed")
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        {heading}
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="m-0 text-body text-danger">
            {DISCOVERY_LOAD_FAILED}
          </p>
          <Button
            onClick={() => {
              setLoad({ kind: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </Button>
        </div>
      </section>
    );

  const { settings } = load;
  const blocked =
    settings.status === "removed" || settings.status === "suspended";
  const trimmed = draft.trim();

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      {heading}
      <p id={helpId} className="m-0 text-meta text-text-muted">
        {DISCOVERY_HELP}
      </p>
      {blocked && (
        <p className="m-0 text-body text-text">
          {settings.status === "suspended"
            ? ACCOUNT_SUSPENDED_NOTE
            : DISCOVERY_REMOVED}
        </p>
      )}
      <div className="flex flex-col gap-1 rounded-panel border border-border bg-surface px-4 py-3">
        <label className="flex min-h-control cursor-pointer items-center gap-2 text-body font-medium text-text phone:min-h-tap">
          <input
            type="checkbox"
            role="switch"
            className="m-0 size-4 shrink-0 accent-accent"
            aria-describedby={helpId}
            aria-busy={pending || undefined}
            checked={settings.status === "on"}
            disabled={blocked || pending}
            onChange={(event) => {
              if (event.currentTarget.checked) {
                const body: SetDiscovery = { enabled: true };
                if (trimmed !== "" && trimmed !== settings.zip)
                  body.zip = trimmed;
                void save(body, DISCOVERY_ON);
              } else void save({ enabled: false }, DISCOVERY_OFF);
            }}
          />
          {DISCOVERY_HEADING}
        </label>
      </div>
      {!blocked && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save({ zip: trimmed }, ZIP_SAVED);
          }}
        >
          <TextField
            label={ZIP_LABEL}
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={10}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <Button
            type="submit"
            disabled={pending || trimmed === "" || trimmed === settings.zip}
          >
            {ZIP_SAVE}
          </Button>
        </form>
      )}
      {settings.zip && !blocked && (
        <p className="m-0 text-meta text-text-muted">
          {changesLeft(settings.zip_changes_left)}
        </p>
      )}
      {notice && (
        <p role="alert" className="m-0 text-meta text-danger">
          {notice}
        </p>
      )}
      {saved && (
        <p role="status" className="m-0 text-meta text-text-muted">
          {saved}
        </p>
      )}
      <p className="m-0 text-meta text-text-muted">{DISCOVERY_CREDIT}</p>
    </section>
  );
}
