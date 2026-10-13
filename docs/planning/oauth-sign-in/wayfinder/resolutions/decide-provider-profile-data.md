# Decide which provider profile data to keep

Resolved 2026-10-12 for [Decide which provider profile data to keep](https://github.com/ry-cen/prizecheck/issues/133). The owner decided what collectors see (decision 1). The rest is technical, delegated to Claude. Facts come from [Google and Discord sign-in under Better Auth](../research/google-discord-better-auth.md), sections 1 and 6, and from `oauth2/link-account.mjs` and `api/routes/callback.mjs` in the installed Better Auth 1.7.6.

## Decisions

1. **Collectors see their provider name and picture, privately.** They appear only in the signed-in app (avatar menu, Owner controls), never on Published Decks, Discover or any public response. Collectors can't edit them. Owner's decision.
2. **Keep exactly three things from a provider:**
   - its stable account id, which Better Auth stores in `account.accountId`;
   - the display name, in `user.name`;
   - the picture URL, in `user.image`.

   The provider's email is only used to match and verify at sign-in. The collector's own email is never rewritten ([Decide how a sign-in links to an existing account](https://github.com/ry-cen/prizecheck/issues/131)). Nothing else from the provider profile is stored.
3. **Name and picture follow the latest sign-in or link.** Turn on `overrideUserInfoOnSignIn` for every configured provider and `account.accountLinking.updateUserInfoOnLink`. This fills the owner's empty name and picture on their first Google or Discord link, and keeps them current when someone changes them at the provider. It needs no custom code and works the same for any provider. The trade-off is accepted: a collector who uses both providers sees whichever they signed in with last. If a provider omits a field, the existing value stays.
4. **When there's no name or picture,** the app shows the first letter of the collector's email as the avatar and no name.
5. **Provider tokens are never stored.** Sign-in needs no provider API calls afterwards. `databaseHooks.account.create.before` and `account.update.before` null `accessToken`, `refreshToken`, `idToken` and both expiry columns on create, link and every sign-in. `scope` stays. Google's `accessType` stays unset, so no refresh token is ever requested. `encryptOAuthTokens` isn't used, because it would leave `idToken` in plain text and protect data we don't need.
6. **Pictures load straight from the provider's image host**, Google's `googleusercontent.com` and Discord's `cdn.discordapp.com`, signed-in only. That host learns when the collector, who is already signed in to that provider, opens the app. We don't copy pictures into our storage.

## Consequences for the spec

- `/auth/session` adds `name` and `image` for the signed-in collector only. No public or FastAPI publication route reads them.
- If a Content-Security-Policy is added later, its `img-src` must allow each configured provider's image host. Each provider entry should carry its image host, so a new provider stays a config change.
- Tests cover:
  - tokens are null after create, link and a repeat sign-in;
  - name and picture are filled on the owner's first link and updated on a later sign-in;
  - Published Deck and Discover responses contain no name, picture or email.
- The backups already include the auth tables. Name and picture join the personal data that the privacy check covers.
