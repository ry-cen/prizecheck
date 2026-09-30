import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins';
import { Pool } from 'pg';
import { appendFile } from 'node:fs/promises';

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const origin = process.env.PUBLIC_ORIGIN || 'http://localhost:5173';
if (process.env.NODE_ENV === 'production' && ['console', 'file'].includes(process.env.MAIL_MODE || '')) {
  throw new Error('Fake email delivery is for local development only');
}

export const auth = betterAuth({
  database: pool,
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
      if (process.env.MAIL_MODE === 'console') {
        // Local fake delivery only. Never log a code in a deployed environment.
        process.stdout.write(`Local sign-in code for ${email}: ${otp}\n`);
        return;
      }
      if (process.env.MAIL_MODE === 'file' && process.env.MAIL_FILE) {
        await appendFile(process.env.MAIL_FILE, JSON.stringify({ email, otp }) + '\n', { mode: 0o600 });
        return;
      }
      throw new Error('Email delivery is not configured');
    },
  })],
});
