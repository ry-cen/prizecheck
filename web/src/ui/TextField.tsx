import { useCallback, useRef, type ComponentPropsWithRef } from "react";
import { OverlayScrollbarFor } from "./ScrollArea";
import { CONTROL, CONTROL_BOX, FIELD_LABEL } from "./control";

type FieldProps = Omit<ComponentPropsWithRef<"input">, "className"> & {
  /** The visible label above the input, which is also its accessible name. */
  label: string;
};

/** A labelled one-line input (text, URL, a six-digit code): 30 px tall on desktop and 44 px on a phone. */
export function TextField({ label, ...rest }: FieldProps) {
  return (
    <label className={FIELD_LABEL}>
      <span>{label}</span>
      <input className={CONTROL} {...rest} />
    </label>
  );
}

type AreaProps = Omit<ComponentPropsWithRef<"textarea">, "className"> & {
  label: string;
};

/** A labelled text area that grows by hand (a reason, a note). */
export function TextArea({ label, rows = 2, ref, ...rest }: AreaProps) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const setRef = useCallback(
    (element: HTMLTextAreaElement | null) => {
      own.current = element;
      if (typeof ref === "function") ref(element);
      else if (ref) ref.current = element;
    },
    [ref]
  );
  return (
    <label className={FIELD_LABEL}>
      <span>{label}</span>
      <div className="relative flex flex-col">
        <textarea
          rows={rows}
          className={`${CONTROL_BOX} min-h-16 resize-y py-1.5`}
          {...rest}
          ref={setRef}
        />
        <OverlayScrollbarFor target={own} clearGrip />
      </div>
    </label>
  );
}
