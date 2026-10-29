import { useEffect, useId, useRef, useState } from "react";
import {
  getSettings,
  setWantListCounting,
  SettingsError,
  type AccountSettings,
  type WantListCounting,
} from "../settings_generated";
import { COUNTING_OPTIONS, countingLabel } from "./wantListCounting";
import { useSettingsSectionSettled } from "./settingsNavigation";

type Load =
  | { kind: "loading" }
  | { kind: "ready"; settings: AccountSettings }
  | { kind: "failed" };

/**
 * The Settings page's Decks section (#207): the Want List counting setting, stored on the account. Choosing an option
 * saves it at once through its owner command (revision-checked, idempotent), as the deck builder's Target Format does;
 * one change at a time, and a choice made while one is saving is ignored. A change refused because the settings
 * changed somewhere else (409) reads them again and says so; a change that failed for any other reason shows the saved
 * choice again, and choosing the same option at the same revision retries it with the same idempotency key.
 */
export function WantListCountingSection() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  useSettingsSectionSettled("want-list-counting", load.kind !== "loading");
  const [pending, setPending] = useState<WantListCounting | null>(null);
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState("");
  const failed = useRef<{
    value: WantListCounting;
    revision: number;
    key: string;
  } | null>(null);
  // A read started before a command must not overwrite the command's answer.
  const reads = useRef(0);
  const idBase = useId();

  async function read() {
    const ticket = ++reads.current;
    try {
      const settings = await getSettings();
      if (ticket === reads.current) setLoad({ kind: "ready", settings });
    } catch {
      if (ticket === reads.current)
        setLoad((previous) =>
          previous.kind === "ready" ? previous : { kind: "failed" }
        );
    }
  }
  useEffect(() => {
    void read();
  }, []);

  async function change(value: WantListCounting) {
    if (load.kind !== "ready" || pending) return;
    const current = load.settings;
    if (value === current.want_list_counting) return;
    const retry = failed.current;
    const key =
      retry && retry.value === value && retry.revision === current.revision
        ? retry.key
        : crypto.randomUUID();
    failed.current = null;
    setPending(value);
    setNotice("");
    setSaved("");
    reads.current++;
    try {
      const settings = await setWantListCounting({
        want_list_counting: value,
        revision: current.revision,
        idempotency_key: key,
      });
      setLoad({ kind: "ready", settings });
      setSaved(
        `Want List counting set to ${countingLabel(settings.want_list_counting)}.`
      );
    } catch (cause) {
      if (cause instanceof SettingsError && cause.status === 409) {
        await read();
        setNotice(
          "Your settings changed somewhere else, so this change wasn't saved. They're up to date now: try again."
        );
      } else {
        failed.current = { value, revision: current.revision, key };
        setNotice(
          "The setting couldn't be saved. Check your connection and try again."
        );
      }
    } finally {
      setPending(null);
    }
  }

  const headingId = `${idBase}-heading`;
  const shown =
    load.kind === "ready"
      ? (pending ?? load.settings.want_list_counting)
      : null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="m-0 text-heading font-semibold">
        Decks
      </h2>
      {load.kind === "loading" && (
        <p className="m-0 text-meta text-text-muted">Loading…</p>
      )}
      {load.kind === "failed" && (
        <p role="alert" className="m-0 text-danger">
          Your Decks settings are temporarily unavailable. Please retry.
        </p>
      )}
      {load.kind === "ready" && (
        <fieldset
          aria-busy={pending ? true : undefined}
          className="m-0 flex min-w-0 flex-col gap-2 rounded-panel border border-border bg-surface px-4 pb-3 pt-2"
        >
          <legend className="px-1 text-body font-semibold">
            Want List counting
          </legend>
          {COUNTING_OPTIONS.map((option) => {
            const explainerId = `${idBase}-${option.value}`;
            return (
              <div key={option.value} className="flex min-w-0 flex-col">
                <label className="flex min-h-control cursor-pointer items-center gap-2 text-body font-medium text-text phone:min-h-tap">
                  <input
                    type="radio"
                    name={`${idBase}-counting`}
                    value={option.value}
                    checked={shown === option.value}
                    onChange={() => void change(option.value)}
                    aria-describedby={explainerId}
                    className="m-0 size-4 shrink-0 accent-accent"
                  />
                  {option.label}
                </label>
                <p
                  id={explainerId}
                  className="m-0 pl-6 text-meta text-text-muted"
                >
                  {option.explainer}
                </p>
              </div>
            );
          })}
        </fieldset>
      )}
      {notice && (
        <p role="alert" className="m-0 text-meta text-danger">
          {notice}
        </p>
      )}
      <p role="status" className="m-0 text-meta text-text-muted">
        {saved}
      </p>
    </section>
  );
}
