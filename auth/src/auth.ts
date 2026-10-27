import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { Pool } from "pg";
import { appendFile } from "node:fs/promises";
import { IP_ADDRESS_OPTION } from "./betterRelay.js";
import { EMAIL_OTP_PATHS, emailSignInEnabled } from "./emailSignIn.js";
import { contextIp } from "./ipContext.js";
import { configuredProviders, socialProviders } from "./providers.js";
import { createRateLimits, dailySignupCap } from "./rateLimits.js";
import { createSignupGate } from "./signupGate.js";
import { signupEnabled } from "./signup.js";
import { createSignInRemoval } from "./signInRemoval.js";
import { FRESH_AGE_SECONDS } from "./signIns.js";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// Session lookups for budgeted routes (BUDGETED_ROUTES in server.ts) run on their own small pool. The gateway abandons
// such a lookup when the three-second budget runs out (getSession takes no signal), so these timeouts end it in
// PostgreSQL instead: a slow auth database holds at most four of these connections, for about three seconds each, and
// never the shared pool that sign-in and every other route use. 3000 is BUDGET_MS in server.ts, so the gateway's own
// 504, at 2.9 s, always comes first.
const BUDGETED_LOOKUP_TIMEOUT_MS = 3_000;
const budgetedLookupPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  connectionTimeoutMillis: BUDGETED_LOOKUP_TIMEOUT_MS,
  statement_timeout: BUDGETED_LOOKUP_TIMEOUT_MS,
  lock_timeout: BUDGETED_LOOKUP_TIMEOUT_MS,
});
// The signup gate runs inside Better Auth's create-user transaction, which already holds a shared-pool connection, so the
// gate's own queries (the account-creation limits and the owner checks) use this small pool with a connect timeout: a
// burst of creations can't wait on connections the transactions themselves are holding.
const gatePool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  connectionTimeoutMillis: 5_000,
});
const origin = process.env.PUBLIC_ORIGIN || "http://localhost:5173";
/** The web page that shows sign-in and its error messages (`?error=<code>`). */
export const SIGN_IN_PAGE = "/sign-in";
// Startup checks: an invalid EMAIL_SIGN_IN, an invalid signup configuration or a half-configured provider stops the
// gateway here.
export const emailSignIn = emailSignInEnabled();
export const publicSignup = signupEnabled();
export const providers = configuredProviders();
// Direct deletion matches the installed Better Auth schema and has no delete hooks or session side effects.
// Review this assumption whenever auth configuration, plugins or the Better Auth version change.
const removalPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 5_000,
  lock_timeout: 5_000,
  idle_in_transaction_session_timeout: 10_000,
});
removalPool.on("error", (error) => {
  console.error("Sign-in removal pool failed", error.name);
});
export const removeSignIn = createSignInRemoval(removalPool, providers);

// The account-creation and start limits (auth/src/rateLimits.ts); an invalid DAILY_SIGNUP_CAP stops the gateway here.
export const rateLimits = createRateLimits(gatePool, dailySignupCap());
const ownerEmail = (process.env.OWNER_EMAIL || "").trim().toLowerCase();
if (
  process.env.NODE_ENV === "production" &&
  ["console", "file"].includes(process.env.MAIL_MODE || "")
) {
  throw new Error("Fake email delivery is for local development only");
}
if (
  emailSignIn &&
  process.env.NODE_ENV === "production" &&
  process.env.MAIL_MODE !== "http"
) {
  throw new Error("Email sign-in in production requires MAIL_MODE=http");
}

export async function deliverCode(email: string, otp: string) {
  if (process.env.MAIL_MODE === "console") {
    process.stdout.write(`Local sign-in code for ${email}: ${otp}\n`);
    return;
  }
  if (process.env.MAIL_MODE === "file" && process.env.MAIL_FILE) {
    await appendFile(
      process.env.MAIL_FILE,
      JSON.stringify({ email, otp }) + "\n",
      { mode: 0o600 }
    );
    return;
  }
  if (process.env.MAIL_MODE === "http") {
    const endpoint = process.env.MAIL_RELAY_URL;
    const token = process.env.MAIL_RELAY_TOKEN;
    const from = process.env.MAIL_FROM;
    if (!endpoint || !token || !from)
      throw new Error("Email relay configuration required");
    const url = new URL(endpoint);
    if (
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(
          process.env.NODE_ENV !== "production" &&
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        ))
    ) {
      throw new Error("Secure email relay required");
    }
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: email,
        subject: "Your sign-in code",
        text: `Your sign-in code is ${otp}. It expires in 5 minutes.`,
      }),
    });
    // Relay errors may include recipient or OTP payloads; never read/log their body.
    await response.body?.cancel();
    if (!response.ok) throw new Error("Email delivery unavailable");
    return;
  }
  throw new Error("Email delivery is not configured");
}

