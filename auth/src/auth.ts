import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { Pool } from "pg";
import { appendFile } from "node:fs/promises";

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
const origin = process.env.PUBLIC_ORIGIN || "http://localhost:5173";
if (
  process.env.NODE_ENV === "production" &&
  ["console", "file"].includes(process.env.MAIL_MODE || "")
) {
  throw new Error("Fake email delivery is for local development only");
}

export async function deliverCode(
  email: string,
  otp: string,
  purpose = "sign-in"
) {
  if (process.env.MAIL_MODE === "console") {
    process.stdout.write(`Local ${purpose} code for ${email}: ${otp}\n`);
    return;
  }
  if (process.env.MAIL_MODE === "file" && process.env.MAIL_FILE) {
    await appendFile(
      process.env.MAIL_FILE,
      JSON.stringify({ email, otp, purpose }) + "\n",
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
        subject: `Your ${purpose} code`,
        text: `Your ${purpose} code is ${otp}. It expires in 5 minutes.`,
      }),
    });
    // Relay errors may include recipient or OTP payloads; never read/log their body.
    await response.body?.cancel();
    if (!response.ok) throw new Error("Email delivery unavailable");
    return;
  }
  throw new Error("Email delivery is not configured");
}

// One configuration for both instances: cookie names and session rules must match, or a budgeted route finds no session.
function authOn(database: Pool) {
  return betterAuth({
    database,
    // Gateway emits bounded operational outcomes; adapter errors can contain PII.
    logger: { disabled: true },
    onAPIError: { throw: true },
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: origin,
    basePath: "/api/auth",
    trustedOrigins: [origin],
    emailAndPassword: { enabled: false },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    advanced: {
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
