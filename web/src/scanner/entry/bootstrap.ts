import { SIGN_IN_FALLBACK_PATH } from "./paths";

export type ScannerSession = { signedIn: boolean; userId: string | null };

export type ScannerStart =
  | { kind: "ready"; userId: string }
  | { kind: "signed-out" }
  | { kind: "unavailable" };

/**
 * Reads the signed-in user from the session cookie, as web/src/main.tsx does. The tray key needs the user id. A
 * response that is not a signed-in session with a user id counts as signed out; a failed read is "unavailable".
 */
export async function startScanner(
  fetchSession: typeof fetch = fetch
): Promise<ScannerStart> {
  try {
    const response = await fetchSession("/auth/session", {
      credentials: "same-origin",
    });
    if (!response.ok) return { kind: "unavailable" };
    const session = (await response.json()) as Partial<ScannerSession>;
    if (
      session.signedIn === true &&
      typeof session.userId === "string" &&
      session.userId
    )
      return { kind: "ready", userId: session.userId };
    return { kind: "signed-out" };
  } catch {
    return { kind: "unavailable" };
  }
}

/** Signed out, the scanner leaves for Collection, which shows the app's signed-out screens. There is no return to
 * the scanner afterwards. */
export function leaveForSignIn(
  assign: (path: string) => void = (path) => location.assign(path)
): void {
  assign(SIGN_IN_FALLBACK_PATH);
}