// A binding counts only when it names an existing account: scripts/bind_owner.py binds a signed-in account, and a
// binding to an id with no account (test fixtures write these) can identify nobody who could sign in.
const BOUND = `SELECT 1 FROM owner_binding b JOIN "user" u ON u.id=b.user_id WHERE b.singleton`;
const signupGate = createSignupGate({
  publicSignup,
  ownerEmail,
  ownerBound: async () => (await gatePool.query(BOUND)).rowCount === 1,
  isOwner: async (userId) =>
    (
      await gatePool.query<{ owner: boolean }>(
        `SELECT CASE WHEN EXISTS (${BOUND})
          THEN EXISTS (SELECT 1 FROM owner_binding WHERE singleton AND user_id=$1)
          ELSE EXISTS (SELECT 1 FROM "user" WHERE id=$1 AND lower(email)=$2 AND "emailVerified")
        END AS owner`,
        [userId, ownerEmail]
      )
    ).rows[0].owner,
  clientIp: contextIp,
  allowSignup: rateLimits.allowSignup,
});

// PrizeCheck never uses provider tokens, so none are stored. `scope` stays.
const NO_TOKENS = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
};

// One configuration for both instances: cookie names and session rules must match, or a budgeted route finds no session.
function authOn(database: Pool) {
  return betterAuth({
    database,
    // Gateway emits bounded operational outcomes; adapter errors can contain PII.
    logger: { disabled: true },
    // Better Auth's own /api/auth/error page is never routed: errors land on the web sign-in page.
    onAPIError: { throw: true, errorURL: `${origin}${SIGN_IN_PAGE}` },
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: origin,
    basePath: "/api/auth",
    trustedOrigins: [origin],
    emailAndPassword: { enabled: false },
    // The plugin stays registered so turning the switch on needs no code change; when off, Better Auth itself refuses
    // every one of its endpoints, even if a gateway route reached them by mistake.
    disabledPaths: emailSignIn ? [] : EMAIL_OTP_PATHS,
    socialProviders: socialProviders(providers),
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: [],
        allowDifferentEmails: true,
        updateUserInfoOnLink: true,
      },
    },
    user: {
      validateUserInfo: (data) =>
        signupGate({
          user: data.user,
          source: { action: data.source.action, method: data.source.method },
        }),
    },
    databaseHooks: {
      session: {
        // No raw visitor address is stored (the project keeps addresses only as keyed digests, caller.ts).
        create: { before: async () => ({ data: { ipAddress: "" } }) },
      },
      account: {
        create: { before: async () => ({ data: NO_TOKENS }) },
        update: { before: async () => ({ data: NO_TOKENS }) },
      },
      user: {
        update: {
          // A sign-in or link never changes the collector's own email or verified flag (overrideUserInfoOnSignIn
          // would). Hook data is merged, so the keys are overridden with undefined, which Better Auth drops.
          before: async (user, context) =>
            context?.path === "/callback/:id"
              ? {
                  data: {
                    email: undefined,
                    emailVerified: undefined,
                    // Better Auth sends "" for a name the provider omitted; the old name stays.
                    ...(user.name === "" ? { name: undefined } : {}),
                  },
                }
              : undefined,
        },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      // Seconds. The Sign-ins page applies the same window to link starts (signIns.ts).
      freshAge: FRESH_AGE_SECONDS,
    },
    advanced: {
      // Better Auth's limiter is on in production and keys on this address; the gateway sets the header from its own
      // trusted client address (betterRelay.ts), so one visitor cannot exhaust another's allowance. Better Auth also
      // stores this address on each new session, so the session hook above blanks it: addresses are never kept.
      ipAddress: IP_ADDRESS_OPTION,
      useSecureCookies: !new URL(origin).hostname.match(
        /^(localhost|127\.0\.0\.1)$/
      ),
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 3,
        resendStrategy: "rotate",
        storeOTP: "hashed",
        async sendVerificationOTP({ email, otp }) {
          await deliverCode(email, otp);
        },
      }),
    ],
  });
}

export const auth = authOn(pool);
// Only for the session lookup on budgeted routes (server.ts).
export const budgetedAuth = authOn(budgetedLookupPool);
