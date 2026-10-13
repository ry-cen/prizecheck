import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { walkSignIn } from "../testing/oauth-fake/walk.js";
import { startGateway, type TestGateway } from "./support/oauth-gateway.js";

// No answer to a sign-in may depend on whether an account exists at the provider's email address (spec stories 19 and
// 86). The fake's `unverified` identity reports unverified@example.test without vouching for it. Its Google and
// Discord walks must end the same way with no collector at that address, with a verified one, with an unverified one,
// and even when that collector holds this provider account, in every signup mode.
const ADDRESS = "unverified@example.test";
// The fake's `unverified` identity's Google account id (auth/testing/oauth-fake/core.ts).
const UNVERIFIED_GOOGLE_SUB = "100000000000000000004";

for (const mode of ["owner-only", "local-public"] as const)
  describe(`${mode}: a provider email the provider doesn't vouch for`, () => {
    let gateway: TestGateway;
    beforeAll(async () => {
      gateway = await startGateway({ env: { SIGNUP_MODE: mode } });
    }, 60_000);
    afterAll(() => gateway?.stop(), 30_000);

    const walkBoth = async () => {
      const locations: Record<string, string | null> = {};
      for (const provider of ["google", "discord"])
        locations[provider] = (
          await walkSignIn(
            gateway.base,
            `/auth/sign-in/${provider}`,
            "unverified"
          )
        ).location;
      return locations;
    };
    const count = async (table: string) =>
      (await gateway.pool.query(`SELECT count(*)::int AS n FROM ${table}`))
        .rows[0].n;

    it("gets the same answer whether or not a collector has that address", async () => {
      const nobody = await walkBoth();
      expect(nobody).toEqual({
        google: "/sign-in?provider=google&error=email_not_found",
        discord: "/sign-in?provider=discord&error=email_not_found",
      });
      await gateway.pool.query(
        `INSERT INTO "user"(id, name, email, "emailVerified") VALUES ('local-collector', 'Local Collector', $1, true)`,
        [ADDRESS]
      );
      expect(await walkBoth()).toEqual(nobody);
      await gateway.pool.query(
        `UPDATE "user" SET "emailVerified"=false WHERE id='local-collector'`
      );
      expect(await walkBoth()).toEqual(nobody);
      await gateway.pool.query(
        `INSERT INTO account(id, "accountId", "providerId", "userId", "updatedAt") VALUES ('local-google', $1, 'google', 'local-collector', now())`,
        [UNVERIFIED_GOOGLE_SUB]
      );
      expect(await walkBoth()).toEqual(nobody);
      // Nothing was created, linked or signed in along the way.
      expect(await count('"user"')).toBe(1);
      expect(await count("account")).toBe(1);
      expect(await count("session")).toBe(0);
    });
  });
