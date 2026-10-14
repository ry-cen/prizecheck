import type { ReactNode } from "react";

type Props = {
  title: string;
  /** The page's actions, on the right: Add cards, Publish and the like. */
  actions?: ReactNode;
};

/** A page's own header inside the shell: the title (the page's h1) on the left and its actions on the
 * right. Pages on the kit use it; old pages keep their own heading until their redesign ticket. */
export function PageHeader({ title, actions }: Props) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-4">
      <h1 className="m-0 text-display font-semibold">{title}</h1>
      {actions && (
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
