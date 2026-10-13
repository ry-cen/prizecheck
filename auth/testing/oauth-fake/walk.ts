// TEST ONLY. Walks start -> fake consent -> callback over plain HTTP, the way a browser would.
import { CONSENT_PATH, IDENTITY_QUERY } from "./core.js";

export type Jar = Map<string, string>;

export function cookieHeader(jar: Jar): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

export function keepCookies(jar: Jar, response: Response): void {
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attributes] = line.split(";");
    const at = pair.indexOf("=");
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    const expired =
      attributes.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
    if (expired) jar.delete(name);
    else jar.set(name, value);
  }
}

export type Walk = {
  start: Response;
  consent: Response | null;
  callback: Response | null;
  location: string | null;
  jar: Jar;
};

/** `base` is where the test reaches the server; it replaces the callback URL's origin (PUBLIC_ORIGIN). */
export async function walkSignIn(
  base: string,
  startPath: string,
  identity: string,
  jar: Jar = new Map()
): Promise<Walk> {
  const startUrl = new URL(startPath, base);
  startUrl.searchParams.set(IDENTITY_QUERY, identity);
  const start = await fetch(startUrl, {
    redirect: "manual",
    headers: { cookie: cookieHeader(jar) },
  });
  keepCookies(jar, start);
  const toConsent = start.headers.get("location");
  if (
    start.status !== 302 ||
    !toConsent ||
    new URL(toConsent, base).pathname !== CONSENT_PATH
  ) {
    return { start, consent: null, callback: null, location: toConsent, jar };
  }
  const consent = await fetch(new URL(toConsent, base), {
    redirect: "manual",
    headers: { cookie: cookieHeader(jar) },
  });
  const forward = consent.headers.get("x-fake-oauth-callback");
  if (consent.status !== 200 || !forward)
    return { start, consent, callback: null, location: null, jar };
  const target = new URL(forward);
  const callback = await fetch(
    new URL(`${target.pathname}${target.search}`, base),
    { redirect: "manual", headers: { cookie: cookieHeader(jar) } }
  );
  keepCookies(jar, callback);
  return {
    start,
    consent,
    callback,
    location: callback.headers.get("location"),
    jar,
  };
}
