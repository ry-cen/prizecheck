import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  OWNER,
  PLACEHOLDER_CREDENTIALS,
  emailCodeSignIn,
  freePort,
  sessionOf,
  startGateway,
  type TestGateway,
} from "./support/oauth-gateway.js";
import { EMAIL_OTP_PATHS } from "../src/emailSignIn.js";

const NO_PROVIDERS = {
  GOOGLE_CLIENT_ID: undefined,
  GOOGLE_CLIENT_SECRET: undefined,
  DISCORD_CLIENT_ID: undefined,
  DISCORD_CLIENT_SECRET: undefined,
};

/** Starts a gateway that is expected to refuse to start; resolves with its exit status and stderr. */
async function refusal(settings: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...PLACEHOLDER_CREDENTIALS,
    OWNER_EMAIL: OWNER,
    SIGNUP_MODE: "owner-only",
    MAIL_MODE: "file",
    AUTH_PORT: String(await freePort()),
  };
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const child = spawn("node", ["--import", "tsx", "auth/src/server.ts"], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr?.on("data", (chunk) => (errors += chunk));
  const status = await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(() => resolve("running"), 10_000)),
  ]);
  if (status === "running") child.kill();
  return { status, errors };
}

describe("email sign-in off (the default)", () => {
  let gateway: TestGateway;
  beforeAll(async () => {
    gateway = await startGateway({ env: { EMAIL_SIGN_IN: undefined } });
  }, 60_000);
  afterAll(() => gateway?.stop(), 30_000);

  it("reports email sign-in off and answers 404 on the email-code routes", async () => {
    const methods = await (await fetch(`${gateway.base}/auth/methods`)).json();
    expect(methods.emailSignIn).toBe(false);
    for (const [path, body] of [
      ["/auth/request-code", { email: OWNER }],
      ["/auth/verify-code", { email: OWNER, code: "123456" }],
    ] as const) {
      const response = await fetch(gateway.base + path, {
        method: "POST",
        headers: { origin: gateway.base, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status, path).toBe(404);
    }
    expect(
      (await gateway.pool.query("SELECT count(*)::int AS n FROM verification"))
        .rows[0].n
    ).toBe(0);
  });

  it("keeps owner approval codes and sign-out reachable", async () => {
    const approval = await fetch(`${gateway.base}/auth/approval-code`, {
      method: "POST",
      headers: { origin: gateway.base, "content-type": "application/json" },
      body: "{}",
    });
    expect(approval.status).toBe(401);
    const signOut = await fetch(`${gateway.base}/auth/sign-out`, {
      method: "POST",
      headers: { origin: gateway.base },
    });
    expect(signOut.status).not.toBe(404);
  });
});

it("makes Better Auth itself refuse every email-otp endpoint when off, even through its own handler", async () => {
  const script = `
    import { auth, pool } from "./auth/src/auth.ts";
    const statuses = [];
    for (const path of ${JSON.stringify(EMAIL_OTP_PATHS)}) {
      const response = await auth.handler(new Request(process.env.PUBLIC_ORIGIN + "/api/auth" + path, {
        method: "POST",
        headers: { "content-type": "application/json", origin: process.env.PUBLIC_ORIGIN },
        body: JSON.stringify({ email: "owner@example.test", type: "sign-in", otp: "123456" }),
      }));
      statuses.push(response.status);
    }
    process.stdout.write(JSON.stringify(statuses));
    await pool.end();
  `;
  const child = spawn(
    "node",
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      env: {
        ...process.env,
        ...PLACEHOLDER_CREDENTIALS,
        EMAIL_SIGN_IN: "off",
        SIGNUP_MODE: "owner-only",
        OWNER_EMAIL: OWNER,
        PUBLIC_ORIGIN: "http://localhost:5173",
        DATABASE_URL: "postgresql://nobody:nobody@127.0.0.1:1/none",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  expect(await new Promise((resolve) => child.once("exit", resolve))).toBe(0);
  expect(JSON.parse(output)).toEqual(EMAIL_OTP_PATHS.map(() => 404));
});

describe("email sign-in on", () => {
  let gateway: TestGateway;
  beforeAll(async () => {
    gateway = await startGateway({
      env: { EMAIL_SIGN_IN: "on", ...NO_PROVIDERS },
    });
  }, 60_000);
  afterAll(() => gateway?.stop(), 30_000);

  it("starts with no provider, reports email sign-in on, and creates the owner by email code", async () => {
    expect(await (await fetch(`${gateway.base}/auth/methods`)).json()).toEqual({
      providers: [],
      emailSignIn: true,
    });
    const jar = await emailCodeSignIn(gateway, OWNER);
    const session = await sessionOf(gateway, jar);
    expect(session.signedIn).toBe(true);
    const owner = await gateway.pool.query(
      'SELECT id FROM "user" WHERE email=$1',
      [OWNER]
    );
    expect(owner.rows).toEqual([{ id: session.userId }]);
  });
});

describe("startup refusals", () => {
  it("refuses an EMAIL_SIGN_IN value other than on or off", async () => {
    const { status, errors } = await refusal({ EMAIL_SIGN_IN: "yes" });
    expect(status).toBe(1);
    expect(errors).toContain('EMAIL_SIGN_IN must be "on" or "off"');
  });

  it("refuses email sign-in in production without real mail delivery", async () => {
    const { status, errors } = await refusal({
      EMAIL_SIGN_IN: "on",
      NODE_ENV: "production",
      MAIL_MODE: undefined,
    });
    expect(status).toBe(1);
    expect(errors).toContain(
      "Email sign-in in production requires MAIL_MODE=http"
    );
  });

  it("refuses to start with no sign-in method, whatever NODE_ENV says", async () => {
    for (const NODE_ENV of ["development", "production", "test"]) {
      const { status, errors } = await refusal({
        ...NO_PROVIDERS,
        EMAIL_SIGN_IN: "off",
        NODE_ENV,
        MAIL_MODE: NODE_ENV === "production" ? "http" : "file",
      });
      expect(status, NODE_ENV).toBe(1);
      expect(errors).toContain("No sign-in method");
    }
  }, 40_000);
});
