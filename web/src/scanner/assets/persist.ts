// Storage persistence (D9): ask once per device, after the first row of a tray is added, and never again.
const ASKED_KEY = "prizecheck:scanner:persist-asked";

/**
 * Call after the first tray row is written. Asks `navigator.storage.persist()` only when `persisted()` is false and
 * this device has not asked before; a refusal is final. Never throws and never shows anything.
 */
export async function requestPersistOnce(): Promise<void> {
  try {
    if (localStorage.getItem(ASKED_KEY) !== null) return;
    const storage = navigator.storage;
    if (!storage || typeof storage.persist !== "function") return;
    // Record first, so a crash or a second tab cannot ask twice; if the flag cannot be kept, do not ask at all.
    localStorage.setItem(ASKED_KEY, "1");
    if (typeof storage.persisted === "function" && (await storage.persisted()))
      return;
    await storage.persist();
  } catch {
    // Persistence is best effort.
  }
}
