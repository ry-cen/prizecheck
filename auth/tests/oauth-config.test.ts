import { describe, expect, it } from "vitest";
import { DEFAULT_NEXT, safeNext } from "../src/nextPath.js";
import {
  configuredProviders,
  socialProviders,
  vouchedEmailOnly,
} from "../src/providers.js";
import { createSignupGate, type GateInput } from "../src/signupGate.js";

describe("safeNext", () => {
  it("keeps same-origin paths outside the API and the gateway", () => {
    for (const [value, expected] of [
      ["/decks", "/decks"],
      ["/collection?set=base", "/collection?set=base"],
      ["/workspace#top", "/workspace#top"],
      ["/decks/../catalog", "/catalog"],
      ["/apis", "/apis"],
      ["/authors", "/authors"],
    ])
      expect(safeNext(value), value).toBe(expected);
  });
  it("falls back to /collection for anything else", () => {
    expect(DEFAULT_NEXT).toBe("/collection");
    for (const value of [
      null,
      undefined,
      "",
      "decks",
      "//evil.example/x",
      "/\\evil.example",
      "https://evil.example/x",
      "javascript:alert(1)",
      "/api",
      "/api/locations",
      "/API/locations",
      "/auth",
      "/auth/session",
      "/auth/sign-in/google",
      "/decks/../api/locations",
      "/.//evil.example",
      "/a/..//evil.example",
      "/%2e//evil.example",
      "/./\\evil.example",
      "/%61pi/x",
      "/" + "a".repeat(2048),
    ])
      expect(safeNext(value), String(value)).toBe("/collection");
  });
});

describe("configuredProviders", () => {
  const both = {
    GOOGLE_CLIENT_ID: "g-id",
    GOOGLE_CLIENT_SECRET: "g-secret",
    DISCORD_CLIENT_ID: "d-id",
    DISCORD_CLIENT_SECRET: "d-secret",
  };
  it("configures a provider only when both its id and secret are set", () => {
    expect(configuredProviders({})).toEqual([]);
    expect(
      configuredProviders({ GOOGLE_CLIENT_ID: " ", GOOGLE_CLIENT_SECRET: "" })
    ).toEqual([]);
    expect(configuredProviders(both)).toEqual([
      {
        id: "google",
        name: "Google",
        imageHost: "googleusercontent.com",
        clientId: "g-id",
        clientSecret: "g-secret",
      },
      {
        id: "discord",
        name: "Discord",
        imageHost: "cdn.discordapp.com",
        clientId: "d-id",
        clientSecret: "d-secret",
      },
    ]);
    expect(
      configuredProviders({
        DISCORD_CLIENT_ID: "d-id",
        DISCORD_CLIENT_SECRET: "d-secret",
      }).map((provider) => provider.id)
    ).toEqual(["discord"]);
  });
  it("refuses a half-configured provider", () => {
    expect(() => configuredProviders({ GOOGLE_CLIENT_ID: "g-id" })).toThrow(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together"
    );
    expect(() =>
      configuredProviders({ DISCORD_CLIENT_SECRET: "d-secret" })
    ).toThrow(
      "DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET must be set together"
    );
  });
  it("keeps the default scopes, no Google refresh token, and the profile following the latest sign-in", () => {
    expect(socialProviders(configuredProviders(both))).toEqual({
      google: {
        clientId: "g-id",
        clientSecret: "g-secret",
        overrideUserInfoOnSignIn: true,
        mapProfileToUser: expect.any(Function),
      },
      discord: {
        clientId: "d-id",
        clientSecret: "d-secret",
        overrideUserInfoOnSignIn: true,
        mapProfileToUser: expect.any(Function),
      },
    });
  });
  it("keeps a provider's email only when the provider vouches for it", () => {
    const google = vouchedEmailOnly("google");
    const discord = vouchedEmailOnly("discord");
    expect(google({ email: "a@example.test", email_verified: true })).toEqual(
      {}
    );
    expect(discord({ email: "a@example.test", verified: true })).toEqual({});
    for (const profile of [
      { email: "a@example.test", email_verified: false, verified: false },
      { email: "a@example.test", email_verified: "true", verified: "true" },
      { email: "a@example.test" },
    ]) {
      expect(google(profile)).toEqual({ email: null });
      expect(discord(profile)).toEqual({ email: null });
    }
    // Each provider reads only its own claim.
    expect(google({ email: "a@example.test", verified: true })).toEqual({
      email: null,
    });
    expect(discord({ email: "a@example.test", email_verified: true })).toEqual({
      email: null,
    });
  });
});

