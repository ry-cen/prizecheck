# Sign-in and loading screens prototype

This prototype supports [Prototype sign-in and loading screens](https://github.com/ry-cen/prizecheck/issues/140). It is design evidence for development only, not production code.

## Where the code is

The code lives in `web/src/prototypes/sign-in/`, inside the shell prototype, plus the first-paint change in `web/index.html`. It is on the throwaway branch `prototype/sign-in`, cut on top of `prototype/owner-missing`.

- **Run it.** Run `npm run dev:web -- --port 5186 --strictPort` and open `/collection?prototype=shell&auth=A&screen=signin` (or `auth=B` or `C`).
  - **Signed out:** **Sign in** in the public header opens the sign-in screen. **Sign out** in the avatar menu also lands there.
  - **Signed in:** **Sign-ins** is in the avatar menu (desktop) and the More sheet (phone).
- **Switcher.** Its arrows cycle the variants on these screens. Its menu has:
  - `screen`: sign-in, loading, unavailable or not found;
  - `providers`: Google only, plus Discord, or plus an unbranded third provider;
  - **email on**;
  - `error`: arrive on the page with an error code.
- **Data.** In-memory sample data only. A provider link signs you in to the prototype.

## The question

How do sign-in, the Sign-ins page, failure messages and loading look on the shared design system, without a flash of the old light screen?

[Spec: OAuth sign-in with Google and Discord](https://github.com/ry-cen/prizecheck/issues/147) fixes the behaviour and gives this ticket the layout and the wording. The ticket's body was updated on 2026-10-12 to say so.

## What every variant keeps (from the OAuth spec)

- **Provider buttons.** Each is a plain `<a href="/auth/sign-in/:provider?next=…">` link, drawn from the `GET /auth/methods` list. No provider name is written into the page.
  - Google and Discord have brand assets. Any other provider gets a generic button with its initial, so adding one needs no page change.
  - Google's button follows its dark theme: fill #131314, a 1 px #8E918F stroke, #E3E3E3 text, the standard-colour G and "Continue with Google". Discord's uses blurple #5865F2 with the white logo.
  - The prototype's G and Discord marks are placeholders. Ship each company's downloaded asset.
- **The email form only when email sign-in is on** (off by default): Email → "Email me a code" → the six-digit code, "Use a different email" and "Send a new code".
- **Messages.** Each one is:
  - mapped from the `error` code through a fixed allowlist;
  - shown as an alert directly above the buttons, and focused once;
  - followed by `error` and `error_description` being removed from the address bar.

  Provider free text is never shown. The two groups for the Sign-ins page only read as "Didn't complete" on the sign-in page.
- **Sign-ins page,** inside the shell:
  - your account email once at the top;
  - one row per configured provider, showing "Connected <date>" with Remove, or "Not connected" with Connect;
  - Remove appears only when more than one sign-in is connected.

## Message copy (proposed final wording)

| Group | Title | Follow-up line | Next step |
| --- | --- | --- | --- |
| Cancelled | Sign-in was cancelled. | Nothing was changed. Choose a way to sign in below. | The buttons |
| Not open yet | PrizeCheck isn't open to new collectors yet. | Sign-ups open once testing is done. Until then, anyone can browse public decks. | Browse public decks (link) |
| Needs a verified email | Your {Provider} account needs a verified email address. | Verify your email with {Provider}, then try again, or choose another way to sign in. | The buttons |
| Belongs to another account (Sign-ins page) | That {Provider} sign-in is already connected to a different PrizeCheck account. | Sign in with that account to manage it, or connect a different one here. | Back to Sign-ins |
| Sign in again (Sign-ins page) | For your security, sign in again to change your sign-ins. | You'll come straight back here afterwards. | Sign in again (returns to Sign-ins) |
| Too many attempts | Too many sign-ins right now. | Try again in a little while. | None |
| Didn't complete | Sign-in didn't complete. | Try again. If it keeps happening, try another way to sign in. | The buttons |

"Not open yet" is what every non-owner sees under the owner-only default, so it's styled as calm news in the gold accent, not as a red error.

## Variants

- **A — Centred card.**
  - A 400 px card under the slim public header holds the heading, the message, the provider buttons and the email form when it's on.
  - On a phone the card fills the width.
- **B — Split showcase.**
  - On the left, a brand panel: a fan of three cards, "Know every card you own, and where it is." and three things PrizeCheck does.
  - On the right, the sign-in panel.
  - On a phone the brand panel shrinks to a one-line band above the sign-in panel.
- **C — Dialog over Discover.**
  - `/sign-in` shows Discover with a sign-in dialog over it, a bottom sheet on a phone.
  - Closing it leaves you on Discover, and Sign in in the public header reopens it.

## Shared states (one design each, not variants)

- **Loading.** The dark page with a muted "✦ PrizeCheck" wordmark. "Loading…" appears only after 600 ms. There are no placeholder tiles, following the shell decision and [Workspace flashes gray placeholder tiles and jumps in size on every Location switch](https://github.com/ry-cen/prizecheck/issues/121).
- **First paint (decided here, not a variant).** `index.html` sets `html { background: #121110; color-scheme: dark }` in an inline style, adds the `color-scheme` and `theme-color` meta tags, and puts the same static wordmark inside `#root`, which React replaces. So the dark page shows before any script or stylesheet loads.
  - The colours are copies of `tokens.css` values.
  - During rollout, a page still on the light UI would paint dark first and then turn light. [Decide rollout and verification](https://github.com/ry-cen/prizecheck/issues/141) has to order this change, or make it route-aware until every page is dark.
- **Unavailable.** "This deck isn't published anymore", with a short why, and **Discover decks** and **Sign in**.
- **Not found.** "Page not found", with the same two actions.

## Owner verdict — 2026-10-12

1. **Variant A** (centred card), with B's tagline "Know every card you own, and where it is." as the subtitle under "Sign in to PrizeCheck". The prototype shows this on `auth=A`.
2. **The message wording above is final.**
3. **B and C are not taken forward.**
4. The full decision is in [the sign-in and loading resolution](../../resolutions/decide-sign-in-and-loading.md).

## Checks — 2026-10-12

- **Build.**
  - `npx tsc -p web/tsconfig.json --noEmit` passed.
  - `vite build --config web/vite.config.ts` passed, and its output contains none of the prototype's markers.
- **First paint.** The dev server's `/collection` HTML, rendered in a sandboxed frame with scripts blocked, has a #121110 background with `color-scheme: dark` and shows the wordmark.
- **Messages (A, B and C at 1280×800).**
  - `access_denied`, `sign_in_unavailable`, `state_mismatch` and `recent_sign_in_required` each produced the right title, focused the alert, put it before the first button in the DOM and left the address bar clean.
  - `recent_sign_in_required` reads as "Didn't complete" on the sign-in page.
- **Real redirect (C at 375×812).** Opening the page with `?error=sign_in_unavailable&error_description=<b>evil</b>` showed "Not open yet", focused it and removed both parameters. "evil" appears nowhere.
- **Providers.** With three providers the links are `/auth/sign-in/google`, `/discord` and `/github`, and GitHub gets the generic button.
- **Phone, 375×812.**
  - **Sign-in (A, B, C, each with a message):** the alert and the first button are both on screen without scrolling (the first button's bottom edge is at 355, 443 and 520 px). Nothing scrolls sideways, and every link, button and input is at least 44 px.
  - **Loading, unavailable and not found:** nothing scrolls sideways, and every target is at least 44 px.
  - **Sign-ins:**
    - Remove is hidden with one connection and shown after Connect.
    - Both page-only messages render and take focus.
    - Nothing scrolls sideways and every target is at least 44 px.
- **Fixed during the checks.**
  - The old `style.css` leaked into these screens, which render outside the shell's reset: `main` capped the width at 900 px, and `form` drew a white box.
  - The generic button's letter mark was read aloud, and is now hidden from screen readers.
  - The header wordmark link was 23 px tall on a phone.
- **Not verified.** Real provider redirects, the real network order of first paint under throttling (the sandboxed frame stands in for it), and screen-reader announcement of the focused alert.
