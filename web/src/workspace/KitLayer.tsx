import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Draws Collection's overlay surfaces (its Move, Removal and Add location dialogs and the Actions strip,
 * #165) at the end of <body>, after the shell's toast host, so the Actions list can paint over a toast.
 * The wrapper gives them the kit's font, text colour and dark color-scheme, as the shell's root does.
 * Outside the page they are not hidden with it, so callers draw them only while Collection is the shown
 * page.
 */
export function KitLayer({ children }: { children: ReactNode }) {
  return createPortal(
    <div className="font-sans text-text scheme-dark">{children}</div>,
    document.body
  );
}
