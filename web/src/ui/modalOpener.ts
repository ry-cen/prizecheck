/** The control that opened each modal dialog, so a navigation started inside it knows the opener it returns focus to. */
const openers = new WeakMap<Element, Element>();

/** Record `opener` as the control the open `dialog` returns focus to when it closes. */
export function noteModalOpener(dialog: Element, opener: Element): void {
  openers.set(dialog, opener);
}

/** The opener of the modal dialog that contains `element`, if it is inside one that recorded its opener. */
export function modalOpenerOf(element: Element): Element | null {
  const dialog = element.closest("dialog[open], [aria-modal='true']");
  return (dialog && openers.get(dialog)) || null;
}