describe("signup gate", () => {
  const OWNER = "owner@example.test";
  const gate = (options: {
    publicSignup?: boolean;
    bound?: boolean;
    owners?: string[];
  }) =>
    createSignupGate({
      publicSignup: options.publicSignup ?? false,
      ownerEmail: OWNER,
      ownerBound: async () => options.bound ?? false,
      isOwner: async (id) => (options.owners ?? []).includes(id),
    });
  const input = (
    action: GateInput["source"]["action"],
    user: GateInput["user"],
    method = "oauth"
  ): GateInput => ({ user, source: { action, method } });
  const NOT_OPEN = {
    error: "sign_in_unavailable",
    errorDescription: "sign_in_unavailable",
  };

  it("refuses OAuth creation or linking without a verified email, in every mode", async () => {
    for (const publicSignup of [false, true])
      for (const action of ["create-user", "link-account"] as const) {
        const check = gate({ publicSignup, owners: ["u1"] });
        expect(
          await check(
            input(action, { id: "u1", email: OWNER, emailVerified: false })
          )
        ).toEqual({
          error: "email_not_verified",
          errorDescription: "email_not_verified",
        });
        expect(
          await check(input(action, { id: "u1", emailVerified: true }))
        ).toEqual({
          error: "email_not_found",
          errorDescription: "email_not_found",
        });
      }
  });

  it("lets the verified owner create the account only before any owner binding", async () => {
    const owner = { email: "Owner@Example.test", emailVerified: true };
    expect(await gate({})(input("create-user", owner))).toBeUndefined();
    expect(await gate({ bound: true })(input("create-user", owner))).toEqual(
      NOT_OPEN
    );
    expect(
      await gate({})(
        input("create-user", {
          email: "newcomer@example.test",
          emailVerified: true,
        })
      )
    ).toEqual(NOT_OPEN);
  });

  it("lets only the owner sign in or link in owner-only mode", async () => {
    const check = gate({ owners: ["owner-id"] });
    for (const action of ["sign-in", "link-account"] as const) {
      expect(
        await check(
          input(action, { id: "owner-id", email: OWNER, emailVerified: true })
        )
      ).toBeUndefined();
      // The provider email is not what decides: only who the existing user is.
      expect(
        await check(
          input(action, { id: "other-id", email: OWNER, emailVerified: true })
        )
      ).toEqual(NOT_OPEN);
    }
    expect(
      await check(
        input("sign-in", {
          id: "owner-id",
          email: "moved@example.test",
          emailVerified: false,
        })
      )
    ).toBeUndefined();
  });

  it("applies the owner-only rules to email-code creation without the provider rule", async () => {
    expect(
      await gate({})(input("create-user", { email: OWNER }, "email-otp"))
    ).toBeUndefined();
    expect(
      await gate({})(
        input("create-user", { email: "newcomer@example.test" }, "email-otp")
      )
    ).toEqual(NOT_OPEN);
  });

  it("allows create, link and sign-in in public modes once the email is verified", async () => {
    const check = gate({ publicSignup: true });
    for (const action of ["create-user", "link-account", "sign-in"] as const)
      expect(
        await check(
          input(action, {
            id: "x",
            email: "newcomer@example.test",
            emailVerified: true,
          })
        )
      ).toBeUndefined();
  });

  it("never looks at the provider id", async () => {
    const check = gate({ owners: ["owner-id"] });
    const user = { id: "owner-id", email: OWNER, emailVerified: true };
    const google = await check({
      user,
      source: {
        action: "link-account",
        method: "oauth",
        oauth: { providerId: "google" },
      } as GateInput["source"],
    });
    const other = await check({
      user,
      source: {
        action: "link-account",
        method: "oauth",
        oauth: { providerId: "anything" },
      } as GateInput["source"],
    });
    expect(google).toEqual(other);
  });

  it("fails closed when the owner lookup fails", async () => {
    const failing = createSignupGate({
      publicSignup: false,
      ownerEmail: OWNER,
      ownerBound: async () => {
        throw new Error("database down");
      },
      isOwner: async () => {
        throw new Error("database down");
      },
    });
    await expect(
      failing(
        input("sign-in", { id: "owner-id", email: OWNER, emailVerified: true })
      )
    ).rejects.toThrow();
  });
});
