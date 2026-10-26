// The toast a confirmed tray leaves for the app. The scanner is its own page, so Confirm leaves by a full navigation and
// the Collection page it lands on shows the toast: the message waits in sessionStorage for exactly one read, and is
// dropped if the page it was left for never read it (a minute is long enough for any navigation).
const KEY = "prizecheck:scanner:landing";
export const LANDING_MAX_AGE_MS = 60_000;

export function leaveToast(
  message: string,
  storage: Pick<Storage, "setItem"> | null = safeStorage(),
  now: number = Date.now()
): void {
  try {
    storage?.setItem(KEY, JSON.stringify({ message, at: now }));
  } catch {
    // No toast, still the right page.
  }
}

/** The waiting message, once, if it is recent. */
export function takeLandingToast(
  storage: Pick<Storage, "getItem" | "removeItem"> | null = safeStorage(),
  now: number = Date.now()
): string | null {
  try {
    const raw = storage?.getItem(KEY) ?? null;
    if (raw === null) return null;
    storage?.removeItem(KEY);
    const parsed = JSON.parse(raw) as { message?: unknown; at?: unknown };
    if (
      typeof parsed.message !== "string" ||
      typeof parsed.at !== "number" ||
      now - parsed.at > LANDING_MAX_AGE_MS ||
      parsed.at > now + LANDING_MAX_AGE_MS
    )
      return null;
    return parsed.message || null;
  } catch {
    return null;
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}
