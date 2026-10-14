# Resolution — Sign-in, Sign-ins page, messages and loading

**Owner confirmed:** 2026-10-12

**Ticket:** [Prototype sign-in and loading screens](https://github.com/ry-cen/prizecheck/issues/140)

**Evidence:** [sign-in prototype notes](../prototypes/sign-in/README.md). Variant A was chosen out of three, with B's tagline as its subtitle.

**Feeds:** [Spec: OAuth sign-in with Google and Discord](https://github.com/ry-cen/prizecheck/issues/147). That spec fixes the behaviour. This decision fixes the layout and the wording it left to the redesign.

## Decision

### Sign-in screen: a centred card

- **Where.** Under the slim public header (wordmark and Discover decks), the page shows one centred card, 400 px wide on desktop and full width on a phone.
- **What the card holds, top to bottom:**
  - the heading **Sign in to PrizeCheck**;
  - the subtitle **Know every card you own, and where it is.** When the collector was sent here from a protected page, the subtitle reads **Sign in to continue where you left off.** instead;
  - the failure message, when there is one;
  - one button per configured provider;
  - the email form, only when email sign-in is on;
  - a short line about terms and privacy.
- **Provider buttons.** Each is a plain link to `/auth/sign-in/:provider` (with `next` when there is one), stacked full width, 40 px tall on desktop and 44 px on a phone.
  - They're drawn from `GET /auth/methods`, with a per-provider asset map. A provider with no entry gets a generic button with its initial, so adding a provider needs no page change.
  - **Google** follows Google's dark-theme rules: fill #131314, a 1 px #8E918F stroke, #E3E3E3 text, the standard-colour G, and "Continue with Google".
  - **Discord** uses blurple #5865F2 with Discord's white logo, unmodified, and "Continue with Discord".
  - Ship each company's downloaded asset, not the prototype's marks.
- **Email form, when on.** It sits below an "or" divider:
  1. Email, then **Email me a code**.
  2. "We sent a six-digit code to …", the code field, then **Sign in**.
  3. **Use a different email** and **Send a new code** sit under the code field.
- **Not taken forward:**
  - **B, split showcase:** a brand panel beside the sign-in panel. Only its tagline was kept.
  - **C:** sign-in as a dialog over Discover.

### Failure messages: final wording

Each message is mapped from the `error` code through the spec's allowlist. It's shown as an alert directly above the buttons and focused once. Then `error` and `error_description` are removed from the address bar. Provider free text is never shown. A message has a bold title and a muted follow-up line. Where a provider is named, it's the configured display name.

| Group | Title | Follow-up | Next step |
| --- | --- | --- | --- |
| Cancelled | Sign-in was cancelled. | Nothing was changed. Choose a way to sign in below. | The buttons |
| Not open yet | PrizeCheck isn't open to new collectors yet. | Sign-ups open once testing is done. Until then, anyone can browse public decks. | A **Browse public decks** link |
| Needs a verified email | Your {Provider} account needs a verified email address. | Verify your email with {Provider}, then try again, or choose another way to sign in. | The buttons |
| Belongs to another account (Sign-ins page only) | That {Provider} sign-in is already connected to a different PrizeCheck account. | Sign in with that account to manage it, or connect a different one here. | **Back to Sign-ins** |
| Sign in again (Sign-ins page only) | For your security, sign in again to change your sign-ins. | You'll come straight back here afterwards. | **Sign in again**, returning to the Sign-ins page |
| Too many attempts | Too many sign-ins right now. | Try again in a little while. | None |
| Didn't complete | Sign-in didn't complete. | Try again. If it keeps happening, try another way to sign in. | The buttons |

- **Not open yet** is styled as calm news (the gold accent wash), not as an error. Under the owner-only default, every non-owner sees it.
- Every other message uses the danger colours.
- The two groups for the Sign-ins page only read as "Didn't complete" on the sign-in page.

### Sign-ins page

- **Where.** It's a page in the shell, titled **Sign-ins**. It's reached from the avatar menu on desktop and the More sheet on a phone, listed above Owner controls and Sign out.
- **What it shows:**
  - "Your account email: …" once at the top;
  - one row per configured provider: its mark, its name, and "Connected <date>" or "Not connected";
  - **Connect** (a link) on an unconnected row;
  - **Remove** on a connected row, only when more than one sign-in is connected;
  - a closing line: "You can sign in with any connected account. Your last sign-in can't be removed."
- **Messages.** Its own messages appear above the list, using the same alert.
- **The avatar** follows the OAuth spec: the provider picture, or the first letter of the email.

### Loading and first paint

- **First paint.** `web/index.html` carries an inline style, `html { background: #121110; color-scheme: dark }`, plus `color-scheme` and `theme-color` meta tags. It also puts a static "✦ PrizeCheck" wordmark inside `#root`, which React replaces. So the page is dark before any script or stylesheet loads. The colours copy `tokens.css` values and must be kept in step with them.
- **Loading.** While the session resolves, the dark page shows the same muted wordmark. "Loading…" appears only after 600 ms. There are no placeholder tiles and no skeleton of the shell, so there's nothing to flash or resize.

### Unavailable and not found

Both are centred cards under the slim public header.

- **Unavailable:** **This deck isn't published anymore**, with "Its owner stopped sharing it, or the link changed. Published decks are snapshots, so an old link can stop working."
- **Not found:** **Page not found**, with "The link may be mistyped, or the page has moved."
- Both offer **Discover decks** (primary) and **Sign in**.

## Not decided here

- **The rollout order for first paint.** A page still on the old light UI would paint dark first and then turn light. [Decide rollout and verification](https://github.com/ry-cen/prizecheck/issues/141) orders this change, or makes it route-aware until every page is dark.
- **The terms and privacy line** points at pages that don't exist yet. The spec should say whether it ships, or waits for those pages.
