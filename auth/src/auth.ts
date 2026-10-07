import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins';
import { Pool } from 'pg';
import { appendFile } from 'node:fs/promises';

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const origin = process.env.PUBLIC_ORIGIN || 'http://localhost:5173';
if (process.env.NODE_ENV === 'production' && ['console', 'file'].includes(process.env.MAIL_MODE || '')) {
  throw new Error('Fake email delivery is for local development only');
}

export async function deliverCode(email: string, otp: string, purpose = 'sign-in') {
  if (process.env.MAIL_MODE === 'console') {
    process.stdout.write(`Local ${purpose} code for ${email}: ${otp}\n`);
    return;
  }
  if (process.env.MAIL_MODE === 'file' && process.env.MAIL_FILE) {
    await appendFile(process.env.MAIL_FILE, JSON.stringify({ email, otp, purpose }) + '\n', { mode: 0o600 });
    return;
  }
  if (process.env.MAIL_MODE === 'http') {
    const endpoint = process.env.MAIL_RELAY_URL;
    const token = process.env.MAIL_RELAY_TOKEN;
    const from = process.env.MAIL_FROM;
    if (!endpoint || !token || !from) throw new Error('Email relay configuration required');
    const url = new URL(endpoint);
    if (url.username || url.password || (url.protocol !== 'https:' &&
        !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
      throw new Error('Secure email relay required');
    }
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: email, subject: `Your ${purpose} code`, text: `Your ${purpose} code is ${otp}. It expires in 5 minutes.` }),
    });
    // Relay errors may include recipient or OTP payloads; never read/log their body.
    await response.body?.cancel();
    if (!response.ok) throw new Error('Email delivery unavailable');
    return;
  }
  throw new Error('Email delivery is not configured');
}

export const auth = betterAuth({
  database: pool,
  // Gateway emits bounded operational outcomes; adapter errors can contain PII.
  logger: { disabled: true },
  onAPIError: { throw: true },
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: origin,
  basePath: '/api/auth',
  trustedOrigins: [origin],
  emailAndPassword: { enabled: false },
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
  advanced: { useSecureCookies: !new URL(origin).hostname.match(/^(localhost|127\.0\.0\.1)$/) },
  plugins: [emailOTP({
    otpLength: 6,
    expiresIn: 300,
    allowedAttempts: 3,
    resendStrategy: 'rotate',
    storeOTP: 'hashed',
    async sendVerificationOTP({ email, otp }) {
      await deliverCode(email, otp);
    },
  })],
});
