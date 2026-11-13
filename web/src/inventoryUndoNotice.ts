import { dismissUndo } from "./inventoryUndo";
import { MoveError } from "./moves_generated";

/** One DELETE per record is shared page-wide. A turn may show a delayed notice
 * only while no other owner has shown since. */
export type DismissOutcome = "dismissed" | "failed";
export type UndoDismissals = {
  dismiss: (id: string) => Promise<DismissOutcome>;
  blocks: (id: string) => boolean;
  reset: () => void;
};
export function createUndoDismissals(
  remove: (id: string) => Promise<void> = (id) => dismissUndo(id)
): UndoDismissals {
  const open = new Map<string, Promise<DismissOutcome>>(),
    gone = new Set<string>();
  return {
    dismiss(id) {
      if (gone.has(id)) return Promise.resolve("dismissed");
      const running = open.get(id);
      if (running) return running;
      const request = new Promise<void>((done) => done(remove(id)))
        .then(
          (): DismissOutcome => "dismissed",
          (cause): DismissOutcome =>
            cause instanceof MoveError && cause.status === 404
              ? "dismissed"
              : "failed"
        )
        .then((outcome) => {
          open.delete(id);
          if (outcome === "dismissed") gone.add(id);
          return outcome;
        });
      open.set(id, request);
      return request;
    },
    blocks: (id) => open.has(id) || gone.has(id),
    reset() {
      open.clear();
      gone.clear();
    },
  };
}
export const undoDismissals = createUndoDismissals();
export type NoticeClock = { getVersion: () => number };
/** Free while nobody has shown since the start, or the newest show is this owner's own. */
export function noticeTurn(
  clock: NoticeClock,
  ownLatest: () => number | null
): () => boolean {
  const start = clock.getVersion();
  return () => {
    const now = clock.getVersion();
    return now === start || now === ownLatest();
  };
}
