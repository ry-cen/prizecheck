/** The scanner is its own page, not a route of the app: it is a separate HTML entry (web/scan.html) that nginx and the
 * Vite dev server serve here with cross-origin isolation. The shell only builds the link, and always with a full
 * navigation (`location.assign`), never client-side routing. */
export const SCANNER_PATH = "/collection/scan";
