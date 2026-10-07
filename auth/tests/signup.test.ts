import { beforeAll, afterAll, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const database = 'tcg_signup_' + randomUUID().replaceAll('-', '');
const directory = mkdtempSync(join(tmpdir(), 'tcg-signup-'));
const origin = 'http://localhost:5173';
const base = 'http://127.0.0.1:3198';
let pool: Pool;
let child: ChildProcess;
let gatewayLogs = "";
async function request(path: string, body: object, cookie = '') {
  return fetch(base + path, { method: 'POST', headers: { origin, 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
}
function code() { return JSON.parse(readFileSync(join(directory, 'mail'), 'utf8').trim().split('\n').at(-1)!).otp; }
beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  const connection = new URL(process.env.DATABASE_URL!); connection.pathname = '/' + database;
  pool = new Pool({ connectionString: connection.toString() });
  const env = { ...process.env, DATABASE_URL: connection.toString(), AUTH_PORT: '3198', MAIL_MODE: 'file', MAIL_FILE: join(directory, 'mail'), SIGNUP_MODE: 'local-public', OWNER_EMAIL: 'owner@example.test', PUBLIC_ORIGIN: origin };
  await new Promise<void>((resolve, reject) => {
    const migration = spawn('.venv/bin/python', ['scripts/migrate.py'], { env, stdio: 'ignore' });
    migration.on('exit', status => status === 0 ? resolve() : reject(new Error('Migration failed')));
  });
  child = spawn('node', ['--import', 'tsx', 'auth/src/server.ts'], { env, stdio: ['ignore','pipe','pipe'] });
  child.stdout?.on('data', chunk => gatewayLogs += chunk);
  child.stderr?.on('data', chunk => gatewayLogs += chunk);
  for (let n = 0; n < 50; n++) {
    try { if ((await fetch(base + '/auth/session')).ok) return; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Gateway did not start');
});
afterAll(async () => {
  if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end(); rmSync(directory, { recursive: true, force: true });
});
it('creates public accounts and Unsorted atomically; repeat signin retains the same account', async () => {
  const email = 'collector@example.test';
  expect((await request('/auth/request-code', { email })).status).toBe(202);
  const signin = await request('/auth/verify-code', { email, code: code() });
  expect(signin.status).toBe(200);
  const cookie = signin.headers.get('set-cookie')!.split(';')[0];
  const initial = await pool.query('SELECT u.id,l.name,l.kind FROM "user" u JOIN inventory_owner o ON o.user_id=u.id JOIN location l ON l.owner_id=u.id WHERE email=$1', [email]);
  expect(initial.rows).toHaveLength(1);
  expect(initial.rows[0]).toMatchObject({ name: 'Unsorted', kind: 'storage_leaf' });
  expect((await request('/auth/approval-code', { reportId: randomUUID(), action: 'approve_printing' }, cookie)).status).toBe(403);
  await pool.query('DELETE FROM auth_send_event');
  await request('/auth/request-code', { email });
  expect((await request('/auth/verify-code', { email, code: code() })).status).toBe(200);
  expect((await pool.query('SELECT id FROM "user" WHERE email=$1', [email])).rows).toEqual([{ id: initial.rows[0].id }]);
  expect((await pool.query('SELECT count(*)::int AS count FROM location WHERE owner_id=$1', [initial.rows[0].id])).rows[0].count).toBe(1);
});
it('rolls back the account when its initial Storage Leaf cannot be created', async () => {
  const email = 'rollback@example.test';
  await pool.query("CREATE FUNCTION fail_signup_leaf() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected onboarding failure'; END $$");
  await pool.query('CREATE TRIGGER fail_signup_leaf BEFORE INSERT ON location FOR EACH ROW EXECUTE FUNCTION fail_signup_leaf()');
  try {
    await request('/auth/request-code', { email });
    const signin = await request('/auth/verify-code', { email, code: code() });
    expect(signin.status).toBe(503);
    expect(signin.headers.get('set-cookie')).toBeNull();
    expect(gatewayLogs).not.toContain(email);
    expect(gatewayLogs).not.toContain('injected onboarding failure');
    expect((await pool.query('SELECT id FROM "user" WHERE email=$1', [email])).rows).toEqual([]);
    expect((await pool.query('SELECT count(*)::int AS count FROM inventory_owner')).rows[0].count).toBe(1);
  } finally { await pool.query('DROP TRIGGER fail_signup_leaf ON location'); await pool.query('DROP FUNCTION fail_signup_leaf()'); }
});
it('refuses to start public signup without audited readiness or with fake production delivery', async () => {
  for (const settings of [{ SIGNUP_MODE: 'public', SIGNUP_READINESS_FILE: '' }, { SIGNUP_MODE: 'local-public', NODE_ENV: 'production' }]) {
    const rejected = spawn('node', ['--import', 'tsx', 'auth/src/server.ts'], { env: { ...process.env, OWNER_EMAIL: 'owner@example.test', AUTH_PORT: '3199', ...settings }, stdio: 'ignore' });
    expect(await new Promise(resolve => rejected.once('exit', resolve))).toBe(1);
  }
});
it('keeps code-request responses uniform when configured delivery fails', async () => {
  const connection = new URL(process.env.DATABASE_URL!); connection.pathname = '/' + database;
  const failing = spawn('node', ['--import','tsx','auth/src/server.ts'], {
    env: { ...process.env, DATABASE_URL: connection.toString(), AUTH_PORT: '3199', MAIL_MODE: 'file', MAIL_FILE: directory, SIGNUP_MODE: 'local-public', OWNER_EMAIL: 'owner@example.test', PUBLIC_ORIGIN: origin }, stdio: 'ignore',
  });
  try {
    for (let n=0;n<50;n++) {
      try { if ((await fetch('http://127.0.0.1:3199/auth/session')).ok) break; } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve,100));
    }
    const email = 'delivery-failure@example.test';
    const response = await fetch('http://127.0.0.1:3199/auth/request-code', { method: 'POST', headers: { origin,'content-type':'application/json' },body:JSON.stringify({email}) });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ message: 'If this account can sign in, a code has been sent.' });
    expect((await pool.query('SELECT id FROM "user" WHERE email=$1',[email])).rows).toEqual([]);
  } finally {
    if (failing.exitCode === null) { failing.kill(); await new Promise(resolve => failing.once('exit',resolve)); }
  }
});
