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

/** Better Auth's `socialProviders` option. Default scopes stay; Google's accessType stays unset (no refresh token). */
export function socialProviders(providers: ConfiguredProvider[]) {
  return Object.fromEntries(
    providers.map((provider) => [
      provider.id,
      {
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        overrideUserInfoOnSignIn: true,
      },
    ])
  );
}
