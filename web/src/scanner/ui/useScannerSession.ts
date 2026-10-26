import { useEffect, useRef, useState, type RefObject } from "react";
import type { ScannerProgress } from "../assets/loader";
import type {
  GateReason,
  LockVia,
  OutcomeReason,
  ScannerAssets,
} from "../worker/messages";
import { newGateTracker, trackGate, type GateTracker } from "./hints";
import { chooseDeps, nextAnimationFrame } from "./liveDeps";
import { ScannerSession, type SessionDeps } from "./session";
import type { StartCause } from "./startFailure";

export type Phase =
  /** `progress` is null until something is downloaded: a warm open shows no bar. */
  | { kind: "loading"; progress: ScannerProgress | null }
  | { kind: "running" }
  | { kind: "cannot-start"; cause: StartCause };

export type LockEvent = { lockId: number; printingIds: string[]; via: LockVia };

export type ScannerHandlers = {
  onLock(lock: LockEvent): void;
  onAbsent(lockId: number): void;
  onMiss(): void;
  onAssets?(assets: ScannerAssets): void;
};

export type ScannerControls = {
  phase: Phase;
  /** The camera hint to show now (dark, bright, glare, soft), or null. */
  gate: GateReason | null;
  shutter(): void;
  answer(lockId: number, added: boolean, reason?: OutcomeReason): void;
  setPaused(paused: boolean): void;
};

/** Starts a ScannerSession when `attempt` changes (the first open, or Try again) and stops it with the page. */
export function useScannerSession(
  video: RefObject<HTMLVideoElement | null>,
  handlers: ScannerHandlers,
  attempt: number,
  depsOverride?: SessionDeps
): ScannerControls {
  const [phase, setPhase] = useState<Phase>({
    kind: "loading",
    progress: null,
  });
  const [tracker, setTracker] = useState<GateTracker>(newGateTracker);
  const session = useRef<ScannerSession | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const paused = useRef(false);

  useEffect(() => {
    let live = true;
    setPhase({ kind: "loading", progress: null });
    setTracker(newGateTracker());
    void (async () => {
      const deps = depsOverride ?? (await chooseDeps());
      const element = video.current;
      if (!live || !element) return;
      const s = new ScannerSession(
        { ...deps, tick: deps.tick ?? nextAnimationFrame },
        {
          onProgress: (progress) =>
            setPhase((p) =>
              p.kind === "loading" ? { kind: "loading", progress } : p
            ),
          onAssets: (assets) => handlersRef.current.onAssets?.(assets),
          onRunning: () => setPhase({ kind: "running" }),
          onCannotStart: (cause) => setPhase({ kind: "cannot-start", cause }),
          onGate: (ok, reason) => setTracker((t) => trackGate(t, ok, reason)),
          onLock: (lock) => handlersRef.current.onLock(lock),
          onAbsent: (id) => handlersRef.current.onAbsent(id),
          onMiss: () => handlersRef.current.onMiss(),
        },
        element
      );
      session.current = s;
      s.setPaused(paused.current);
      void s.start();
    })();
    return () => {
      live = false;
      session.current?.dispose();
      session.current = null;
    };
  }, [attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    phase,
    gate: phase.kind === "running" ? tracker.shown : null,
    shutter: () => session.current?.shutter(),
    answer: (lockId, added, reason) =>
      session.current?.answer(lockId, added, reason),
    setPaused: (p) => {
      paused.current = p;
      session.current?.setPaused(p);
    },
  };
}
