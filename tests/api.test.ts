import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createApi } from '../src/lib/api.ts';
import { createStore } from '../src/lib/db.ts';
import { deferred, gateway, product, pubs } from './helpers.ts';

const token = 'FAKE-SESSION-KEY-NEVER-PERSIST';
async function setup(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'channel-sync-test-'));
  const filename = path.join(dir, 'sync.db');
  const store = createStore(filename);
  const remote = gateway();
  let time = 0;
  const runtime = createApi({ store, origins: ['http://localhost'], factory: () => remote.client, leaseMs: 100, now: () => time, verificationDelay: 0 });
  t.after(async () => { await runtime.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const get = (url: string, cookie = '') => request(runtime.app).get(url).set('Host', 'localhost').set('Cookie', cookie);
  const post = (url: string, body = {}, cookie = '') => request(runtime.app).post(url).set('Host', 'localhost').set('Cookie', cookie).send(body);
  const login = await post('/api/session', { shop_domain: 'example.myshopify.com', access_token: token }).expect(200);
  const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
  return { ...runtime, ...remote, store, get, post, cookie, login, dir, filename, advance: (ms: number) => { time += ms; } };
}

test('session cookie contains only a random ID; API and SQLite never return or persist the key', async t => {
  const f = await setup(t);
  const header = String(f.login.headers['set-cookie'][0]);
  assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Strict/);
  assert.doesNotMatch(header, /Max-Age|Expires|FAKE-SESSION/);
  const status = await f.get('/api/status', f.cookie).expect(200);
  assert.doesNotMatch(JSON.stringify(status.body), /access_token|FAKE-SESSION/);
  await f.get('/api/status').expect(401);
  for (const name of readdirSync(f.dir)) {
    assert.equal(readFileSync(path.join(f.dir, name)).includes(Buffer.from(token)), false, `${name} contains a credential`);
  }
  const inspection = new Database(f.filename, { readonly: true });
  const columns = inspection.prepare('PRAGMA table_info(settings)').all() as { name: string }[];
  assert.equal(columns.some(c => c.name === 'access_token'), false);
  inspection.close();
  await f.post('/api/session/end', {}, f.cookie).expect(200);
  assert.equal(f.sessions.credentials(), null);
  await f.get('/api/status', f.cookie).expect(401);
  await f.post('/api/fix/start', {}, f.cookie).expect(401);
});

test('session expiration clears the key and blocks every protected operation', async t => {
  const f = await setup(t);
  f.advance(101); await f.sessions.sweep();
  assert.equal(f.sessions.credentials(), null);
  await f.get('/api/status', f.cookie).expect(401);
  await f.post('/api/scan/start', {}, f.cookie).expect(401);
});

test('logout cancels an active scan and discards its late response', async t => {
  const f = await setup(t);
  await f.post('/api/publications/select', { ids: pubs.map(p => p.id) }, f.cookie).expect(200);
  const started = deferred<void>();
  const response = deferred<{ products: ReturnType<typeof product>[]; nextCursor: null }>();
  f.client.getProductsBatch = async () => { started.resolve(); return response.promise; };
  await f.post('/api/scan/start', {}, f.cookie).expect(202); await started.promise;
  const id = f.cookie.slice(f.cookie.indexOf('=') + 1);
  const end = f.sessions.end(id);
  assert.equal(f.sessions.credentials(), null);
  await f.get('/api/status', f.cookie).expect(401);
  response.resolve({ products: [product('1')], nextCursor: null });
  await end;
  assert.equal(f.store.getAnalytics().total, 0);
  assert.equal(f.store.getJob().scan_status, 'idle');
});

test('cross-origin, foreign Host and non-JSON mutation requests are rejected', async t => {
  const f = await setup(t);
  await request(f.app).post('/api/reset').set('Host', 'localhost').set('Cookie', f.cookie).set('Origin', 'https://evil.example').send({}).expect(403);
  await request(f.app).get('/api/status').set('Host', 'evil.example').set('Cookie', f.cookie).expect(403);
  await request(f.app).post('/api/reset').set('Host', 'localhost').set('Cookie', f.cookie).type('form').send({}).expect(415);
  await f.get('/api/status?page=-1', f.cookie).expect(400);
});

test('migration removes a legacy plaintext token, including SQLite free pages and WAL', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'channel-sync-legacy-'));
  try {
    const filename = path.join(dir, 'legacy.db');
    const old = new Database(filename);
    old.exec('CREATE TABLE settings(id INTEGER PRIMARY KEY, shop_domain TEXT, access_token TEXT); CREATE TABLE jobs(id INTEGER PRIMARY KEY); CREATE TABLE products(id TEXT PRIMARY KEY); CREATE TABLE publications(id TEXT PRIMARY KEY);');
    old.prepare('INSERT INTO settings VALUES (1, ?, ?)').run('example.myshopify.com', token);
    old.close();
    assert.ok(readFileSync(filename).includes(Buffer.from(token)));
    const migrated = createStore(filename);
    assert.deepEqual(migrated.getSettings(), { shop_domain: 'example.myshopify.com' });
    migrated.close();
    for (const file of readdirSync(dir)) assert.equal(readFileSync(path.join(dir, file)).includes(Buffer.from(token)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
