import { useEffect, useState, useSyncExternalStore } from "react";
import { requestPersistOnce } from "../assets/persist";
import { openTray, type TrayState, type TrayStore } from "../tray/store";

/** Opens this account's tray (null until it has been read) and closes it with the page. */
export function useTrayStore(userId: string): TrayStore | null {
  const [store, setStore] = useState<TrayStore | null>(null);
  useEffect(() => {
    let live = true;
    let opened: TrayStore | null = null;
    void openTray(userId, {
      onFirstRowAdded: () => void requestPersistOnce(),
    }).then((s) => {
      if (live) {
        opened = s;
        setStore(s);
      } else s.dispose();
    });
    return () => {
      live = false;
      opened?.dispose();
    };
  }, [userId]);
  return store;
}

export function useTrayState(store: TrayStore): TrayState {
  return useSyncExternalStore(store.subscribe, store.getState);
}

/** Total copies in the tray. */
export const copiesIn = (state: TrayState): number =>
  state.tray.rows.reduce((n, r) => n + r.count, 0);

/** Reads the printings again on tray open and when the connection returns, so rows get fresh names and art, stale rows
 * are marked, and an outage lifts. */
export function useTrayRefresh(store: TrayStore, trigger: unknown): void {
  useEffect(() => {
    void store.refreshStale();
  }, [store, trigger]);
  useEffect(() => {
    const online = () => void store.refreshStale();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [store]);
}
