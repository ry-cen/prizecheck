/** The scanner stays TCGdex-only: other art hosts (the catalog's fallback art) send no CORS header, so under this page's
 * cross-origin isolation they cannot load as crossorigin="anonymous" images. Those cards show the placeholder. */
export function tcgdexArt(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host === "tcgdex.net" || host.endsWith(".tcgdex.net") ? url : null;
  } catch {
    return null;
  }
}
