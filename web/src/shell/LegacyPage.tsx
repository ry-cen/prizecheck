import type { ReactNode } from "react";

type Props = {
  /** The page's h1. */
  title: string;
  /** The app's last service message, shown under the page as before. */
  message: string;
  children: ReactNode;
};

/** An old page inside the shell, unchanged: the old light look (style.css, which only reaches inside
 * .legacy) on a light surface, with its heading on the left of its own header. Deleted with style.css in
 * rollout stage 7, once every page is on the kit. */
export function LegacyPage({ title, message, children }: Props) {
  return (
    <div className="legacy legacy-light">
      <main>
        <header>
          <h1>{title}</h1>
        </header>
        {children}
        <p role="alert">{message}</p>
      </main>
    </div>
  );
}
