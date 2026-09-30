import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { spawn } from 'node:child_process';

const base = process.env.TEST_BASE_URL || 'http://localhost:5173';
const origin = 'http://localhost:5173';
const email = process.env.OWNER_EMAIL || 'owner@example.test';
const mailFile = process.env.MAIL_FILE || '/tmp/tcg-ticket01-mail';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function latestCode(): string {
  const lines = readFileSync(mailFile, 'utf8').trim().split('\n');
  return JSON.parse(lines.at(-1)!).otp;
}
async function post(path: string, body: object, cookie = '') {
  return fetch(base + path, { method: 'POST', headers: { origin, 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
}

describe('live Better Auth boundary', () => {
  beforeAll(async () => {
    await pool.query('DELETE FROM auth_send_event');
    await pool.query('DELETE FROM verification');
  });

  it('keeps requests uniform, stores hashed codes, rotates and expires them', async () => {
    const outsider = await post('/auth/request-code', { email: 'other@example.test' });
    const owner = await post('/auth/request-code', { email });
    expect(outsider.status).toBe(202);
    expect(await outsider.json()).toEqual(await owner.json());
    const first = latestCode();
    const stored = await pool.query('SELECT value FROM verification ORDER BY "createdAt" DESC LIMIT 1');
    expect(stored.rows[0].value).not.toContain(first);
    await post('/auth/request-code', { email });
    expect(latestCode()).toBe(first); // one per minute
    await pool.query("UPDATE auth_send_event SET sent_at = now() - interval '61 seconds'");
    await post('/auth/request-code', { email });
    const second = latestCode();
    expect(second).not.toBe(first);
    expect((await post('/auth/verify-code', { email, code: first })).status).toBe(401);
    await pool.query("UPDATE verification SET \"expiresAt\" = now() - interval '1 second'");
    expect((await post('/auth/verify-code', { email, code: second })).status).toBe(401);
  });

  it('rejects three wrong attempts and signs out a valid session', async () => {
    await pool.query("UPDATE auth_send_event SET sent_at = now() - interval '61 seconds'");
    await post('/auth/request-code', { email });
    const code = latestCode();
    for (let i = 0; i < 3; i++) expect((await post('/auth/verify-code', { email, code: '000000' })).status).toBe(401);
    expect((await post('/auth/verify-code', { email, code })).status).toBe(401);
    await pool.query("UPDATE auth_send_event SET sent_at = now() - interval '61 seconds'");
    await post('/auth/request-code', { email });
    const fresh = latestCode();
    const signedIn = await post('/auth/verify-code', { email, code: fresh });
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toEqual({ signedIn: true });
    const users = await pool.query('SELECT id FROM "user" WHERE email = $1', [email]);
    const onboarded = await pool.query('SELECT name, kind FROM location WHERE owner_id = $1', [users.rows[0].id]);
    expect(onboarded.rows).toContainEqual({ name: 'Unsorted', kind: 'storage_leaf' });
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0];
    expect(signedIn.headers.get('set-cookie')).toContain('HttpOnly');
    expect(signedIn.headers.get('set-cookie')).toContain('SameSite=Lax');
    expect((await fetch(base + '/api/locations', { headers: { cookie } })).status).toBe(200);
    const signedOut = await post('/auth/sign-out', {}, cookie);
    expect(signedOut.status).toBe(200);
    expect((await fetch(base + '/api/locations', { headers: { cookie } })).status).toBe(401);
  });

  it('rejects missing origin and forged identity headers', async () => {
    const csrf = await fetch(base + '/auth/request-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
    expect(csrf.status).toBe(403);
    const forged = await fetch(base + '/api/locations', { headers: { 'x-internal-user': 'other-owner', 'x-internal-signature': 'forged' } });
    expect(forged.status).toBe(401);
  });

  it('enforces durable email, trusted IP, and global send ceilings', async () => {
    const before = readFileSync(mailFile, 'utf8').trim().split('\n').length;
    const source = await pool.query('SELECT email_key, ip_key FROM auth_send_event LIMIT 1');
    const { email_key, ip_key } = source.rows[0];
    await pool.query('DELETE FROM auth_send_event');
    await pool.query("INSERT INTO auth_send_event(email_key,ip_key,sent_at) SELECT $1,$2,now()-interval '2 minutes' FROM generate_series(1,5)", [email_key, ip_key]);
    expect((await post('/auth/request-code', { email })).status).toBe(202);
    expect(readFileSync(mailFile, 'utf8').trim().split('\n').length).toBe(before);
    await pool.query('DELETE FROM auth_send_event');
    await pool.query("INSERT INTO auth_send_event(email_key,ip_key,sent_at) SELECT 'other-'||n,$1,now() FROM generate_series(1,20) n", [ip_key]);
    await post('/auth/request-code', { email });
    expect(readFileSync(mailFile, 'utf8').trim().split('\n').length).toBe(before);
    await pool.query('DELETE FROM auth_send_event');
    await pool.query("INSERT INTO auth_send_event(email_key,ip_key,sent_at) SELECT 'other-'||n,'ip-'||n,now() FROM generate_series(1,100) n");
    await post('/auth/request-code', { email });
    expect(readFileSync(mailFile, 'utf8').trim().split('\n').length).toBe(before);
  });

  it('fails closed when the auth database is unavailable', async () => {
    const child = spawn('node_modules/.bin/tsx', ['auth/src/server.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, AUTH_PORT: '3002', DATABASE_URL: 'postgresql://raian@127.0.0.1:1/unavailable' },
      stdio: 'ignore',
    });
    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          response = await fetch('http://127.0.0.1:3002/api/locations', { headers: { cookie: 'better-auth.session_token=forged', 'x-internal-user': 'victim' } });
          break;
        } catch {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      expect(response?.status).toBe(503);
      const request = await fetch('http://127.0.0.1:3002/auth/request-code', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
      expect(request.status).toBe(202);
    } finally {
      child.kill();
    }
  });
});
