import { SCANNER_PATH } from "../scanner/route";

/** Opens the card scanner. It is its own page (a separate HTML entry served with cross-origin isolation), so every
 * entry goes there by a full navigation, never by the client router. */
export function openScanner(): void {
  location.assign(SCANNER_PATH);
}
