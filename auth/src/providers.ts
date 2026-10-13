// Sign-in providers come from the environment. A provider is configured only when both its client id and secret are
// set; exactly one of the two is a startup error. Adding a provider is one entry here, its credentials, and one entry
// in the test fake (auth/testing/oauth-fake/core.ts). Routes never name a provider: they look it up in this list.

export type ProviderId = "google" | "discord";

export type ConfiguredProvider = {
  id: ProviderId;
  /** Shown on the sign-in page and in messages. */
  name: string;
  /** Where profile pictures load from; a later content-security policy must allow it. */
  imageHost: string;
  clientId: string;
  clientSecret: string;
};

const KNOWN: {
  id: ProviderId;
  name: string;
  imageHost: string;
  env: string;
}[] = [
  {
    id: "google",
    name: "Google",
    imageHost: "googleusercontent.com",
    env: "GOOGLE",
  },
  {
    id: "discord",
    name: "Discord",
    imageHost: "cdn.discordapp.com",
    env: "DISCORD",
  },
];

export function configuredProviders(
  env: NodeJS.ProcessEnv = process.env
): ConfiguredProvider[] {
  const configured: ConfiguredProvider[] = [];
  for (const provider of KNOWN) {
    const clientId = (env[`${provider.env}_CLIENT_ID`] || "").trim();
    const clientSecret = (env[`${provider.env}_CLIENT_SECRET`] || "").trim();
    if (!clientId && !clientSecret) continue;
    if (!clientId || !clientSecret)
      throw new Error(
        `${provider.env}_CLIENT_ID and ${provider.env}_CLIENT_SECRET must be set together`
      );
    configured.push({
      id: provider.id,
      name: provider.name,
      imageHost: provider.imageHost,
      clientId,
      clientSecret,
    });
  }
  return configured;
}

/** Whether the provider vouches for the email in its profile, by its own verified claim. One entry per provider. */
const VOUCHES_FOR_EMAIL: Record<ProviderId, (profile: object) => boolean> = {
  google: (profile) =>
    (profile as { email_verified?: unknown }).email_verified === true,
  discord: (profile) => (profile as { verified?: unknown }).verified === true,
};

/**
 * Drops an email the provider doesn't vouch for, before Better Auth looks for a local user at that address. Otherwise
 * Better Auth answers `account_not_linked` when a collector has that address and the gate answers `email_not_verified`
 * when nobody does, which would reveal who has an account. Without an email every such attempt ends the same way,
 * `email_not_found`, whatever the database holds: on sign-in from the callback's own check, on a deliberate link from
 * the gate.
 */
export function vouchedEmailOnly(provider: ProviderId) {
  return (profile: object) =>
    VOUCHES_FOR_EMAIL[provider](profile) ? {} : { email: null };
}

/** Better Auth's `socialProviders` option. Default scopes stay; Google's accessType stays unset (no refresh token). */
export function socialProviders(providers: ConfiguredProvider[]) {
  return Object.fromEntries(
    providers.map((provider) => [
      provider.id,
      {
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        overrideUserInfoOnSignIn: true,
        mapProfileToUser: vouchedEmailOnly(provider.id),
      },
    ])
  );
}
