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
    const update = () => {
      const heading = root?.querySelector("h1")?.textContent?.trim() ?? "";
      const label = normalize(heading) || fallback;
      document.title = label === "PrizeCheck" ? label : `${label} · PrizeCheck`;
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
