import { useEffect } from "react";

/** Shared by public and signed-in frames, including headings rendered after async reads. */
export function usePageTitle(
  container: () => HTMLElement | null | undefined,
  fallback: string,
  key: string,
  normalize: (heading: string) => string = (heading) => heading
): void {
  useEffect(() => {
    const root = container();
    let heading: HTMLHeadingElement | null = null;
    const update = (records?: MutationRecord[]) => {
      if (!heading || !root?.contains(heading))
        heading = root?.querySelector("h1") ?? null;
      else if (
        records &&
        !records.some((record) => heading!.contains(record.target))
      )
        return;
      const label = normalize(heading?.textContent?.trim() ?? "") || fallback;
      const title = label === "PrizeCheck" ? label : `${label} · PrizeCheck`;
      if (document.title !== title) document.title = title;
    };
    update();
    const observer = new MutationObserver(update);
    if (root)
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    return () => {
      observer.disconnect();
      document.title = "PrizeCheck";
    };
  }, [key, fallback]);
}
