# Decide how a sign-in links to an existing account

Resolved 2026-10-12 for [Decide how a sign-in links to an existing account](https://github.com/ry-cen/prizecheck/issues/131). The owner chose the core rule (1). For the rest, the owner handed technical auth choices to Claude, which took the recommendations below. Facts come from [Google and Discord sign-in under Better Auth](../research/google-discord-better-auth.md).

## Decisions

1. **Link automatically by verified email, with no shortcuts.** A first-time Google or Discord sign-in whose email matches an existing collector links to that collector only when both conditions hold:
   - the provider reports the email as verified (Google `email_verified`, Discord `verified`);
   - the existing account's email is verified.

   The match is case-insensitive exact text. No provider is "trusted", so `trustedProviders` stays empty. Owner's choice.
2. **An unverified or missing provider email is refused, and nothing is created.** The person is told to verify their email with that provider and try again. No account, Unsorted root or provider link is written, so an unverified account can never squat on an address and block the real owner's later verified sign-in.
3. **Returning sign-ins match on the provider's account id, not the email.** If someone changes their Google or Discord email, they still reach the same collector. A collector's own email is never rewritten by a sign-in or link.
4. **The owner moves over by rule 1.** The owner's account is verified (email-code sign-in set it), so the owner's first Google or Discord sign-in at `OWNER_EMAIL` links to it. The owner stays identified by `OWNER_EMAIL`, and nothing else changes.
5. **One rule for every provider.** Linking and refusal depend only on whether the email is verified, never on which provider is used. A provider that never vouches for a verified email can't link or create accounts. Adding one would need a new decision, and making it "trusted" is ruled out.
6. **Different emails across providers aren't linked automatically.** A collector whose Discord email differs from their account email gets a separate, unlinked sign-in attempt. Connecting providers deliberately from inside a signed-in session belongs to the account-settings fog.

## Consequences for the spec

- Rules 1 and 2 rely on Better Auth 1.7 behaviour: `requireLocalEmailVerified` and `user.validateUserInfo`. The spec must raise the `^1.4.0` floor to 1.7, so the lockfile can't fall back to 1.4, where an unverified local row could be linked.
- The refusal in rule 2 must happen before any user row is created (`validateUserInfo`, or `databaseHooks.user.create.before`). `requireEmailVerification` is not enough, because it still creates the rows.
- The refusal's wording joins the map's "Refused sign-in messaging" fog.
