# Decide what the sign-in page says when sign-in fails

Resolved 2026-10-12 for [Decide what the sign-in page says when sign-in fails](https://github.com/ry-cen/prizecheck/issues/144). This is a technical choice the owner delegated to Claude. Error codes come from `oauth2/errors.mjs`, `state.mjs` and `api/routes/callback.mjs` in the installed Better Auth 1.7.6, plus the gates already decided.

## Decisions

1. **Few messages, chosen from an allowlist.** The sign-in page and `/settings/sign-ins` map the `error` code to one of the message groups below. Any code they don't recognise falls into "Didn't complete". The provider's `error_description` and any other free text in the URL are **never shown**: they're untrusted input. After reading the code, the page removes it from the address bar, so reloading or sharing the page shows no stale error.
2. **The copy is provider-neutral.** Where a provider is named, it's the configured display name for the provider the attempt used, so a new provider needs no new copy.

| Group | Codes | Message (gist) | Next step offered |
|---|---|---|---|
| **Cancelled** | `access_denied` (from the provider) | Sign-in was cancelled. | The sign-in buttons |
| **Not open yet** | The gate's single owner-only refusal code, `signup_disabled` | PrizeCheck isn't open for new sign-ins yet. | None. It says nothing about any account. |
| **Needs a verified email** | `email_not_found`, `email_not_verified` | Your {Provider} account needs a verified email address. | Verify it with {Provider}, or use another sign-in |
| **Belongs to another account** (settings page only) | `account_already_linked_to_different_user` | That {Provider} sign-in is already connected to a different PrizeCheck account. | Back to Sign-ins |
| **Sign in again** (settings page only) | The gateway's stale-session refusal for link and unlink | For your security, sign in again to change your sign-ins. | Sign in, then return to `/settings/sign-ins` |
| **Too many attempts** | The refusal from [Decide limits on OAuth account creation](https://github.com/ry-cen/prizecheck/issues/145) | Too many sign-ins right now. Try again later. | None |
| **Didn't complete** | Everything else: `invalid_code`, `no_code`, every `state_*`, `please_restart_the_process`, `unable_to_get_user_info`, `oauth_provider_not_found`, `unable_to_link_account`, `unable_to_create_user`, `account_not_linked`, `email_does_not_match`, unknown codes | Sign-in didn't complete. | Try again |

3. **Some codes shouldn't happen, and they all get "Didn't complete".**
   - `account_not_linked` can't happen under the linking rules. Every local account has a verified email, because unverified creation is refused and email codes verify.
   - `email_does_not_match` can't happen once `allowDifferentEmails` is on.

   Both are grouped there, so no message hints at whether an account exists.
4. **The owner-only refusal never names an account.** The "Not open yet" message is about the app, not the person, and it's identical whether or not the email matches an existing collector.
5. **The message is accessible.** It's announced as an alert, takes focus once, and keeps the sign-in buttons reachable right below it.

## Consequences for the spec

- The gate's single owner-only refusal code needs a fixed name in the spec, for example `sign_in_unavailable`.
- Tests assert the following for each group:
  - the mapped message;
  - an unknown code shows "Didn't complete";
  - `error_description` is never rendered;
  - the code is removed from the URL after display.
- The final wording belongs with the app-redesign map's sign-in screen work. This table fixes what each message must say, not its exact text.
