import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Settings section navigation (#326). A collector who asks for a Settings section (the account sheet's Sign-ins)
 * means "show me that section", not "scroll once". This module owns that intent: it keeps the requested section until
 * every Settings section above it has finished loading (the sections grow when their data arrives, and would push the
 * target out of view), then scrolls to the section, moves focus to its heading, and only then clears the request.
 *
 * The request is also dropped when the collector starts using the page themselves (a tap, a key, a wheel or a touch
 * drag in the page area), when they leave Settings, and it is met anyway after SETTINGS_SECTION_DEADLINE_MS, so a
 * stalled request cannot leave them at the top of the page.
 */

/** The Settings sections that load data and so change the page's height; the page is ready once all have settled. */
export const SETTINGS_LOADING_SECTIONS = [
  "want-list-counting",
  "blocked",
  "privacy",
  "hidden-locations",
  "for-trade-locations",
  "open-discovery",
] as const;

export type SettingsLoadingSection = (typeof SETTINGS_LOADING_SECTIONS)[number];

/** How long after the request the section is shown even if some Settings section has not settled. */
export const SETTINGS_SECTION_DEADLINE_MS = 5000;

const COLLECTOR_INPUT = ["pointerdown", "keydown", "wheel", "touchmove"];

type Scope = (section: SettingsLoadingSection, settled: boolean) => void;

const SettingsReadiness = createContext<Scope | null>(null);
export const SettingsNavigationScope = SettingsReadiness;

/**
 * A Settings section calls this with whether it has settled (loaded or failed to load). Outside the shell it does
 * nothing, and the shell only acts on the reports while a section is requested.
 */
export function useSettingsSectionSettled(
  section: SettingsLoadingSection,
  settled: boolean
) {
  const report = useContext(SettingsReadiness);
  useEffect(() => {
    report?.(section, settled);
  }, [report, section, settled]);
  // A section that unmounts is no longer settled: Settings is not on screen, so a later visit waits again.
  useEffect(() => () => report?.(section, false), [report, section]);
}

/**
 * Used once by the shell. `settingsShown` is whether Settings is the page on screen. `request(sectionId)` asks for the
 * section with that element id; the returned `scope` goes in `SettingsNavigationScope` around the pages.
 *
 * The settled sections are kept in a ref: a report re-renders the shell only while a request waits for it.
 */
export function useSettingsNavigation(settingsShown: boolean) {
  const [requested, setRequested] = useState<string | null>(null);
  const [, setReports] = useState(0);
  const settled = useRef(new Set<SettingsLoadingSection>());
  const waiting = useRef(false);
  waiting.current = requested !== null;
  const report = useCallback<Scope>((section, isSettled) => {
    if (settled.current.has(section) === isSettled) return;
    if (isSettled) settled.current.add(section);
    else settled.current.delete(section);
    if (waiting.current) setReports((count) => count + 1);
  }, []);
  const ready = SETTINGS_LOADING_SECTIONS.every((section) =>
    settled.current.has(section)
  );

  const show = useCallback((sectionId: string): boolean => {
    const target = document.getElementById(sectionId);
    if (!target) return false;
    target.scrollIntoView({ block: "start" });
    target
      .querySelector<HTMLElement>("h2[tabindex]")
      ?.focus({ preventScroll: true });
    setRequested(null);
    return true;
  }, []);

  // After the page's own scroll reset (the shell's layout effect), and once the sections above have their final size.
  useEffect(() => {
    if (requested && settingsShown && ready) show(requested);
  }, [requested, settingsShown, ready, show]);

  // The deadline: show the section even if a request is slow or stalled.
  useEffect(() => {
    if (!requested || !settingsShown) return;
    // Dropped even when the section is missing, so a request never waits on with its input listeners attached.
    const timer = setTimeout(() => {
      if (!show(requested)) setRequested(null);
    }, SETTINGS_SECTION_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [requested, settingsShown, show]);

  // The collector's own input in the page area cancels the request, so a late jump never takes the page from them.
  useEffect(() => {
    if (!requested || !settingsShown) return;
    const cancel = (event: Event) => {
      if (!event.isTrusted) return;
      const target = event.target;
      if (target instanceof Element && target.closest("dialog")) return;
      setRequested(null);
    };
    for (const type of COLLECTOR_INPUT)
      document.addEventListener(type, cancel, { capture: true, passive: true });
    return () => {
      for (const type of COLLECTOR_INPUT)
        document.removeEventListener(type, cancel, { capture: true });
    };
  }, [requested, settingsShown]);

  // Leaving Settings before the request was met drops it, so a later visit does not jump.
  const wasShown = useRef(false);
  useEffect(() => {
    if (settingsShown) wasShown.current = true;
    else if (wasShown.current) {
      wasShown.current = false;
      setRequested(null);
    }
  }, [settingsShown]);

  const request = useCallback(
    (sectionId: string) => setRequested(sectionId),
    []
  );
  // Any other navigation drops the request too, including one a leave guard refused before Settings was shown.
  const cancel = useCallback(() => setRequested(null), []);
  return useMemo(
    () => ({ request, cancel, scope: report }),
    [request, cancel, report]
  );
}
