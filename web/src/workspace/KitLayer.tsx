import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Draws Collection's kit surfaces (its dialogs and the Actions strip, #165) at the end of <body>. Inside
 * the page they would sit under .legacy and .ws-root, whose unlayered element rules (style.css and
 * Workspace.css) beat every Tailwind utility on a button, input or label. The wrapper gives them the
 * kit's font, text colour and dark color-scheme, as the shell's root does. Outside the page they are not
 * hidden with it, so callers draw them only while Collection is the shown page.
 */
export function KitLayer({ children }: { children: ReactNode }) {
  return createPortal(
    <div className="font-sans text-text scheme-dark">{children}</div>,
    document.body
  );
}
