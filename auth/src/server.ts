import { createHash, createHmac, randomInt } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { auth, deliverCode, pool } from './auth.js';

const origin = process.env.PUBLIC_ORIGIN || 'http://localhost:5173';
const ownerEmail = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
const apiOrigin = process.env.API_ORIGIN || 'http://127.0.0.1:8000';
const internalSecret = process.env.INTERNAL_AUTH_SECRET || '';
if (!ownerEmail || !internalSecret || !process.env.BETTER_AUTH_SECRET || !process.env.DATABASE_URL) {
  throw new Error('OWNER_EMAIL, INTERNAL_AUTH_SECRET, BETTER_AUTH_SECRET, DATABASE_URL are required');
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 16_384) throw new Error('Payload too large');
  }
  return body;
}

function sameOrigin(request: IncomingMessage) {
  return request.headers.origin === origin;
}

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function trustedClientIp(request: IncomingMessage) {
  const peer = request.socket.remoteAddress || 'unknown';
  const trusted = (process.env.TRUSTED_PROXY_IPS || '').split(',').map(value => value.trim());
  const forwarded = request.headers['x-real-ip'];
  if (trusted.includes(peer) && typeof forwarded === 'string' && isIP(forwarded)) return forwarded;
  return peer;
}

async function allowedSend(email: string, ip: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A global transactional lock serializes checks even across gateway replicas.
    await client.query('SELECT pg_advisory_xact_lock(914701)');
    const emailKey = hash(email);
    const ipKey = hash(ip);
    const result = await client.query<{
      minute: string; day: string; hour_ip: string; global_day: string;
    }>(`SELECT
      (SELECT count(*) FROM auth_send_event WHERE email_key=$1 AND sent_at > now()-interval '60 seconds') AS minute,
      (SELECT count(*) FROM auth_send_event WHERE email_key=$1 AND sent_at > now()-interval '1 day') AS day,
      (SELECT count(*) FROM auth_send_event WHERE ip_key=$2 AND sent_at > now()-interval '1 hour') AS hour_ip,
      (SELECT count(*) FROM auth_send_event WHERE sent_at > now()-interval '1 day') AS global_day`, [emailKey, ipKey]);
    const counts = result.rows[0];
    const cap = Number(process.env.DAILY_SEND_CAP || 100);
    const permitted = Number(counts.minute) < 1 && Number(counts.day) < 5 &&
      Number(counts.hour_ip) < 20 && Number(counts.global_day) < cap;
    if (permitted) await client.query('INSERT INTO auth_send_event(email_key,ip_key) VALUES($1,$2)', [emailKey, ipKey]);
    await client.query('COMMIT');
    return permitted;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function betterRequest(request: IncomingMessage, path: string, body?: string) {
  const headers = new Headers();
  if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
  if (request.headers.origin) headers.set('origin', request.headers.origin);
  headers.set('content-type', 'application/json');
  return new Request(`${origin}${path}`, { method: request.method, headers, body });
}

async function relay(response: ServerResponse, result: Response) {
  const headers: Record<string, string | string[]> = {
    'content-type': result.headers.get('content-type') || 'application/json',
    'cache-control': 'no-store',
  };
  const cookies = result.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  response.writeHead(result.status, headers);
  response.end(await result.text());
}

async function session(request: IncomingMessage) {
  return auth.api.getSession({ headers: new Headers({ cookie: request.headers.cookie || '' }) });
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url || '/', origin).pathname;
  try {
    if (path === '/auth/request-code' && request.method === 'POST') {
      if (!sameOrigin(request)) return json(response, 403, { error: 'Origin required' });
      const started = Date.now();
      const body = JSON.parse(await readBody(request));
      const email = normalizedEmail(body.email);
      if (email && email === ownerEmail) {
        try {
          const ip = trustedClientIp(request);
          if (await allowedSend(email, ip)) {
            await auth.handler(betterRequest(request, '/api/auth/email-otp/send-verification-otp', JSON.stringify({ email, type: 'sign-in' })));
          }
        } catch {
          console.error('Code delivery unavailable');
        }
      }
      await new Promise(resolve => setTimeout(resolve, Math.max(0, 400 - (Date.now() - started))));
      return json(response, 202, { message: 'If this account can sign in, a code has been sent.' });
    }
    if (path === '/auth/verify-code' && request.method === 'POST') {
      if (!sameOrigin(request)) return json(response, 403, { error: 'Origin required' });
      const body = JSON.parse(await readBody(request));
      const email = normalizedEmail(body.email);
      if (!email || email !== ownerEmail || !/^\d{6}$/.test(body.code)) {
        return json(response, 401, { error: 'Invalid or expired code. Request a new code.' });
      }
      const result = await auth.handler(betterRequest(request, '/api/auth/sign-in/email-otp', JSON.stringify({ email, otp: body.code })));
      if (!result.ok) return json(response, 401, { error: 'Invalid or expired code. Request a new code.' });
      const verified = await result.clone().json() as { user?: { id?: string } };
      if (!verified.user?.id) return json(response, 503, { error: 'Service temporarily unavailable' });
      const stamp = Math.floor(Date.now() / 1000).toString();
      const signature = createHmac('sha256', internalSecret)
        .update(`GET\n/api/locations\n${hash('')}\n${verified.user.id}\n${stamp}`).digest('hex');
      const onboarding = await fetch(`${apiOrigin}/api/locations`, { headers: {
        'x-internal-user': verified.user.id,
        'x-internal-time': stamp,
        'x-internal-signature': signature,
      } });
      if (!onboarding.ok) return json(response, 503, { error: 'Service temporarily unavailable' });
      const cookies = result.headers.getSetCookie();
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': cookies });
      response.end(JSON.stringify({ signedIn: true }));
      return;
    }
    if (path === '/auth/session' && request.method === 'GET') {
      const current = await session(request);
      return json(response, 200, { signedIn: !!current, userId: current?.user.id || null });
    }
    if (path === '/auth/approval-code' && request.method === 'POST') {
      if (!sameOrigin(request)) return json(response, 403, { error: 'Origin required' });
      const current = await session(request);
      if (!current) return json(response, 401, { error: 'Authentication required' });
      const body = JSON.parse(await readBody(request)) as { reportId?: unknown; action?: unknown };
      const reportId = typeof body.reportId === 'string' ? body.reportId.toLowerCase() : body.reportId;
      const action = body.action;
      if (typeof reportId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reportId) ||
        (action !== 'approve_printing' && action !== 'approve_edition')) return json(response, 422, { error: 'Invalid approval request' });
      const owner = await pool.query<{ email: string }>(`SELECT u.email FROM owner_binding b
        JOIN "user" u ON u.id=b.user_id WHERE b.singleton AND b.user_id=$1`, [current.user.id]);
      if (!owner.rows[0]) return json(response, 403, { error: 'Owner access required' });
      const report = await pool.query<{ kind: string }>(`SELECT kind FROM missing_card_report
        WHERE id=$1 AND status IN ('pending','needs_info')`, [reportId]);
      if (!report.rows[0] || action !== `approve_${report.rows[0].kind}`) return json(response, 404, { error: 'Report not found' });
      const email = owner.rows[0].email;
      if (!await allowedSend(email, trustedClientIp(request))) return json(response, 429, { error: 'Code rate limit reached. Try later.' });
      const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
      const codeHash = createHmac('sha256', internalSecret).update(`${current.user.id}:${reportId}:${action}:${code}`).digest('hex');
      await deliverCode(email, code, 'catalog approval');
      await pool.query(`INSERT INTO catalog_approval_code(owner_id,report_id,action,code_hash,expires_at)
        VALUES ($1,$2,$3,$4,now()+interval '5 minutes')`, [current.user.id, reportId, action, codeHash]);
      return json(response, 202, { message: 'Approval code sent.' });
    }
    if (path === '/auth/sign-out' && request.method === 'POST') {
      if (!sameOrigin(request)) return json(response, 403, { error: 'Origin required' });
      const result = await auth.handler(betterRequest(request, '/api/auth/sign-out', '{}'));
      return relay(response, result);
    }
    if (path.startsWith('/api/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD' && !sameOrigin(request)) return json(response, 403, { error: 'Origin required' });
      const current = await session(request);
      if (!current && path !== '/api/health') return json(response, 401, { error: 'Authentication required' });
      const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await readBody(request);
      const stamp = Math.floor(Date.now() / 1000).toString();
      const bodyHash = hash(body);
      const signature = current ? createHmac('sha256', internalSecret).update(`${request.method}\n${path}\n${bodyHash}\n${current.user.id}\n${stamp}`).digest('hex') : '';
      const headers: Record<string, string> = {};
      if (current) {
        headers['x-internal-user'] = current.user.id;
        headers['x-internal-time'] = stamp;
        headers['x-internal-signature'] = signature;
      }
      if (body) headers['content-type'] = request.headers['content-type'] || 'application/json';
      const upstream = await fetch(`${apiOrigin}${request.url}`, { method: request.method, headers, body: body || undefined });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
      response.end(await upstream.text());
      return;
    }
    json(response, 404, { error: 'Not found' });
  } catch (error) {
    console.error('Gateway request failed', error instanceof Error ? error.name : 'unknown');
    json(response, 503, { error: 'Service temporarily unavailable' });
  }
});

server.listen(Number(process.env.AUTH_PORT || 3001), process.env.AUTH_HOST || '127.0.0.1');
