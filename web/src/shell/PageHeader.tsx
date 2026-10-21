import type { ReactNode, Ref } from "react";

type Props = {
  title: string;
  /** The h1, for a page that moves focus to it (it then takes focus by script only: tabIndex -1). */
  headingRef?: Ref<HTMLHeadingElement>;
  /** The page's actions, on the right (under the title, left-aligned, on a phone): Add cards, Publish and the like. */
  actions?: ReactNode;
  /** Beside the title: the deck builder's Rename. */
  titleAction?: ReactNode;
  /** Shown in the title's place while it is edited; the h1 stays, visually hidden, for screen readers. */
  titleEditor?: ReactNode;
};

/** A page's own header inside the shell: the title (the page's h1) on the left and its actions on the
 * right. Pages on the kit use it; old pages keep their own heading until their redesign ticket. */
export function PageHeader({
  title,
  actions,
  headingRef,
  titleAction,
  titleEditor,
}: Props) {
  const heading = (
    <h1
      ref={headingRef}
      tabIndex={headingRef ? -1 : undefined}
      className={titleEditor ? "sr-only" : "m-0 text-display font-semibold"}
    >
      {title}
    </h1>
  );
  return (
    <div className="mb-5 flex flex-wrap items-center gap-4">
      {titleAction || titleEditor ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {heading}
          {titleEditor ?? titleAction}
        </div>
      ) : (
        heading
      )}
      {actions && (
        <div className="ml-auto flex flex-wrap items-center gap-2 phone:ml-0 phone:basis-full">
          {actions}
        </div>
      )}
    </div>
  );
}
